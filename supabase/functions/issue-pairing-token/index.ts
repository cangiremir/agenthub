import { serviceClient } from "../_shared/client.ts";
import { badRequest, json, unauthorized } from "../_shared/response.ts";
import { getUser } from "../_shared/auth.ts";

Deno.serve(async (req) => {
  if (req.method !== "POST") return badRequest("POST required");

  const { user, error } = await getUser(req.headers.get("authorization"));
  if (!user) return unauthorized(error ?? "Unauthorized");

  const code = crypto.randomUUID().replace(/-/g, "").slice(0, 10).toUpperCase();
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();

  const { data, error: insertError } = await serviceClient
    .from("pairing_tokens")
    .insert({ owner_id: user.id, code, expires_at: expiresAt })
    .select("id, code, expires_at")
    .single();

  if (insertError) return json({ error: insertError.message }, { status: 500 });

  return json(data);
});
