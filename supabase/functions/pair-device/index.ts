import { serviceClient } from "../_shared/client.ts";
import { badRequest, json } from "../_shared/response.ts";
import { sha256 } from "../_shared/auth.ts";

Deno.serve(async (req) => {
  if (req.method !== "POST") return badRequest("POST required");

  const body = await req.json().catch(() => null) as { code?: string; agent_name?: string; device_os?: string; policy?: string } | null;
  if (!body?.code || !body.agent_name) return badRequest("code and agent_name are required");
  const requestedPolicy = (body.policy ?? "SAFE").toUpperCase();
  if (!["SAFE", "DEV", "FULL"].includes(requestedPolicy)) {
    return badRequest("policy must be SAFE, DEV, or FULL");
  }

  const code = body.code.trim().toUpperCase();
  const nowIso = new Date().toISOString();

  const { data: tokenRow, error: tokenError } = await serviceClient
    .from("pairing_tokens")
    .select("id, owner_id, expires_at, consumed_at")
    .eq("code", code)
    .maybeSingle();

  if (tokenError || !tokenRow) return json({ error: "Invalid pairing code" }, { status: 404 });
  if (tokenRow.consumed_at) return json({ error: "Pairing code already used" }, { status: 409 });
  if (tokenRow.expires_at < nowIso) return json({ error: "Pairing code expired" }, { status: 410 });

  const rawToken = crypto.randomUUID().replace(/-/g, "") + crypto.randomUUID().replace(/-/g, "");
  const tokenHint = rawToken.slice(0, 6);
  const tokenHash = await sha256(rawToken);
  const deviceOs = body.device_os ?? "unknown";

  const { data: existingAgent } = await serviceClient
    .from("agents")
    .select("id, name, policy")
    .eq("owner_id", tokenRow.owner_id)
    .eq("name", body.agent_name)
    .eq("device_os", deviceOs)
    .is("revoked_at", null)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  let agent = existingAgent ?? null;

  if (!agent) {
    const { data: insertedAgent, error: agentError } = await serviceClient
      .from("agents")
      .insert({
        owner_id: tokenRow.owner_id,
        name: body.agent_name,
        token_hint: tokenHint,
        device_os: deviceOs,
        policy: requestedPolicy,
        last_seen: nowIso
      })
      .select("id, name, policy")
      .single();

    if (agentError || !insertedAgent) return json({ error: agentError?.message ?? "Failed to create agent" }, { status: 500 });
    agent = insertedAgent;
  } else {
    const { error: updateAgentError } = await serviceClient
      .from("agents")
      .update({
        token_hint: tokenHint,
        policy: requestedPolicy,
        last_seen: nowIso
      })
      .eq("id", existingAgent.id);
    if (updateAgentError) return json({ error: updateAgentError.message }, { status: 500 });
    agent = { ...existingAgent, policy: requestedPolicy };
  }

  const { error: tokenInsertError } = await serviceClient
    .from("agent_tokens")
    .upsert({ agent_id: agent.id, token_hash: tokenHash });

  if (tokenInsertError) return json({ error: tokenInsertError.message }, { status: 500 });

  await serviceClient.from("pairing_tokens").update({ consumed_at: nowIso }).eq("id", tokenRow.id);

  return json({
    agent_id: agent.id,
    agent_name: agent.name,
    policy: agent.policy,
    agent_token: rawToken
  });
});
