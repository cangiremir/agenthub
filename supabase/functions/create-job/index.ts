import { getUser } from "../_shared/auth.ts";
import { serviceClient } from "../_shared/client.ts";
import { badRequest, json, unauthorized } from "../_shared/response.ts";

const OFFLINE_THRESHOLD_MS = 300_000;

Deno.serve(async (req) => {
  if (req.method !== "POST") return badRequest("POST required");

  const { user, error } = await getUser(req.headers.get("authorization"));
  if (!user) return unauthorized(error ?? "Unauthorized");

  const body = await req.json().catch(() => null) as { agent_id?: string; command?: string } | null;
  if (!body?.agent_id || !body.command) return badRequest("agent_id and command are required");

  const command = body.command.trim();
  if (!command) return badRequest("command must not be empty");

  const { data: agent, error: agentError } = await serviceClient
    .from("agents")
    .select("id, owner_id, policy, last_seen, revoked_at")
    .eq("id", body.agent_id)
    .eq("owner_id", user.id)
    .maybeSingle();

  if (agentError || !agent) return json({ error: "Agent not found" }, { status: 404 });
  if (agent.revoked_at) return json({ error: "Agent revoked" }, { status: 409 });

  const lastSeenMs = agent.last_seen ? new Date(agent.last_seen).getTime() : 0;
  if (!lastSeenMs || Date.now() - lastSeenMs > OFFLINE_THRESHOLD_MS) {
    return json({ error: "Device offline" }, { status: 409 });
  }

  const { data: policyAllowed, error: policyErr } = await serviceClient.rpc("can_run_command", {
    policy: agent.policy,
    cmd: command
  });

  if (policyErr) return json({ error: policyErr.message }, { status: 500 });

  if (!policyAllowed) {
    const { data: reason } = await serviceClient.rpc("command_policy_reason", {
      policy: agent.policy,
      cmd: command
    });

    await serviceClient.from("jobs").insert({
      owner_id: user.id,
      agent_id: agent.id,
      command,
      status: "rejected",
      policy_rejection_reason: reason ?? "Command rejected by policy",
      completed_at: new Date().toISOString()
    });

    return json({ error: reason ?? "Command rejected by policy" }, { status: 422 });
  }

  const { data: job, error: jobError } = await serviceClient
    .from("jobs")
    .insert({ owner_id: user.id, agent_id: agent.id, command, status: "queued" })
    .select("id, status, command, created_at")
    .single();

  if (jobError) return json({ error: jobError.message }, { status: 500 });

  return json({ job });
});
