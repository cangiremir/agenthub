import { serviceClient } from "../_shared/client.ts";
import { badRequest, json, unauthorized } from "../_shared/response.ts";
import { verifyAgentToken } from "../_shared/auth.ts";

Deno.serve(async (req) => {
  if (req.method !== "POST") return badRequest("POST required");

  const { agent, error } = await verifyAgentToken(req.headers.get("authorization"));
  if (!agent) return unauthorized(error ?? "Unauthorized");

  const body = await req.json().catch(() => null) as {
    job_id?: string;
    success?: boolean;
    exit_code?: number;
    output?: string;
    error_message?: string;
    command?: string;
  } | null;

  if (!body?.job_id || typeof body.success !== "boolean") {
    return badRequest("job_id and success are required");
  }

  const { data: job, error: jobError } = await serviceClient
    .from("jobs")
    .select("id, owner_id, command")
    .eq("id", body.job_id)
    .eq("agent_id", agent.id)
    .maybeSingle();

  if (jobError || !job) return json({ error: "Job not found" }, { status: 404 });

  let storagePath: string | null = null;
  const output = body.output ?? "";
  if (output.length > 12000) {
    storagePath = `${job.owner_id}/${job.id}.log`;
    const blob = new Blob([output], { type: "text/plain" });
    const { error: uploadError } = await serviceClient.storage.from("job-logs").upload(storagePath, blob, {
      upsert: true,
      contentType: "text/plain"
    });
    if (uploadError) {
      storagePath = null;
    }
  }

  const status = body.success ? "success" : "failed";
  const { error: updateError } = await serviceClient
    .from("jobs")
    .update({
      status,
      completed_at: new Date().toISOString(),
      exit_code: typeof body.exit_code === "number" ? body.exit_code : null,
      output_preview: output.slice(-8000),
      output_storage_path: storagePath,
      error_message: body.error_message ?? null
    })
    .eq("id", job.id);

  if (updateError) return json({ error: updateError.message }, { status: 500 });

  await serviceClient.from("agents").update({ last_command: job.command }).eq("id", agent.id);
  await serviceClient.from("command_history").insert({ owner_id: job.owner_id, agent_id: agent.id, command: job.command });

  const { data: subs } = await serviceClient
    .from("push_subscriptions")
    .select("id")
    .eq("owner_id", job.owner_id);

  const firstLine = (output.split(/\r?\n/).find((line) => line.trim().length > 0) ?? body.error_message ?? "No output").slice(0, 140);
  const title = `${agent.name} ${body.success ? "succeeded" : "failed"}`;

  if (subs && subs.length > 0) {
    const payload = {
      title,
      body: firstLine,
      job_id: job.id,
      agent_id: agent.id,
      status
    };

    await serviceClient.from("push_queue").insert(
      subs.map((sub) => ({
        owner_id: job.owner_id,
        job_id: job.id,
        subscription_id: sub.id,
        payload
      }))
    );
  }

  return json({ ok: true });
});
