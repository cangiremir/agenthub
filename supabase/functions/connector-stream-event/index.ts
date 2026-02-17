import { serviceClient } from "../_shared/client.ts";
import { badRequest, json, unauthorized } from "../_shared/response.ts";
import { verifyAgentToken } from "../_shared/auth.ts";

Deno.serve(async (req) => {
  if (req.method !== "POST") return badRequest("POST required");

  const { agent, error } = await verifyAgentToken(req.headers.get("authorization"));
  if (!agent) return unauthorized(error ?? "Unauthorized");

  const body = await req.json().catch(() => null) as { job_id?: string; seq?: number; stream?: string; chunk?: string } | null;
  if (!body?.job_id || typeof body.seq !== "number" || !body.chunk) return badRequest("job_id, seq and chunk are required");

  const stream = body.stream === "stderr" ? "stderr" : body.stream === "system" ? "system" : "stdout";

  const { data: job, error: jobError } = await serviceClient
    .from("jobs")
    .select("id, owner_id, output_preview")
    .eq("id", body.job_id)
    .eq("agent_id", agent.id)
    .maybeSingle();

  if (jobError || !job) return json({ error: "Job not found" }, { status: 404 });

  const { error: eventError } = await serviceClient
    .from("job_events")
    .insert({ job_id: body.job_id, seq: body.seq, stream, chunk: body.chunk });

  if (eventError) return json({ error: eventError.message }, { status: 500 });

  const nextPreview = `${job.output_preview}${body.chunk}`.slice(-8000);
  await serviceClient.from("jobs").update({ output_preview: nextPreview }).eq("id", body.job_id);

  return json({ ok: true });
});
