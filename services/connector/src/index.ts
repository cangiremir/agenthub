import { spawn } from "node:child_process";
import { spawnSync } from "node:child_process";
import { config as loadEnv } from "dotenv";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { extname, resolve } from "node:path";
import { isCommandAllowed, policyRejectReason, type AgentPolicy } from "./policy.js";

loadEnv({ path: process.env.DOTENV_CONFIG_PATH ?? resolve(process.cwd(), ".env.local") });
loadEnv({ path: resolve(process.cwd(), "../../.env.local") });
loadEnv({ override: true, path: resolve(process.cwd(), ".env") });

const baseUrl = process.env.SUPABASE_URL ?? "http://127.0.0.1:55321";
const agentToken = process.env.CONNECTOR_AGENT_TOKEN ?? "";
const agentName = process.env.CONNECTOR_AGENT_NAME ?? "Local Connector";
const deviceOs = process.env.CONNECTOR_DEVICE_OS ?? process.platform;
const HEARTBEAT_INTERVAL_MS = 5_000;
const HEARTBEAT_TIMEOUT_MS = 4_000;
const HEARTBEAT_RETRY_DELAY_MS = 2_500;
const HEARTBEAT_MAX_RETRIES = 2;
const FATAL_AUTH_EXIT_CODE = 42;
const SESSION_ACTIVE_WINDOW_MS = 30 * 60 * 1000;
const MAX_SCAN_DEPTH = 4;
const MAX_SESSION_SNIPPET_CHARS = 1200;
const MAX_SESSION_FILES = 8;
const MAX_SESSION_MESSAGES = 10;
const MAX_SESSION_JSONL_CHARS = 240_000;
const ALLOWED_SESSION_EXTENSIONS = new Set([".json", ".jsonl", ".md", ".log", ".txt"]);

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

type RuntimeInfo = {
  kind: "codex" | "claude";
  process_name: string;
  command: string;
  pid: number | null;
};

type SessionContext = {
  kind: "codex" | "claude" | "unknown";
  source: string;
  session_id?: string;
  flow_id?: string;
  updated_at: string;
  snippet: string;
};

