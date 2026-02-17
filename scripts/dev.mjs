import { spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const envPath = join(root, ".env.local");
const localSupabaseExe = process.env.APPDATA ? join(process.env.APPDATA, "npm", "supabase.exe") : "";
const supabaseCmd = existsSync(localSupabaseExe) ? localSupabaseExe : "supabase";
const dockerCmd = "docker";

const run = (cmd, args, opts = {}) =>
  new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"], shell: true, ...opts });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => {
      out += d.toString();
    });
    child.stderr.on("data", (d) => {
      err += d.toString();
    });
    child.on("close", (code) => {
      if (code === 0) resolve({ out, err });
      else reject(new Error(err || out || `${cmd} exited with ${code}`));
    });
  });

const hasSupabaseCli = async () => {
  try {
    await run(supabaseCmd, ["--version"]);
    return true;
  } catch {
    return false;
  }
};

const hasDockerEngine = async () => {
  try {
    await run(dockerCmd, ["info"]);
    return true;
  } catch {
    return false;
  }
};

const parseStatusEnv = (statusOutput) => {
  const map = new Map();
  for (const line of statusOutput.split(/\r?\n/)) {
    if (!line.startsWith("export ")) continue;
    const raw = line.replace(/^export\s+/, "").replace(/'/g, "");
    const idx = raw.indexOf("=");
    if (idx === -1) continue;
    map.set(raw.slice(0, idx), raw.slice(idx + 1));
  }
  return map;
};

const ensureEnv = async () => {
  const fallback = [
    "VITE_SUPABASE_URL=http://127.0.0.1:55321",
    "VITE_SUPABASE_ANON_KEY=",
    "SUPABASE_URL=http://127.0.0.1:55321",
    "SUPABASE_ANON_KEY=",
    "SUPABASE_SERVICE_ROLE_KEY=",
    "SUPABASE_DB_URL=postgresql://postgres:postgres@127.0.0.1:55322/postgres",
    "CONNECTOR_AGENT_TOKEN=local-dev-agent-token",
    "CONNECTOR_AGENT_NAME=Local Connector",
    "CONNECTOR_DEVICE_OS=windows",
    "VAPID_PUBLIC_KEY=",
    "VITE_VAPID_PUBLIC_KEY=",
    "VAPID_PRIVATE_KEY=",
    "VAPID_SUBJECT=mailto:dev@agenthub.local"
  ];

  if (!existsSync(envPath)) {
    writeFileSync(envPath, `${fallback.join("\n")}\n`, "utf8");
  }

  try {
    const canUseSupabaseLocal = (await hasSupabaseCli()) && (await hasDockerEngine());
    if (!canUseSupabaseLocal) throw new Error("supabase local unavailable");

    await run(supabaseCmd, ["start"]);
    const { out } = await run(supabaseCmd, ["status", "-o", "env"]);
    const env = parseStatusEnv(out);
    const merged = new Map();

    for (const line of readFileSync(envPath, "utf8").split(/\r?\n/)) {
      if (!line || line.startsWith("#")) continue;
      const idx = line.indexOf("=");
      if (idx === -1) continue;
      merged.set(line.slice(0, idx), line.slice(idx + 1));
    }

    merged.set("VITE_SUPABASE_URL", env.get("API_URL") ?? merged.get("VITE_SUPABASE_URL") ?? "http://127.0.0.1:55321");
    merged.set("VITE_SUPABASE_ANON_KEY", env.get("ANON_KEY") ?? merged.get("VITE_SUPABASE_ANON_KEY") ?? "");
    merged.set("SUPABASE_URL", env.get("API_URL") ?? merged.get("SUPABASE_URL") ?? "http://127.0.0.1:55321");
    merged.set("SUPABASE_ANON_KEY", env.get("ANON_KEY") ?? merged.get("SUPABASE_ANON_KEY") ?? "");
    merged.set("SUPABASE_SERVICE_ROLE_KEY", env.get("SERVICE_ROLE_KEY") ?? merged.get("SUPABASE_SERVICE_ROLE_KEY") ?? "");
    merged.set("SUPABASE_DB_URL", env.get("DB_URL") ?? merged.get("SUPABASE_DB_URL") ?? "postgresql://postgres:postgres@127.0.0.1:55322/postgres");
    merged.set("VITE_VAPID_PUBLIC_KEY", merged.get("VITE_VAPID_PUBLIC_KEY") ?? merged.get("VAPID_PUBLIC_KEY") ?? "");

    const content = [...merged.entries()].map(([k, v]) => `${k}=${v}`).join("\n");
    writeFileSync(envPath, `${content}\n`, "utf8");
    console.log(".env.local synced with local Supabase status");
  } catch {
    console.warn("Supabase local start/status unavailable; using fallback .env.local values.");
  }
};

const main = async () => {
  await ensureEnv();
  const withFunctions = (await hasSupabaseCli()) && (await hasDockerEngine());
  const names = withFunctions ? "web,connector,worker,functions" : "web,connector,worker";
  const colors = withFunctions ? "cyan,green,magenta,yellow" : "cyan,green,magenta";
  const commands = [
    "\"npm run dev:web\"",
    "\"npm run dev:connector\"",
    "\"npm run dev:worker\""
  ];
  if (withFunctions) {
    commands.push(`"${supabaseCmd} functions serve --env-file .env.local"`);
  } else {
    console.warn("Supabase local services unavailable; skipping edge functions serve process.");
  }

  const child = spawn(
    "npx",
    [
      "concurrently",
      "--names",
      names,
      "--prefix-colors",
      colors,
      ...commands
    ],
    {
      shell: true,
      stdio: "inherit",
      env: { ...process.env, DOTENV_CONFIG_PATH: envPath }
    }
  );
  child.on("close", (code) => process.exit(code ?? 0));
};

main();
