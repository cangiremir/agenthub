export type AgentPolicy = "SAFE" | "DEV" | "FULL";

export type Agent = {
  id: string;
  name: string;
  policy: AgentPolicy;
  device_os: string;
  last_seen: string | null;
  last_command: string | null;
  revoked_at: string | null;
  created_at: string;
};

export type Job = {
  id: string;
  agent_id: string;
  command: string;
  status: "queued" | "running" | "success" | "failed" | "rejected" | "canceled";
  created_at: string;
  completed_at: string | null;
  output_preview: string;
  output_storage_path: string | null;
  error_message: string | null;
  policy_rejection_reason: string | null;
  push_warning: boolean;
};

export type JobEvent = {
  id: number;
  job_id: string;
  seq: number;
  stream: "stdout" | "stderr" | "system";
  chunk: string;
  created_at: string;
};

export type CommandHistory = {
  id: number;
  agent_id: string;
  command: string;
  created_at: string;
};
