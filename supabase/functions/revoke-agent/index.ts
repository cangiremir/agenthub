import { getUser } from "../_shared/auth.ts";
import { serviceClient } from "../_shared/client.ts";
import { badRequest, json, unauthorized } from "../_shared/response.ts";

Deno.serve(async (req) => {
  if (req.method !== "POST") return badRequest("POST required");

  const { user, error } = await getUser(req.headers.get("authorization"));
  if (!user) return unauthorized(error ?? "Unauthorized");

  const body = await req.json().catch(() => null) as { agent_id?: string } | null;
  if (!body?.agent_id) return badRequest("agent_id is required");

  const nowIso = new Date().toISOString();

  const { data: updated, error: updateError } = await serviceClient
    .from("agents")
    .update({ revoked_at: nowIso })
    .eq("id", body.agent_id)
    .eq("owner_id", user.id)
    .select("id")
    .maybeSingle();

  if (updateError) return json({ error: updateError.message }, { status: 500 });
  if (!updated) return json({ error: "Agent not found" }, { status: 404 });

  await serviceClient
    .from("jobs")
    .update({
      status: "canceled",
      completed_at: nowIso,
      error_message: "Agent revoked before execution"
    })
    .eq("agent_id", body.agent_id)
    .eq("owner_id", user.id)
    .in("status", ["queued", "running"]);

  await serviceClient.from("agent_tokens").delete().eq("agent_id", body.agent_id);

  return json({ ok: true });
});
