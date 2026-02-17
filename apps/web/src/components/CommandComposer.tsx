import { FormEvent, useState } from "react";
import { Agent, CommandHistory } from "../lib/types";
import { Spinner } from "./Spinner";

type Props = {
  agents: Agent[];
  selectedAgentId: string;
  recentCommands: CommandHistory[];
  submitting: boolean;
  onSelectAgent: (id: string) => void;
  onRun: (input: { agentId: string; command: string }) => Promise<void>;
};

export const CommandComposer = ({ agents, selectedAgentId, recentCommands, submitting, onSelectAgent, onRun }: Props) => {
  const [command, setCommand] = useState("");

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!selectedAgentId || !command.trim()) return;
    await onRun({ agentId: selectedAgentId, command: command.trim() });
    setCommand("");
  };

  return (
    <form className="composer" onSubmit={submit}>
      <div className="composer-row">
        <select value={selectedAgentId} onChange={(e) => onSelectAgent(e.target.value)}>
          {agents.map((agent) => (
            <option key={agent.id} value={agent.id}>
              {agent.name}
            </option>
          ))}
        </select>
        <input
          placeholder="Enter command"
          value={command}
          onChange={(e) => setCommand(e.target.value)}
          autoFocus
          inputMode="text"
        />
        <button type="submit" className="btn" disabled={submitting || !selectedAgentId}>
          {submitting ? <Spinner /> : "Run"}
        </button>
      </div>
      <div className="composer-row secondary">
        <select onChange={(e) => setCommand(e.target.value)} value={command || ""}>
          <option value="">Recent commands</option>
          {recentCommands.map((row) => (
            <option key={row.id} value={row.command}>
              {row.command}
            </option>
          ))}
        </select>
      </div>
    </form>
  );
};
