import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const envFile = join(process.cwd(), ".env.deploy");

const loadEnvFile = (path) => {
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    if (!line || line.startsWith("#")) continue;
    const idx = line.indexOf("=");
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    const value = line.slice(idx + 1).trim();
    if (!process.env[key]) process.env[key] = value;
  }
};

loadEnvFile(envFile);

const required = [
  "SUPABASE_ACCESS_TOKEN",
  "SUPABASE_PROJECT_REF",
  "SUPABASE_URL",
  "SUPABASE_ANON_KEY",
  "SUPABASE_SERVICE_ROLE_KEY",
  "NETLIFY_AUTH_TOKEN",
  "NETLIFY_SITE_ID",
  "FLY_API_TOKEN",
  "FLY_APP_NAME",
  "VAPID_PUBLIC_KEY",
  "VAPID_PRIVATE_KEY",
  "VAPID_SUBJECT"
];

const missing = required.filter((key) => !process.env[key]);

const printChecklist = () => {
  console.error("Token Checklist");
  console.error("Everything is ready; to run deploy you only need to provide these tokens:");
  console.error("- SUPABASE_ACCESS_TOKEN (.env.deploy)");
  console.error("- SUPABASE_PROJECT_REF (.env.deploy)");
  console.error("- SUPABASE_URL (.env.deploy)");
  console.error("- SUPABASE_ANON_KEY (.env.deploy)");
  console.error("- SUPABASE_SERVICE_ROLE_KEY (.env.deploy)");
  console.error("- NETLIFY_AUTH_TOKEN (.env.deploy)");
  console.error("- NETLIFY_SITE_ID (.env.deploy)");
  console.error("- FLY_API_TOKEN (.env.deploy)");
  console.error("- FLY_APP_NAME (.env.deploy)");
  console.error("- VAPID_PUBLIC_KEY (.env.deploy)");
  console.error("- VAPID_PRIVATE_KEY (.env.deploy)");
  console.error("- VAPID_SUBJECT (.env.deploy)");
  console.error("\nCommands:");
  console.error("1) Copy .env.deploy.example to .env.deploy");
  console.error("2) Fill in .env.deploy values");
  console.error("3) make deploy");
};

if (missing.length > 0) {
  console.error("Missing deploy credentials: " + missing.join(", "));
  printChecklist();
  process.exit(1);
}

process.env.VITE_SUPABASE_URL = process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL;
process.env.VITE_SUPABASE_ANON_KEY = process.env.VITE_SUPABASE_ANON_KEY || process.env.SUPABASE_ANON_KEY;
process.env.VITE_VAPID_PUBLIC_KEY = process.env.VITE_VAPID_PUBLIC_KEY || process.env.VAPID_PUBLIC_KEY;

const run = (cmd, args) =>
  new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: "inherit", shell: true, env: process.env });
    p.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${cmd} ${args.join(" ")} failed (${code})`));
    });
  });

const main = async () => {
  await run("npx", ["supabase", "link", "--project-ref", process.env.SUPABASE_PROJECT_REF]);
  await run("npx", ["supabase", "db", "push"]);

  const fnNames = [
    "issue-pairing-token",
    "pair-device",
    "connector-heartbeat",
    "connector-pull-jobs",
    "connector-stream-event",
    "connector-complete-job",
    "create-job",
    "revoke-agent"
  ];

  for (const fn of fnNames) {
    await run("npx", ["supabase", "functions", "deploy", fn]);
  }

  await run("npx", [
    "flyctl",
    "secrets",
    "set",
    `SUPABASE_URL=${process.env.SUPABASE_URL}`,
    `SUPABASE_SERVICE_ROLE_KEY=${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
    `VAPID_PUBLIC_KEY=${process.env.VAPID_PUBLIC_KEY}`,
    `VAPID_PRIVATE_KEY=${process.env.VAPID_PRIVATE_KEY}`,
    `VAPID_SUBJECT=${process.env.VAPID_SUBJECT}`,
    "--app",
    process.env.FLY_APP_NAME
  ]);

  await run("npm", ["--workspace", "@agenthub/web", "run", "build"]);
  await run("npx", ["netlify", "deploy", "--prod", "--site", process.env.NETLIFY_SITE_ID, "--dir=apps/web/dist"]);
  await run("npx", ["flyctl", "deploy", "--config", "services/push-worker/fly.toml", "--app", process.env.FLY_APP_NAME]);
};

main().catch((error) => {
  console.error(error.message);
  printChecklist();
  process.exit(1);
});
