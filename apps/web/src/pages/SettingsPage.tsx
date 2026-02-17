import { useState } from "react";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { Spinner } from "../components/Spinner";
import { relativeTime } from "../lib/time";
import { supabase } from "../lib/supabase";
import { Agent } from "../lib/types";

type Props = {
  agents: Agent[];
  onChanged: () => Promise<void>;
};

export const SettingsPage = ({ agents, onChanged }: Props) => {
  const [pending, setPending] = useState<Agent | null>(null);
  const [busy, setBusy] = useState(false);

  const revoke = async () => {
    if (!pending) return;
    setBusy(true);
    await supabase.functions.invoke("revoke-agent", { body: { agent_id: pending.id } });
    setBusy(false);
    setPending(null);
    await onChanged();
  };

  return (
    <section className="card">
      <h2>Paired devices</h2>
      {agents.map((agent) => (
        <article className="device-item" key={agent.id}>
          <div>
            <h3>{agent.name}</h3>
            <small>Connected {relativeTime(agent.created_at)}</small>
            <p className="muted">Last command: {agent.last_command ?? "none"}</p>
          </div>
          <button type="button" className="btn danger" onClick={() => setPending(agent)}>
            Revoke
          </button>
        </article>
      ))}

      <ConfirmDialog
        open={Boolean(pending)}
        title="Revoke device"
        message="This device will lose access immediately."
        onCancel={() => setPending(null)}
        onConfirm={() => void revoke()}
        confirmLabel={busy ? "Revoking..." : "Revoke"}
      >
        {busy ? <Spinner /> : null}
      </ConfirmDialog>
    </section>
  );
};
