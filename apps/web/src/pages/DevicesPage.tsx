import { useState } from "react";
import { PolicyBadge } from "../components/PolicyBadge";
import { Spinner } from "../components/Spinner";
import { StatusBadge } from "../components/StatusBadge";
import { relativeTime } from "../lib/time";
import { supabase } from "../lib/supabase";
import { Agent, AgentPolicy } from "../lib/types";

type Props = {
  agents: Agent[];
  onChanged: () => Promise<void>;
};

export const DevicesPage = ({ agents, onChanged }: Props) => {
  const [pairingCode, setPairingCode] = useState<string | null>(null);
  const [pairingPolicy, setPairingPolicy] = useState<AgentPolicy>("SAFE");
  const [busy, setBusy] = useState(false);
  const [requestError, setRequestError] = useState<string | null>(null);
  const [copyMessage, setCopyMessage] = useState<string | null>(null);
  const appOrigin = window.location.origin;
  const installCommand =
    pairingCode && pairingCode.length > 0
      ? `curl -fsSL ${appOrigin}/install-connector.sh | bash -s -- ${pairingCode} ${pairingPolicy}`
      : "";
  const policyDescription =
    pairingPolicy === "SAFE"
      ? "SAFE: read-only baseline commands only (lowest risk)."
      : pairingPolicy === "DEV"
        ? "DEV: developer tooling commands allowed (balanced)."
        : "FULL: all commands allowed (highest risk).";

  const resolveInvokeError = async (error: unknown): Promise<string> => {
    const status = (error as { context?: { status?: number } })?.context?.status;
    if (status === 401) {
      return "Session expired or missing. Open Mailpit, click the latest magic link, then retry.";
    }

    const response = (error as { context?: Response })?.context;
    if (response) {
      try {
        const body = (await response.clone().json()) as { error?: string; msg?: string };
        if (body?.error) return body.error;
        if (body?.msg) return body.msg;
      } catch {
        try {
          const text = await response.clone().text();
          if (text) return text;
        } catch {
          // ignore
        }
      }
    }

    return (error as { message?: string })?.message ?? "Failed to generate pairing code.";
  };

  const issueCode = async () => {
    setBusy(true);
    setRequestError(null);
    const { data: authData } = await supabase.auth.getSession();
    const accessToken = authData.session?.access_token;
    if (!accessToken) {
      setBusy(false);
      setRequestError("No active session token. Sign in again from Mailpit and retry.");
      return;
    }

    const { data, error } = await supabase.functions.invoke("issue-pairing-token", {
      body: {},
      headers: {
        Authorization: `Bearer ${accessToken}`
      }
    });
    setBusy(false);
    if (!error && (data as { code?: string })?.code) {
      setPairingCode((data as { code: string }).code);
    } else if (error) {
      setRequestError(await resolveInvokeError(error));
    }
    await onChanged();
  };

  const copyInstallCommand = async () => {
    setCopyMessage(null);
    try {
      await navigator.clipboard.writeText(installCommand);
      setCopyMessage("Install command copied.");
    } catch {
      setCopyMessage("Clipboard blocked. Copy the command manually.");
    }
  };

  if (agents.length === 0) {
    return (
      <section className="card empty">
        <h2>No devices paired</h2>
        <p>1. Generate a pairing code below.</p>
        <p>2. Copy and run the remote one-liner on the target machine.</p>
        <p>3. Connector starts paired on this machine.</p>
        <button type="button" className="btn" onClick={() => void issueCode()} disabled={busy}>
          {busy ? <Spinner /> : "Generate pairing code"}
        </button>
        <p>
          Policy:{" "}
          <select value={pairingPolicy} onChange={(e) => setPairingPolicy(e.target.value as AgentPolicy)}>
            <option value="SAFE">SAFE</option>
            <option value="DEV">DEV</option>
            <option value="FULL">FULL</option>
          </select>
        </p>
        <p className="muted">{policyDescription}</p>
        {pairingCode ? (
          <>
            <p className="code-box">
              <code>{installCommand}</code>
            </p>
            <button type="button" className="btn ghost" onClick={() => void copyInstallCommand()}>
              Copy install command
            </button>
          </>
        ) : (
          <p className="muted">Generate pairing code to show a ready-to-run install command.</p>
        )}
        {copyMessage ? <p className="muted">{copyMessage}</p> : null}
        {requestError ? <p className="error-banner">{requestError}</p> : null}
      </section>
    );
  }

  return (
    <section className="card">
      <div className="section-head">
        <h2>Devices</h2>
        <div className="section-actions">
          <select value={pairingPolicy} onChange={(e) => setPairingPolicy(e.target.value as AgentPolicy)} aria-label="Pairing policy">
            <option value="SAFE">SAFE</option>
            <option value="DEV">DEV</option>
            <option value="FULL">FULL</option>
          </select>
          <button type="button" className="btn ghost" onClick={() => void issueCode()} disabled={busy}>
            {busy ? <Spinner /> : "New pairing code"}
          </button>
        </div>
      </div>
      <p className="muted">{policyDescription}</p>
      {pairingCode ? (
        <>
          <p className="code-box">
            <code>{installCommand}</code>
          </p>
          <button type="button" className="btn ghost" onClick={() => void copyInstallCommand()}>
            Copy install command
          </button>
          {copyMessage ? <p className="muted">{copyMessage}</p> : null}
        </>
      ) : (
        <p className="muted">Click "New pairing code" to generate a connector install command.</p>
      )}
      {requestError ? <p className="error-banner">{requestError}</p> : null}
      <div className="device-list">
        {agents.map((agent) => (
          <article className="device-item" key={agent.id}>
            <div>
              <h3>{agent.name}</h3>
              <small>Last seen {relativeTime(agent.last_seen)}</small>
            </div>
            <div className="device-meta">
              <StatusBadge lastSeen={agent.last_seen} />
              <PolicyBadge policy={agent.policy} />
            </div>
            <p className="muted">Last command: {agent.last_command ?? "none"}</p>
          </article>
        ))}
      </div>
    </section>
  );
};
