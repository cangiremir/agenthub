import { serviceClient } from "../_shared/client.ts";
import { json, unauthorized } from "../_shared/response.ts";
import { verifyAgentToken } from "../_shared/auth.ts";

Deno.serve(async (req) => {
  if (req.method !== "POST") return json({ error: "POST required" }, { status: 405 });

  const { agent, error } = await verifyAgentToken(req.headers.get("authorization"));
  if (!agent) return unauthorized(error ?? "Unauthorized");

  const body = await req.json().catch(() => ({})) as {
    ai_context?: unknown;
  };

  const { error: updateError } = await serviceClient
    .from("agents")
    .update({ last_seen: new Date().toISOString(), ai_context: body?.ai_context ?? null })
    .eq("id", agent.id);

  if (updateError) return json({ error: updateError.message }, { status: 500 });

  return json({ ok: true, agent_id: agent.id, policy: agent.policy, name: agent.name });
});
