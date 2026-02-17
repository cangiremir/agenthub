#!/usr/bin/env bash
set -euo pipefail

if [[ -t 1 ]]; then
  C_RESET=$'\033[0m'
  C_TITLE=$'\033[1;36m'
  C_STEP=$'\033[1;34m'
  C_OK=$'\033[1;32m'
  C_ERR=$'\033[1;31m'
else
  C_RESET=""
  C_TITLE=""
  C_STEP=""
  C_OK=""
  C_ERR=""
fi

say_title() { echo; echo -e "  ${C_TITLE}== AgentHub Connector Setup 🚀 ==${C_RESET}"; }
say_step() { echo -e "  ${C_STEP}🔹 $1${C_RESET}"; }
say_ok() { echo -e "  ${C_OK}✅ $1${C_RESET}"; }
say_err() { echo -e "  ${C_ERR}❌ $1${C_RESET}" >&2; }

PAIRING_CODE="${1:-}"
if [[ -z "$PAIRING_CODE" ]]; then
  say_title
  say_step "No pairing code argument provided."
  read -r -p "Pairing code: " PAIRING_CODE
fi

: "${AGENTHUB_DIR:=$HOME/.agenthub-connector}"
: "${APP_ORIGIN:=http://localhost:5173}"
: "${SUPABASE_URL:=http://127.0.0.1:55321}"

say_title
say_step "Preparing your connector setup..."

if ! command -v curl >/dev/null 2>&1; then
  say_err "curl is required."
  exit 1
fi

NODE_OK=0
if command -v node >/dev/null 2>&1; then
  NODE_MAJOR="$(node -p "process.versions.node.split('.')[0]" 2>/dev/null || echo 0)"
  if [[ "$NODE_MAJOR" =~ ^[0-9]+$ ]] && (( NODE_MAJOR >= 16 )); then
    NODE_OK=1
  fi
fi

PYTHON_CMD=""
if command -v python3 >/dev/null 2>&1; then
  PYTHON_CMD="python3"
elif command -v python >/dev/null 2>&1; then
  PY_MAJOR="$(python -c "import sys; print(sys.version_info[0])" 2>/dev/null || echo 0)"
  if [[ "$PY_MAJOR" == "3" ]]; then
    PYTHON_CMD="python"
  fi
fi

if (( NODE_OK == 0 )) && [[ -z "$PYTHON_CMD" ]]; then
  say_err "Need Node.js 16+ or Python 3 on the target machine."
  exit 1
fi

mkdir -p "$AGENTHUB_DIR"
say_ok "Environment checks passed."

say_step "Pairing device..."
RESP="$(curl -sS "$SUPABASE_URL/functions/v1/pair-device" \
  -H 'content-type: application/json' \
  -d "{\"code\":\"$PAIRING_CODE\",\"agent_name\":\"$(hostname)\",\"device_os\":\"linux\"}")"

if command -v node >/dev/null 2>&1; then
  TOKEN="$(printf '%s' "$RESP" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const j=JSON.parse(s||'{}');if(!j.agent_token){process.stderr.write((j.error||'Pairing failed')+'\\n');process.exit(1)};process.stdout.write(j.agent_token);});")"
else
  TOKEN="$(printf '%s' "$RESP" | "$PYTHON_CMD" -c "import json,sys; j=json.loads(sys.stdin.read() or '{}'); t=j.get('agent_token'); (sys.stderr.write((j.get('error') or 'Pairing failed')+'\\n'), sys.exit(1)) if not t else None; sys.stdout.write(t)")"
fi
say_ok "Pairing successful."

cat > "$AGENTHUB_DIR/.env" <<EOF
SUPABASE_URL=$SUPABASE_URL
CONNECTOR_AGENT_TOKEN=$TOKEN
CONNECTOR_AGENT_NAME=$(hostname)
CONNECTOR_DEVICE_OS=linux
EOF
say_ok "Saved connector credentials."

say_step "Preparing connector runner..."
RUNNER_CMD='node "$DIR/connector-runner.mjs"'
if (( NODE_OK == 1 )); then
cat > "$AGENTHUB_DIR/connector-runner.mjs" <<'EOF'
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
EOF
else
  say_step "Node.js 16+ not found, using Python runner fallback."
  RUNNER_CMD="\"$PYTHON_CMD\" \"\$DIR/connector-runner.py\""
