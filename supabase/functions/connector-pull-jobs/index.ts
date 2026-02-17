import { serviceClient } from "../_shared/client.ts";
import { json, unauthorized } from "../_shared/response.ts";
import { verifyAgentToken } from "../_shared/auth.ts";

Deno.serve(async (req) => {
  if (req.method !== "POST") return json({ error: "POST required" }, { status: 405 });

  const { agent, error } = await verifyAgentToken(req.headers.get("authorization"));
  if (!agent) return unauthorized(error ?? "Unauthorized");

  const { data: queuedJobs, error: jobsError } = await serviceClient
    .from("jobs")
    .select("id, command, created_at")
    .eq("agent_id", agent.id)
    .eq("status", "queued")
    .order("created_at", { ascending: true })
    .limit(1);

  if (jobsError) return json({ error: jobsError.message }, { status: 500 });

  const job = queuedJobs?.[0];
  if (!job) return json({ job: null, policy: agent.policy });

  const nowIso = new Date().toISOString();
  const { data: updated, error: updateError } = await serviceClient
    .from("jobs")
    .update({ status: "running", started_at: nowIso })
    .eq("id", job.id)
    .eq("status", "queued")
    .select("id, command")
    .maybeSingle();

  if (updateError) return json({ error: updateError.message }, { status: 500 });
  if (!updated) return json({ job: null, policy: agent.policy });

  return json({ job: updated, policy: agent.policy, agent_name: agent.name });
});
