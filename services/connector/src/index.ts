import { spawn } from "node:child_process";
import { config as loadEnv } from "dotenv";
import { resolve } from "node:path";
import { isCommandAllowed, policyRejectReason, type AgentPolicy } from "./policy.js";

loadEnv({ path: process.env.DOTENV_CONFIG_PATH ?? resolve(process.cwd(), ".env.local") });
loadEnv({ path: resolve(process.cwd(), "../../.env.local") });

const baseUrl = process.env.SUPABASE_URL ?? "http://127.0.0.1:55321";
const agentToken = process.env.CONNECTOR_AGENT_TOKEN ?? "";
const agentName = process.env.CONNECTOR_AGENT_NAME ?? "Local Connector";
const deviceOs = process.env.CONNECTOR_DEVICE_OS ?? process.platform;
const HEARTBEAT_INTERVAL_MS = 10_000;
const HEARTBEAT_TIMEOUT_MS = 4_000;
const HEARTBEAT_RETRY_DELAY_MS = 2_500;
const HEARTBEAT_MAX_RETRIES = 2;
const FATAL_AUTH_EXIT_CODE = 42;

if (!agentToken) {
  console.error("CONNECTOR_AGENT_TOKEN is required");
}

const isFatalAuthError = (error: unknown) => {
  const message = `${(error as Error | undefined)?.message ?? ""}`.toLowerCase();
  return (
    message.includes("invalid token") ||
    message.includes("agent revoked") ||
    message.includes("missing agent token") ||
    message.includes("unauthorized")
  );
};

const exitForAuthError = (context: string, error: Error) => {
  console.error(`[auth] ${context}: ${error.message}`);
  console.error("[auth] Connector token is invalid or revoked. Re-run installer with a fresh pairing code.");
  process.exit(FATAL_AUTH_EXIT_CODE);
};

type PullResponse = {
  job: { id: string; command: string } | null;
  policy: AgentPolicy;
};

let seq = 0;
let busy = false;
let heartbeatTimer: NodeJS.Timeout | null = null;

const callFn = async <T>(name: string, body?: unknown, timeoutMs = 15_000): Promise<T> => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const response = await fetch(`${baseUrl}/functions/v1/${name}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${agentToken}`
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: controller.signal
  }).finally(() => {
    clearTimeout(timeout);
  });

  const json = (await response.json().catch(() => ({}))) as T & { error?: string };
  if (!response.ok) {
    const error = new Error((json as { error?: string }).error ?? `${name} failed`) as Error & {
      status?: number;
    };
    error.status = response.status;
    throw error;
  }
  return json;
};

const heartbeat = async () => {
  for (let attempt = 0; attempt <= HEARTBEAT_MAX_RETRIES; attempt += 1) {
    try {
      await callFn("connector-heartbeat", { name: agentName, device_os: deviceOs }, HEARTBEAT_TIMEOUT_MS);
      return true;
    } catch (error) {
      if (isFatalAuthError(error)) {
        exitForAuthError("heartbeat", error as Error);
      }
      if (attempt >= HEARTBEAT_MAX_RETRIES) {
        console.warn("heartbeat error:", (error as Error).message);
        return false;
      }
      await new Promise((resolve) => setTimeout(resolve, HEARTBEAT_RETRY_DELAY_MS));
    }
  }
  return false;
};

const scheduleHeartbeat = (delayMs: number) => {
  if (heartbeatTimer) clearTimeout(heartbeatTimer);
  heartbeatTimer = setTimeout(async () => {
    const ok = await heartbeat();
    scheduleHeartbeat(ok ? HEARTBEAT_INTERVAL_MS : HEARTBEAT_RETRY_DELAY_MS);
  }, delayMs);
};

const streamChunk = async (jobId: string, stream: "stdout" | "stderr" | "system", chunk: string) => {
  seq += 1;
  await callFn("connector-stream-event", {
    job_id: jobId,
    seq,
    stream,
    chunk
  });
};

const executeJob = async (jobId: string, command: string, policy: AgentPolicy) => {
  seq = 0;
  const rejected = policyRejectReason(policy, command);
  if (rejected) {
    await streamChunk(jobId, "system", `[policy] ${rejected}\n`);
    await callFn("connector-complete-job", {
      job_id: jobId,
      success: false,
      error_message: rejected,
      command,
      output: `[policy] ${rejected}\n`
    });
    return;
  }

  if (!isCommandAllowed(policy, command)) {
    await callFn("connector-complete-job", {
      job_id: jobId,
      success: false,
      error_message: "Command blocked by policy",
      command,
      output: ""
    });
    return;
  }

  const shell = process.platform === "win32" ? "powershell" : "bash";
  const args = process.platform === "win32" ? ["-NoProfile", "-Command", command] : ["-lc", command];

  await new Promise<void>((resolveRun) => {
    const child = spawn(shell, args, { stdio: ["ignore", "pipe", "pipe"] });
    let fullOutput = "";

    const flush = async (stream: "stdout" | "stderr", text: string) => {
      fullOutput += text;
      try {
        await streamChunk(jobId, stream, text);
      } catch (error) {
        console.warn("stream error:", (error as Error).message);
      }
    };

    child.stdout.on("data", (data) => {
      const text = data.toString();
      void flush("stdout", text);
    });

    child.stderr.on("data", (data) => {
      const text = data.toString();
      void flush("stderr", text);
    });

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
      } catch (error) {
        console.warn("complete error:", (error as Error).message);
      }
      resolveRun();
    });
  });
};

const poll = async () => {
  if (busy || !agentToken) return;
  busy = true;
  try {
    const payload = await callFn<PullResponse>("connector-pull-jobs");
    if (payload.job) {
      await executeJob(payload.job.id, payload.job.command, payload.policy);
    }
  } catch (error) {
    if (isFatalAuthError(error)) {
      exitForAuthError("poll", error as Error);
    }
    console.warn("poll error:", (error as Error).message);
  } finally {
    busy = false;
  }
};

const main = async () => {
  console.log("AgentHub connector started");
  const ok = await heartbeat();
  scheduleHeartbeat(ok ? HEARTBEAT_INTERVAL_MS : HEARTBEAT_RETRY_DELAY_MS);
  setInterval(() => {
    void poll();
  }, 2000);
};

void main();