cat > "$AGENTHUB_DIR/connector-runner.py" <<'EOF'
#!/usr/bin/env python3
import json
import os
import re
import subprocess
import sys
import time
from urllib import error, request

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
ENV_PATH = os.path.join(SCRIPT_DIR, ".env")
FATAL_AUTH_EXIT_CODE = 42
HEARTBEAT_INTERVAL_SEC = 10
HEARTBEAT_RETRY_SEC = 2.5
HEARTBEAT_TIMEOUT_SEC = 4
HEARTBEAT_RETRIES = 2


def read_env(path):
    values = {}
    if not os.path.exists(path):
        return values
    with open(path, "r", encoding="utf-8") as f:
        for raw in f:
            line = raw.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, v = line.split("=", 1)
            values[k] = v
    return values


env = read_env(ENV_PATH)
env.update(os.environ)
base_url = env.get("SUPABASE_URL", "http://127.0.0.1:55321").rstrip("/")
agent_token = env.get("CONNECTOR_AGENT_TOKEN", "")
agent_name = env.get("CONNECTOR_AGENT_NAME", "Remote Connector")
device_os = env.get("CONNECTOR_DEVICE_OS", "linux")

if not agent_token:
    print("CONNECTOR_AGENT_TOKEN missing in .env", file=sys.stderr)
    sys.exit(1)

safe_re = re.compile(r"^(echo|pwd|ls|dir|whoami|date)\b", re.I)
dev_re = re.compile(r"^(echo|pwd|ls|dir|cat|type|whoami|date|npm|node|pnpm|yarn|git|python|py|powershell|pwsh)\b", re.I)
seq = 0


def is_fatal_auth_error(message):
    m = (message or "").lower()
    return "invalid token" in m or "agent revoked" in m or "missing agent token" in m or "unauthorized" in m


def auth_fail(context, message):
    print(f"[auth] {context}: {message}", file=sys.stderr)
    print("[auth] Connector token is invalid or revoked. Re-run installer with a fresh pairing code.", file=sys.stderr)
    sys.exit(FATAL_AUTH_EXIT_CODE)


def call_fn(name, body=None, timeout=15):
    payload = json.dumps(body or {}).encode("utf-8")
    req = request.Request(
        f"{base_url}/functions/v1/{name}",
        data=payload,
        method="POST",
        headers={
            "content-type": "application/json",
            "authorization": f"Bearer {agent_token}",
        },
    )
    try:
        with request.urlopen(req, timeout=timeout) as res:
            raw = res.read().decode("utf-8", "replace")
            try:
                return json.loads(raw) if raw else {}
            except Exception:
                return {}
    except error.HTTPError as e:
        raw = e.read().decode("utf-8", "replace")
        try:
            data = json.loads(raw) if raw else {}
        except Exception:
            data = {}
        raise RuntimeError(data.get("error") or f"{name} failed")
    except Exception as e:
        raise RuntimeError(str(e))


def heartbeat():
    for attempt in range(HEARTBEAT_RETRIES + 1):
        try:
            call_fn("connector-heartbeat", {"name": agent_name, "device_os": device_os}, timeout=HEARTBEAT_TIMEOUT_SEC)
            return True
        except RuntimeError as e:
            msg = str(e)
            if is_fatal_auth_error(msg):
                auth_fail("heartbeat", msg)
            if attempt >= HEARTBEAT_RETRIES:
                print(f"heartbeat error: {msg}", file=sys.stderr)
                return False
            time.sleep(HEARTBEAT_RETRY_SEC)
    return False


def is_allowed(policy, command):
    cmd = command.strip()
    if policy == "FULL":
        return True
    if policy == "DEV":
        return bool(dev_re.search(cmd))
    return bool(safe_re.search(cmd))


def reject_reason(policy, command):
    if is_allowed(policy, command):
        return None
    if policy == "SAFE":
        return "SAFE policy only allows baseline read-only commands."
    if policy == "DEV":
        return "DEV policy only allows developer tooling commands."
    return None


def stream_chunk(job_id, stream, chunk):
    global seq
    seq += 1
    call_fn("connector-stream-event", {"job_id": job_id, "seq": seq, "stream": stream, "chunk": chunk})


