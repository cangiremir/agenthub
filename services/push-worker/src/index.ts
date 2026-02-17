import { createClient } from "@supabase/supabase-js";
import { config as loadEnv } from "dotenv";
import { resolve } from "node:path";
import webpush from "web-push";

loadEnv({ path: process.env.DOTENV_CONFIG_PATH ?? resolve(process.cwd(), ".env.local") });
loadEnv({ path: resolve(process.cwd(), "../../.env.local") });

const supabaseUrl = process.env.SUPABASE_URL ?? "";
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
const vapidPublic = process.env.VAPID_PUBLIC_KEY ?? "";
const vapidPrivate = process.env.VAPID_PRIVATE_KEY ?? "";
const vapidSubject = process.env.VAPID_SUBJECT ?? "mailto:dev@agenthub.local";

if (vapidPublic && vapidPrivate) {
  webpush.setVapidDetails(vapidSubject, vapidPublic, vapidPrivate);
}

const supabase =
  supabaseUrl && serviceKey
    ? createClient(supabaseUrl, serviceKey, {
        auth: { persistSession: false, autoRefreshToken: false }
      })
    : null;

type QueueRow = {
  id: number;
  attempts: number;
  payload: Record<string, unknown>;
  job_id: string;
  subscription_id: string | null;
  subscription: {
    endpoint: string;
    p256dh: string;
    auth: string;
  } | null;
};

export const nextAttemptAt = (attempts: number) => new Date(Date.now() + Math.min(60000, 5000 * (attempts + 1))).toISOString();

export const processRow = async (row: QueueRow) => {
  if (!supabase) return;

  if (!row.subscription) {
    await supabase.from("push_queue").update({ status: "failed", last_error: "Missing subscription" }).eq("id", row.id);
    await supabase.from("jobs").update({ push_warning: true }).eq("id", row.job_id);
    return;
  }

  try {
    await webpush.sendNotification(
      {
        endpoint: row.subscription.endpoint,
        keys: { p256dh: row.subscription.p256dh, auth: row.subscription.auth }
      },
      JSON.stringify(row.payload)
    );

    await supabase.from("push_queue").update({ status: "sent", last_error: null }).eq("id", row.id);
  } catch (error) {
    const message = (error as Error).message;
    const attempts = row.attempts + 1;
    const permanent = attempts >= 5;

    await supabase
      .from("push_queue")
      .update({
        status: permanent ? "failed" : "pending",
        attempts,
        last_error: message,
        next_attempt_at: nextAttemptAt(attempts)
      })
      .eq("id", row.id);

    await supabase.from("jobs").update({ push_warning: true }).eq("id", row.job_id);
  }
};

const tick = async () => {
  if (!supabase || !vapidPublic || !vapidPrivate) {
    return;
  }

  const { data, error } = await supabase
    .from("push_queue")
    .select("id, attempts, payload, job_id, subscription_id, subscription:push_subscriptions!push_queue_subscription_id_fkey(endpoint,p256dh,auth)")
    .eq("status", "pending")
    .lte("next_attempt_at", new Date().toISOString())
    .order("created_at", { ascending: true })
    .limit(20);

  if (error || !data) return;

  for (const row of data as unknown as QueueRow[]) {
    await processRow(row);
  }
};

const main = async () => {
  console.log("AgentHub push worker started");
  await tick();
  setInterval(() => {
    void tick();
  }, 5000);
};

if (process.env.NODE_ENV !== "test") {
  void main();
}
