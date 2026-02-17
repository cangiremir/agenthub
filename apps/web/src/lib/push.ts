import { supabase } from "./supabase";

const decodeBase64Url = (value: string) => {
  const padding = "=".repeat((4 - (value.length % 4)) % 4);
  const base64 = (value + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(base64);
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i += 1) bytes[i] = raw.charCodeAt(i);
  return bytes;
};

export const ensurePushSubscription = async (publicKey: string | undefined) => {
  if (!publicKey || !("serviceWorker" in navigator) || !("PushManager" in window)) return;
  const { data } = await supabase.auth.getUser();
  const userId = data.user?.id;
  if (!userId) return;

  const reg = await navigator.serviceWorker.ready;
  let sub = await reg.pushManager.getSubscription();

  if (!sub) {
    sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: decodeBase64Url(publicKey)
    });
  }

  const payload = sub.toJSON();
  if (!payload.endpoint || !payload.keys?.p256dh || !payload.keys?.auth) return;

  await supabase.from("push_subscriptions").upsert(
    {
      owner_id: userId,
      endpoint: payload.endpoint,
      p256dh: payload.keys.p256dh,
      auth: payload.keys.auth,
      user_agent: navigator.userAgent
    },
    { onConflict: "endpoint" }
  );
};
