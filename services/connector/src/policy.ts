export type AgentPolicy = "SAFE" | "DEV" | "FULL";

const SAFE = /^(echo|pwd|ls|dir|whoami|date)\b/i;
const DEV = /^(echo|pwd|ls|dir|cat|type|whoami|date|npm|node|pnpm|yarn|git|python|py|powershell|pwsh)\b/i;

export const isCommandAllowed = (policy: AgentPolicy, command: string): boolean => {
  if (policy === "FULL") return true;
  if (policy === "DEV") return DEV.test(command.trim());
  return SAFE.test(command.trim());
};

export const policyRejectReason = (policy: AgentPolicy, command: string): string | null => {
  if (isCommandAllowed(policy, command)) return null;
  if (policy === "SAFE") return "SAFE policy only allows baseline read-only commands.";
  if (policy === "DEV") return "DEV policy only allows developer tooling commands.";
  return null;
};
