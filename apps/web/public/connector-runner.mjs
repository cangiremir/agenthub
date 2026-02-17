import { spawn, spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import os from "node:os";
import path from "node:path";
import { dirname, extname, join } from "node:path";
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
const env = { ...process.env, ...readEnv() };
const baseUrl = pick(env.SUPABASE_URL, "http://127.0.0.1:55321");
const agentToken = pick(env.CONNECTOR_AGENT_TOKEN, "");
const agentName = pick(env.CONNECTOR_AGENT_NAME, "Remote Connector");
const deviceOs = pick(env.CONNECTOR_DEVICE_OS, process.platform);
const HEARTBEAT_INTERVAL_MS = 5_000;
const HEARTBEAT_TIMEOUT_MS = 4_000;
const HEARTBEAT_RETRY_DELAY_MS = 2_500;
const HEARTBEAT_MAX_RETRIES = 2;
const FATAL_AUTH_EXIT_CODE = 42;
const SESSION_ACTIVE_WINDOW_MS = 30 * 60 * 1000;
const MAX_SESSION_FILES = 8;
const MAX_SESSION_MESSAGES = 10;
const MAX_SESSION_JSONL_CHARS = 240_000;

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
const MAX_SESSION_SNIPPET_CHARS = 1200;
const MAX_SCAN_DEPTH = 4;
const ALLOWED_SESSION_EXTENSIONS = new Set([".json", ".jsonl", ".md", ".log", ".txt"]);

const detectAiRuntimes = () => {
  const rows = [];

  if (process.platform === "win32") {
    const script = [
      "$ErrorActionPreference='SilentlyContinue'",
      "$items = Get-CimInstance Win32_Process | Where-Object { (($_.Name + ' ' + $_.CommandLine) -match '(?i)codex|claude') } | Select-Object ProcessId,Name,CommandLine",
      "if ($null -eq $items) { '[]' } else { $items | ConvertTo-Json -Compress }"
    ].join(";");
    const out = spawnSync("powershell", ["-NoProfile", "-Command", script], { encoding: "utf8", timeout: 8000 });
    if (out.status === 0 && out.stdout) {
      try {
        const parsed = JSON.parse(out.stdout);
        const list = Array.isArray(parsed) ? parsed : [parsed];
        for (const p of list) {
          rows.push({
            pid: typeof p.ProcessId === "number" ? p.ProcessId : null,
            name: p.Name || "",
            cmd: p.CommandLine || ""
          });
        }
      } catch (_error) {
        // ignore
      }
    }
  } else {
    const out = spawnSync("ps", ["-eo", "pid=,comm=,args="], { encoding: "utf8", timeout: 5000 });
    if (out.status === 0 && out.stdout) {
      for (const line of out.stdout.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        const parts = trimmed.split(/\s+/, 3);
        const pid = Number(parts[0]);
        rows.push({
          pid: Number.isFinite(pid) ? pid : null,
          name: parts[1] || "",
          cmd: parts[2] || ""
        });
      }
    }
  }

  const runtimes = [];
  for (const row of rows) {
    const text = `${row.name} ${row.cmd}`.toLowerCase();
    if (text.includes("get-ciminstance win32_process") || text.includes("convertto-json -compress")) {
      continue;
    }
    if (text.includes("codex")) {
      runtimes.push({ kind: "codex", process_name: row.name, command: row.cmd, pid: row.pid });
    }
    if (text.includes("claude")) {
      runtimes.push({ kind: "claude", process_name: row.name, command: row.cmd, pid: row.pid });
    }
  }

  const fromSessions = detectCodexSessionAgents();
  const merged = [...runtimes, ...fromSessions];
  const deduped = [];
  const seen = new Set();
  for (const item of merged) {
    const key = `${item.kind}|${item.process_name}|${item.command}|${item.pid ?? "na"}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(item);
  }
  return deduped.slice(0, 20);
};

const detectCodexSessionAgents = () => {
  const sessionsDir = path.join(os.homedir(), ".codex", "sessions");
  if (!existsSync(sessionsDir)) return [];
  const now = Date.now();
  const stack = [{ dir: sessionsDir, depth: 0 }];
  const found = [];
  while (stack.length > 0 && found.length < 1000) {
    const current = stack.pop();
    if (!current) break;
    let entries = [];
    try {
      entries = readdirSync(current.dir, { withFileTypes: true });
    } catch (_error) {
      continue;
    }
    for (const entry of entries) {
      const fullPath = path.join(current.dir, entry.name);
      if (entry.isDirectory()) {
        if (current.depth < MAX_SCAN_DEPTH) {
          stack.push({ dir: fullPath, depth: current.depth + 1 });
        }
        continue;
      }
      let mtimeMs = 0;
      try {
        mtimeMs = statSync(fullPath).mtimeMs;
      } catch (_error) {
        continue;
      }
      if (now - mtimeMs > SESSION_ACTIVE_WINDOW_MS) continue;
      const rel = path.relative(sessionsDir, fullPath);
      found.push({
        kind: "codex",
        process_name: "codex-session",
        command: `session:${rel.replace(/\\/g, "/")}`,
        pid: null
      });
    }
  }
  return found;
};

const parseSessionDirs = () => {
  const configured = (env.CONNECTOR_AI_SESSION_DIRS || "").trim();
  if (configured) {
    return configured
      .split(path.delimiter)
      .map((entry) => entry.trim())
      .filter(Boolean);
  }
  const home = os.homedir();
  return [path.join(home, ".codex", "sessions"), path.join(home, ".codex"), path.join(home, ".claude")];
};

const compactText = (text, maxLen = 320) => {
  if (!text) return "";
  return `${text}`.replace(/\s+/g, " ").trim().slice(0, maxLen);
};

const findRecentSessionFiles = (rootDir, extensions = ALLOWED_SESSION_EXTENSIONS) => {
  if (!existsSync(rootDir)) return [];
  const stack = [{ dir: rootDir, depth: 0 }];
  const files = [];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) break;
    let entries = [];
    try {
      entries = readdirSync(current.dir, { withFileTypes: true });
    } catch (_error) {
      continue;
    }
    for (const entry of entries) {
      const fullPath = path.join(current.dir, entry.name);
      if (entry.isDirectory()) {
        if (current.depth < MAX_SCAN_DEPTH) {
          stack.push({ dir: fullPath, depth: current.depth + 1 });
        }
        continue;
      }
      const ext = extname(entry.name).toLowerCase();
      if (!extensions.has(ext)) continue;
      let mtimeMs = 0;
      try {
        mtimeMs = statSync(fullPath).mtimeMs;
      } catch (_error) {
        continue;
      }
      files.push({ filePath: fullPath, mtimeMs });
    }
  }
  return files
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .slice(0, MAX_SESSION_FILES);
};

const findLatestSessionFile = (rootDir) => {
  const files = findRecentSessionFiles(rootDir);
  return files[0] ?? null;
};

const readSnippet = (filePath) => {
  try {
    const content = readFileSync(filePath, "utf8");
    return content.slice(-MAX_SESSION_SNIPPET_CHARS);
  } catch (_error) {
    return "";
  }
};

const parseCodexJsonlSession = (filePath, mtimeMs) => {
  try {
    const raw = readFileSync(filePath, "utf8");
    const chunk = raw.length > MAX_SESSION_JSONL_CHARS ? raw.slice(-MAX_SESSION_JSONL_CHARS) : raw;
    const records = [];
    for (const line of chunk.split(/\r?\n/).map((entry) => entry.trim()).filter(Boolean)) {
      try {
        records.push(JSON.parse(line));
      } catch (_error) {
        // ignore
      }
    }
    if (records.length === 0) {
      let depth = 0;
      let current = "";
      let inString = false;
      let escape = false;
      for (const ch of chunk) {
        current += ch;
        if (inString) {
          if (escape) {
            escape = false;
          } else if (ch === "\\") {
            escape = true;
          } else if (ch === "\"") {
            inString = false;
          }
          continue;
        }
        if (ch === "\"") {
          inString = true;
        } else if (ch === "{") {
          depth += 1;
        } else if (ch === "}") {
          depth = Math.max(0, depth - 1);
          if (depth === 0) {
            const candidate = current.trim();
            current = "";
            if (!candidate) continue;
            try {
              records.push(JSON.parse(candidate));
            } catch (_error) {
              // ignore
            }
          }
        }
      }
    }
    const messages = [];
    let flowId = "";

    for (const record of records) {
      const payload = record?.payload;
      if (!payload || typeof payload !== "object") continue;

      if (record.type === "event_msg") {
        if (payload.type === "user_message" && typeof payload.message === "string") {
          messages.push({ role: "User", text: payload.message });
        } else if (payload.type === "agent_message" && typeof payload.message === "string") {
          messages.push({ role: "Assistant", text: payload.message });
        } else if (payload.type === "task_complete" && typeof payload.turn_id === "string") {
          flowId = payload.turn_id;
        }
      }
    }

    const snippet = messages
      .slice(-MAX_SESSION_MESSAGES)
      .map((entry) => `${entry.role}: ${compactText(entry.text)}`)
      .join("\n");
    if (!snippet) return null;

    const sessionId = path.basename(filePath, ".jsonl");
    return {
      kind: "codex",
      source: filePath,
      session_id: sessionId,
      flow_id: flowId || undefined,
      updated_at: new Date(mtimeMs).toISOString(),
      snippet
    };
  } catch (_error) {
    return null;
  }
};

const collectSessionContexts = () => {
  const dirs = parseSessionDirs();
  const sessions = [];
  for (const dir of dirs) {
    const kind = dir.toLowerCase().includes("claude") ? "claude" : dir.toLowerCase().includes("codex") ? "codex" : "unknown";
    const isCodexSessionsDir = kind === "codex" && dir.toLowerCase().includes(`${path.sep}.codex${path.sep}sessions`);
    if (isCodexSessionsDir) {
      const jsonlFiles = findRecentSessionFiles(dir, new Set([".jsonl"]));
      for (const file of jsonlFiles) {
        const parsed = parseCodexJsonlSession(file.filePath, file.mtimeMs);
        if (parsed) sessions.push(parsed);
      }
      continue;
    }
    const latest = findLatestSessionFile(dir);
    if (!latest) continue;
    const snippet = readSnippet(latest.filePath).trim();
    if (!snippet) continue;
    sessions.push({
      kind,
      source: latest.filePath,
      session_id: path.basename(latest.filePath, path.extname(latest.filePath)),
      updated_at: new Date(latest.mtimeMs).toISOString(),
      snippet
    });
  }
  return sessions
    .sort((a, b) => new Date(b.updated_at || 0).getTime() - new Date(a.updated_at || 0).getTime())
    .slice(0, 12);
};

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
      await callFn(
        "connector-heartbeat",
        {
          name: agentName,
          device_os: deviceOs,
          ai_context: {
            detected_at: new Date().toISOString(),
            runtimes: detectAiRuntimes(),
            sessions: collectSessionContexts()
          }
        },
        HEARTBEAT_TIMEOUT_MS
      );
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
