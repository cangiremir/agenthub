import { anonClient, serviceClient } from "./client.ts";

export const getUser = async (authorization: string | null) => {
  if (!authorization) return { user: null, error: "Missing authorization" };
  const token = authorization.replace(/^Bearer\s+/i, "");
  const { data, error } = await anonClient.auth.getUser(token);
  if (error || !data.user) return { user: null, error: error?.message ?? "Invalid token" };
  return { user: data.user, error: null };
};

export const verifyAgentToken = async (authorization: string | null) => {
  if (!authorization) return { agent: null, error: "Missing agent token" };
  const token = authorization.replace(/^Bearer\s+/i, "").trim();
  if (!token) return { agent: null, error: "Missing agent token" };

  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  const hash = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");

  const { data, error } = await serviceClient
    .from("agent_tokens")
    .select("agent_id, agents(id, owner_id, policy, revoked_at, name)")
    .eq("token_hash", hash)
    .maybeSingle();

  if (error || !data?.agents) return { agent: null, error: "Invalid token" };
  if (data.agents.revoked_at) return { agent: null, error: "Agent revoked" };

  return {
    agent: {
      id: data.agents.id,
      owner_id: data.agents.owner_id,
      policy: data.agents.policy,
      name: data.agents.name
    },
    error: null
  };
};

export const sha256 = async (value: string) => {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
};
