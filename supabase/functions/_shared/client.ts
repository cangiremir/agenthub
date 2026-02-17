import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.4";
import { env } from "./env.ts";

export const serviceClient = createClient(env.supabaseUrl, env.serviceRoleKey, {
  auth: { persistSession: false, autoRefreshToken: false }
});

export const anonClient = createClient(env.supabaseUrl, env.anonKey, {
  auth: { persistSession: false, autoRefreshToken: false }
});
