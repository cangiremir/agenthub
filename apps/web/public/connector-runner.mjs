import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const envPath = join(scriptDir, ".env");

const readEnv = () => {
  const values = {};
  if (!existsSync(envPath)) return values;
  for (const line of readFileSync(envPath, "utf8").split(/\r?\n/)) {
    if (!line || line.startsWith("#")) continue;
    const idx = line.indexOf("=");
    if (idx === -1) continue;
    values[line.slice(0, idx)] = line.slice(idx + 1);
  }
  return values;
};

const nodeMajor = Number((process.versions.node || "0").split(".")[0]);
if (!Number.isFinite(nodeMajor) || nodeMajor < 16) {
  console.error(`Node.js 16+ is required. Found ${process.versions.node}.`);
  process.exit(1);
}

const pick = (value, fallback) => (value === undefined || value === null ? fallback : value);
const env = { ...readEnv(), ...process.env };
const baseUrl = pick(env.SUPABASE_URL, "http://127.0.0.1:55321");
const agentToken = pick(env.CONNECTOR_AGENT_TOKEN, "");
const agentName = pick(env.CONNECTOR_AGENT_NAME, "Remote Connector");
const deviceOs = pick(env.CONNECTOR_DEVICE_OS, process.platform);
const HEARTBEAT_INTERVAL_MS = 10_000;
const HEARTBEAT_TIMEOUT_MS = 4_000;
const HEARTBEAT_RETRY_DELAY_MS = 2_500;
const HEARTBEAT_MAX_RETRIES = 2;
const FATAL_AUTH_EXIT_CODE = 42;

if (!agentToken) {
  console.error("CONNECTOR_AGENT_TOKEN missing in .env");
  process.exit(1);
}

const isFatalAuthError = (error) => {
  const message = `${error && error.message ? error.message : ""}`.toLowerCase();
  return (
    message.includes("invalid token") ||
    message.includes("agent revoked") ||
    message.includes("missing agent token") ||
    message.includes("unauthorized")
  );
};

const exitForAuthError = (context, error) => {
  console.error(`[auth] ${context}: ${error.message}`);
  console.error("[auth] Connector token is invalid or revoked. Re-run installer with a fresh pairing code.");
  process.exit(FATAL_AUTH_EXIT_CODE);
};

const SAFE = /^(echo|pwd|ls|dir|whoami|date)\b/i;
const DEV = /^(echo|pwd|ls|dir|cat|type|whoami|date|npm|node|pnpm|yarn|git|python|py|powershell|pwsh)\b/i;

const isAllowed = (policy, command) => {
  const cmd = command.trim();
  if (policy === "FULL") return true;
  if (policy === "DEV") return DEV.test(cmd);
  return SAFE.test(cmd);
};

const rejectReason = (policy, command) => {
  if (isAllowed(policy, command)) return null;
  if (policy === "SAFE") return "SAFE policy only allows baseline read-only commands.";
  if (policy === "DEV") return "DEV policy only allows developer tooling commands.";
  return null;
};

let seq = 0;
let busy = false;
let heartbeatTimer = null;

const callFn = async (name, body, timeoutMs = 15_000) => {
  const url = new URL(`${baseUrl}/functions/v1/${name}`);
  const client = url.protocol === "https:" ? https : http;
  const payload = body ? JSON.stringify(body) : "";
  const headers = {
    "content-type": "application/json",
    authorization: `Bearer ${agentToken}`,
    "content-length": Buffer.byteLength(payload)
  };

  return await new Promise((resolve, reject) => {
    const req = client.request(
      {
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port,
        path: `${url.pathname}${url.search}`,
        method: "POST",
        headers
      },
      (res) => {
        let raw = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => {
          raw += chunk;
        });
        res.on("end", () => {
          const status = res.statusCode || 0;
          let json = {};
          try {
            json = raw ? JSON.parse(raw) : {};
          } catch (_error) {
            json = {};
          }
          if (status < 200 || status >= 300) {
            const errorMessage = json && json.error ? json.error : `${name} failed`;
            const error = new Error(errorMessage);
            error.status = status;
            reject(error);
            return;
          }
          resolve(json);
        });
      }
    );

    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error("Request timeout"));
    });

    req.on("error", (error) => {
      reject(error);
    });

    if (payload) req.write(payload);
    req.end();
  });
};

const heartbeat = async () => {
  for (let attempt = 0; attempt <= HEARTBEAT_MAX_RETRIES; attempt += 1) {
    try {
      await callFn("connector-heartbeat", { name: agentName, device_os: deviceOs }, HEARTBEAT_TIMEOUT_MS);
      return true;
    } catch (err) {
      if (isFatalAuthError(err)) {
        exitForAuthError("heartbeat", err);
      }
      if (attempt >= HEARTBEAT_MAX_RETRIES) {
        console.warn("heartbeat error:", err.message);
        return false;
      }
      await new Promise((resolve) => setTimeout(resolve, HEARTBEAT_RETRY_DELAY_MS));
    }
  }
  return false;
};

const scheduleHeartbeat = (delayMs) => {
  if (heartbeatTimer) clearTimeout(heartbeatTimer);
  heartbeatTimer = setTimeout(async () => {
    const ok = await heartbeat();
    scheduleHeartbeat(ok ? HEARTBEAT_INTERVAL_MS : HEARTBEAT_RETRY_DELAY_MS);
  }, delayMs);
};

const streamChunk = async (jobId, stream, chunk) => {
  seq += 1;
  await callFn("connector-stream-event", { job_id: jobId, seq, stream, chunk });
};

const executeJob = async (jobId, command, policy) => {
  seq = 0;
  const reason = rejectReason(policy, command);
  if (reason) {
    await streamChunk(jobId, "system", `[policy] ${reason}\n`);
    await callFn("connector-complete-job", {
      job_id: jobId,
      success: false,
      error_message: reason,
      command,
      output: `[policy] ${reason}\n`
    });
    return;
  }

  const shell = process.platform === "win32" ? "powershell" : "bash";
  const args = process.platform === "win32" ? ["-NoProfile", "-Command", command] : ["-lc", command];

  await new Promise((resolve) => {
    const child = spawn(shell, args, { stdio: ["ignore", "pipe", "pipe"] });
    let fullOutput = "";

    const flush = async (stream, text) => {
      fullOutput += text;
      try {
        await streamChunk(jobId, stream, text);
      } catch (err) {
        console.warn("stream error:", err.message);
      }
    };

    child.stdout.on("data", (d) => void flush("stdout", d.toString()));
    child.stderr.on("data", (d) => void flush("stderr", d.toString()));

    child.on("close", async (code) => {
      try {
        await callFn("connector-complete-job", {
          job_id: jobId,
          success: code === 0,
          exit_code: code,
          output: fullOutput,
          command,
          error_message: code === 0 ? null : `Process exited with ${code}`
        });
      } catch (err) {
        console.warn("complete error:", err.message);
      }
      resolve();
    });
  });
};

const poll = async () => {
  if (busy) return;
  busy = true;
  try {
    const payload = await callFn("connector-pull-jobs");
    if (payload.job) {
      await executeJob(payload.job.id, payload.job.command, payload.policy);
    }
  } catch (err) {
    if (isFatalAuthError(err)) {
      exitForAuthError("poll", err);
    }
    console.warn("poll error:", err.message);
  } finally {
    busy = false;
  }
};

console.log("AgentHub connector runner started");
const ok = await heartbeat();
scheduleHeartbeat(ok ? HEARTBEAT_INTERVAL_MS : HEARTBEAT_RETRY_DELAY_MS);
setInterval(() => void poll(), 2000);
