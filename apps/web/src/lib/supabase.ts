import { createClient } from "@supabase/supabase-js";

const rawUrl = import.meta.env.VITE_SUPABASE_URL as string;
const anon = import.meta.env.VITE_SUPABASE_ANON_KEY as string;

const resolveSupabaseUrl = (input: string): string => {
  if (!input) return input;
  try {
    const parsed = new URL(input);
    const isLocalConfig = parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost";
    const browserHost = window.location.hostname;
    const browserIsRemote = browserHost !== "127.0.0.1" && browserHost !== "localhost";
    if (isLocalConfig && browserIsRemote) {
      parsed.hostname = browserHost;
      return parsed.toString();
    }
    return input;
  } catch {
    return input;
  }
};

const url = resolveSupabaseUrl(rawUrl);

export const supabase = createClient(url, anon, {
  auth: {
    flowType: "implicit",
    autoRefreshToken: true,
    persistSession: true,
    detectSessionInUrl: true
  }
});