def execute_job(job_id, command, policy):
    global seq
    seq = 0
    reason = reject_reason(policy, command)
    if reason:
        output = f"[policy] {reason}\n"
        stream_chunk(job_id, "system", output)
        call_fn(
            "connector-complete-job",
            {
                "job_id": job_id,
                "success": False,
                "error_message": reason,
                "command": command,
                "output": output,
            },
        )
        return

    proc = subprocess.Popen(["bash", "-lc", command], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    out, err = proc.communicate()
    out = out or ""
    err = err or ""
    if out:
        try:
            stream_chunk(job_id, "stdout", out)
        except RuntimeError as e:
            print(f"stream error: {e}", file=sys.stderr)
    if err:
        try:
            stream_chunk(job_id, "stderr", err)
        except RuntimeError as e:
            print(f"stream error: {e}", file=sys.stderr)

    call_fn(
        "connector-complete-job",
        {
            "job_id": job_id,
            "success": proc.returncode == 0,
            "exit_code": proc.returncode,
            "output": out + err,
            "command": command,
            "error_message": None if proc.returncode == 0 else f"Process exited with {proc.returncode}",
        },
    )


print("AgentHub connector runner started")
ok = heartbeat()
next_heartbeat = time.time() + (HEARTBEAT_INTERVAL_SEC if ok else HEARTBEAT_RETRY_SEC)

while True:
    now = time.time()
    if now >= next_heartbeat:
        ok = heartbeat()
        next_heartbeat = now + (HEARTBEAT_INTERVAL_SEC if ok else HEARTBEAT_RETRY_SEC)
    try:
        payload = call_fn("connector-pull-jobs")
        job = payload.get("job") if isinstance(payload, dict) else None
        policy = (payload.get("policy") if isinstance(payload, dict) else None) or "SAFE"
        if job:
            execute_job(job.get("id"), job.get("command", ""), policy)
    except RuntimeError as e:
        msg = str(e)
        if is_fatal_auth_error(msg):
            auth_fail("poll", msg)
        print(f"poll error: {msg}", file=sys.stderr)
    time.sleep(2)
EOF
  chmod +x "$AGENTHUB_DIR/connector-runner.py"
fi
say_ok "Runner prepared."

PID_FILE="$AGENTHUB_DIR/connector.pid"
LOG_FILE="$AGENTHUB_DIR/connector.log"
SUPERVISOR_FILE="$AGENTHUB_DIR/run-connector.sh"

if [[ -f "$PID_FILE" ]]; then
  OLD_PID="$(cat "$PID_FILE" || true)"
  if [[ -n "${OLD_PID:-}" ]] && kill -0 "$OLD_PID" >/dev/null 2>&1; then
    kill "$OLD_PID" >/dev/null 2>&1 || true
    sleep 1
  fi
fi

cat > "$SUPERVISOR_FILE" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
LOG="$DIR/connector.log"
while true; do
  __RUNNER_CMD__ >>"$LOG" 2>&1
  EXIT_CODE="$?"
  if [[ "$EXIT_CODE" -eq 42 ]]; then
    echo "[supervisor] auth failure, stopping. Re-run installer with fresh pairing code." >>"$LOG"
    exit 42
  fi
  echo "[supervisor] runner exited, restarting in 2s..." >>"$LOG"
  sleep 2
done
EOF
ESCAPED_RUNNER_CMD="$(printf '%s' "$RUNNER_CMD" | sed 's/[\/&]/\\&/g')"
sed -i "s/__RUNNER_CMD__/$ESCAPED_RUNNER_CMD/" "$SUPERVISOR_FILE"
chmod +x "$SUPERVISOR_FILE"

say_step "Starting connector supervisor..."
nohup "$SUPERVISOR_FILE" >>"$LOG_FILE" 2>&1 &
NEW_PID="$!"
echo "$NEW_PID" > "$PID_FILE"

sleep 1
if ! kill -0 "$NEW_PID" >/dev/null 2>&1; then
  say_err "Connector failed to stay running. Recent log output:"
  tail -n 40 "$LOG_FILE" >&2 || true
  exit 1
fi

say_ok "Connector runner supervisor started (pid $NEW_PID)."
echo
echo -e "  🎉 All set."
echo
