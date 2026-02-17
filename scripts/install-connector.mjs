import { spawn } from "node:child_process";

const pairingCode = process.argv[2];
const isWindows = process.platform === "win32";

const command = isWindows ? "powershell" : "bash";
const args = isWindows
  ? ["-ExecutionPolicy", "Bypass", "-File", "./scripts/install-connector.ps1"]
  : ["./scripts/install-connector.sh"];

if (pairingCode) {
  if (isWindows) args.push("-PairingCode", pairingCode);
  else args.push(pairingCode);
}

const child = spawn(command, args, { stdio: "inherit" });
child.on("close", (code) => process.exit(code ?? 1));
child.on("error", () => process.exit(1));