const detectAiRuntimes = (): RuntimeInfo[] => {
  const rows: Array<{ pid: number | null; name: string; cmd: string }> = [];

  if (process.platform === "win32") {
    const script = [
      "$ErrorActionPreference='SilentlyContinue'",
      "$items = Get-CimInstance Win32_Process | Where-Object { (($_.Name + ' ' + $_.CommandLine) -match '(?i)codex|claude') } | Select-Object ProcessId,Name,CommandLine",
      "if ($null -eq $items) { '[]' } else { $items | ConvertTo-Json -Compress }"
    ].join(";");
    const out = spawnSync("powershell", ["-NoProfile", "-Command", script], { encoding: "utf8", timeout: 8000 });
    if (out.status === 0 && out.stdout) {
      try {
        const parsed = JSON.parse(out.stdout) as
          | { ProcessId?: number; Name?: string; CommandLine?: string }
          | Array<{ ProcessId?: number; Name?: string; CommandLine?: string }>;
        const list = Array.isArray(parsed) ? parsed : [parsed];
        for (const p of list) {
          rows.push({
            pid: typeof p.ProcessId === "number" ? p.ProcessId : null,
            name: p.Name ?? "",
            cmd: p.CommandLine ?? ""
          });
        }
      } catch {
        // ignore parse errors
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
        const name = parts[1] ?? "";
        const cmd = parts[2] ?? "";
        rows.push({ pid: Number.isFinite(pid) ? pid : null, name, cmd });
      }
    }
  }

  const results: RuntimeInfo[] = [];
  for (const row of rows) {
    const text = `${row.name} ${row.cmd}`.toLowerCase();
    if (text.includes("get-ciminstance win32_process") || text.includes("convertto-json -compress")) {
      continue;
    }
    if (text.includes("codex")) {
      results.push({ kind: "codex", process_name: row.name, command: row.cmd, pid: row.pid });
    }
    if (text.includes("claude")) {
      results.push({ kind: "claude", process_name: row.name, command: row.cmd, pid: row.pid });
    }
  }

  const fromSessions = detectCodexSessionAgents();
  const merged = [...results, ...fromSessions];
  const deduped: RuntimeInfo[] = [];
  const seen = new Set<string>();
  for (const item of merged) {
    const key = `${item.kind}|${item.process_name}|${item.command}|${item.pid ?? "na"}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(item);
  }
  return deduped.slice(0, 20);
};

const detectCodexSessionAgents = (): RuntimeInfo[] => {
  const sessionsDir = path.join(os.homedir(), ".codex", "sessions");
  if (!existsSync(sessionsDir)) return [];
  const now = Date.now();
  const stack: Array<{ dir: string; depth: number }> = [{ dir: sessionsDir, depth: 0 }];
  const found: RuntimeInfo[] = [];
  while (stack.length > 0 && found.length < 1000) {
    const current = stack.pop();
    if (!current) break;
    let entries: Array<{ isDirectory: () => boolean; name: string }> = [];
    try {
      entries = readdirSync(current.dir, { withFileTypes: true }) as Array<{ isDirectory: () => boolean; name: string }>;
    } catch {
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
      } catch {
        continue;
      }
      if (now - mtimeMs > SESSION_ACTIVE_WINDOW_MS) continue;
      const rel = path.relative(sessionsDir, fullPath).replace(/\\/g, "/");
      found.push({
        kind: "codex",
        process_name: "codex-session",
        command: `session:${rel}`,
        pid: null
      });
    }
  }
  return found;
};

const parseSessionDirs = () => {
  const configured = (process.env.CONNECTOR_AI_SESSION_DIRS ?? "").trim();
  if (configured) {
    return configured
      .split(path.delimiter)
      .map((entry) => entry.trim())
      .filter(Boolean);
  }
  const home = os.homedir();
  return [path.join(home, ".codex", "sessions"), path.join(home, ".codex"), path.join(home, ".claude")];
};

const compactText = (text: string, maxLen = 320) => {
  return `${text || ""}`.replace(/\s+/g, " ").trim().slice(0, maxLen);
};

const findRecentSessionFiles = (rootDir: string, extensions: Set<string> = ALLOWED_SESSION_EXTENSIONS) => {
  if (!existsSync(rootDir)) return [] as Array<{ filePath: string; mtimeMs: number }>;
  const stack: Array<{ dir: string; depth: number }> = [{ dir: rootDir, depth: 0 }];
  const files: Array<{ filePath: string; mtimeMs: number }> = [];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) break;
    let entries: Array<{ isDirectory: () => boolean; name: string }> = [];
    try {
      entries = readdirSync(current.dir, { withFileTypes: true }) as Array<{ isDirectory: () => boolean; name: string }>;
    } catch {
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
      } catch {
        continue;
      }
      files.push({ filePath: fullPath, mtimeMs });
    }
  }
  return files
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .slice(0, MAX_SESSION_FILES);
};

const findLatestSessionFile = (rootDir: string) => {
  const files = findRecentSessionFiles(rootDir);
  return files[0] ?? null;
};

const readSnippet = (filePath: string) => {
  try {
    const content = readFileSync(filePath, "utf8");
    return content.slice(-MAX_SESSION_SNIPPET_CHARS);
  } catch {
    return "";
  }
};

const parseCodexJsonlSession = (filePath: string, mtimeMs: number): SessionContext | null => {
  try {
    const raw = readFileSync(filePath, "utf8");
    const chunk = raw.length > MAX_SESSION_JSONL_CHARS ? raw.slice(-MAX_SESSION_JSONL_CHARS) : raw;
    const records: Array<{ type?: string; payload?: Record<string, unknown>; timestamp?: string }> = [];
    for (const line of chunk.split(/\r?\n/).map((entry) => entry.trim()).filter(Boolean)) {
      try {
        records.push(JSON.parse(line) as { type?: string; payload?: Record<string, unknown>; timestamp?: string });
      } catch {
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
              records.push(JSON.parse(candidate) as { type?: string; payload?: Record<string, unknown>; timestamp?: string });
            } catch {
              // ignore
            }
          }
        }
      }
    }
    const messages: Array<{ role: "User" | "Assistant"; text: string }> = [];
    let flowId = "";

    for (const record of records) {
      const payload = record?.payload;
      if (!payload || typeof payload !== "object") continue;
      if (record?.type === "event_msg") {
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

    return {
      kind: "codex",
      source: filePath,
      session_id: path.basename(filePath, ".jsonl"),
      flow_id: flowId || undefined,
      updated_at: new Date(mtimeMs).toISOString(),
      snippet
    };
  } catch {
    return null;
  }
};

const collectSessionContexts = (): SessionContext[] => {
  const dirs = parseSessionDirs();
  const sessions: SessionContext[] = [];
  for (const dir of dirs) {
    const lower = dir.toLowerCase();
    const kind: SessionContext["kind"] = lower.includes("claude") ? "claude" : lower.includes("codex") ? "codex" : "unknown";
    const isCodexSessionsDir = kind === "codex" && lower.includes(`${path.sep}.codex${path.sep}sessions`);
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
      session_id: path.basename(latest.filePath, extname(latest.filePath)),
      updated_at: new Date(latest.mtimeMs).toISOString(),
      snippet
    });
  }

  return sessions
    .sort((a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime())
    .slice(0, 12);
};

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
