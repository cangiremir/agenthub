import { useMemo, useState } from "react";
import { TerminalOutput } from "../components/TerminalOutput";
import { PolicyBadge } from "../components/PolicyBadge";
import { StatusBadge } from "../components/StatusBadge";
import { relativeTime, statusFromLastSeen } from "../lib/time";
import { supabase } from "../lib/supabase";
import { Agent, Job } from "../lib/types";

type Props = {
  jobs: Job[];
  agents: Agent[];
  selectedJob: Job | null;
  selectedOutput: string;
  onSelectJob: (id: string) => void;
  onRerun: (input: { agentId: string; command: string }) => Promise<void>;
  onClearRecentJobs: () => Promise<void>;
  clearingRecentJobs: boolean;
};

type AgentSession = NonNullable<NonNullable<Agent["ai_context"]>["sessions"]>[number];

const makeSessionKey = (agentId: string, session: AgentSession | null, index: number) => {
  if (!session) return `${agentId}:runtime:${index}`;
  const identity = session.flow_id ?? session.session_id ?? session.source ?? `session-${index}`;
  return `${agentId}:${identity}`;
};

type TranscriptEntry = { ts?: string; role: "User" | "Assistant" | "System"; text: string };

const parseSessionJsonObjects = (input: string) => {
  const blocks = input
    .split(/\n\s*\n/g)
    .map((part) => part.trim())
    .filter(Boolean);
  const parsed: Array<Record<string, unknown>> = [];

  for (const block of blocks) {
    try {
      parsed.push(JSON.parse(block) as Record<string, unknown>);
    } catch {
      // ignore non-json block
    }
  }
  if (parsed.length > 0) return parsed;

  for (const line of input.split(/\r?\n/).map((part) => part.trim()).filter(Boolean)) {
    try {
      parsed.push(JSON.parse(line) as Record<string, unknown>);
    } catch {
      // ignore non-json line
    }
  }
  return parsed;
};

const fmtTs = (ts?: string) => {
  if (!ts) return "";
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return "";
  return d.toISOString().slice(11, 19);
};

const buildSessionTranscript = (snippet: string) => {
  if (!snippet.trim()) return "";
  const objects = parseSessionJsonObjects(snippet);

  const entries: TranscriptEntry[] = [];
  const pushEntry = (entry: TranscriptEntry) => {
    const text = entry.text.trim();
    if (!text) return;
    const prev = entries[entries.length - 1];
    if (prev && prev.role === entry.role && prev.text === text) return;
    entries.push({ ...entry, text });
  };

  if (objects.length > 0) {
    for (const obj of objects) {
      const type = typeof obj.type === "string" ? obj.type : "";
      const payload = (obj.payload && typeof obj.payload === "object") ? obj.payload as Record<string, unknown> : null;
      const ts = typeof obj.timestamp === "string" ? obj.timestamp : undefined;
      if (!payload) continue;

      if (type === "event_msg") {
        const payloadType = typeof payload.type === "string" ? payload.type : "";
        if (payloadType === "user_message" && typeof payload.message === "string") {
          pushEntry({ ts, role: "User", text: payload.message });
        } else if (payloadType === "agent_message" && typeof payload.message === "string") {
          pushEntry({ ts, role: "Assistant", text: payload.message });
        } else if (payloadType === "task_complete" && typeof payload.last_agent_message === "string") {
          pushEntry({ ts, role: "Assistant", text: payload.last_agent_message });
        }
        continue;
      }

      if (type === "response_item") {
        const role = payload.role === "assistant" ? "Assistant" : payload.role === "user" ? "User" : "";
        const content = Array.isArray(payload.content) ? payload.content as Array<Record<string, unknown>> : [];
        for (const item of content) {
          const itemType = typeof item.type === "string" ? item.type : "";
          if (role === "User" && itemType === "input_text" && typeof item.text === "string") {
            pushEntry({ ts, role: "User", text: item.text });
          } else if (role === "Assistant" && itemType === "output_text" && typeof item.text === "string") {
            pushEntry({ ts, role: "Assistant", text: item.text });
          }
        }
      }
    }
  } else {
    // Fallback for non-JSON session snippets: normalize "User:/Assistant:" lines.
    for (const rawLine of snippet.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)) {
      const line = rawLine.replace(/^\[(\d{2}:\d{2}:\d{2})\]\s*/, "");
      const match = line.match(/^(User|Assistant|System)\s*:\s*(.+)$/i);
      if (match) {
        const role = (match[1][0].toUpperCase() + match[1].slice(1).toLowerCase()) as TranscriptEntry["role"];
        pushEntry({ role, text: match[2] });
      }
    }
  }

  if (entries.length === 0) return snippet.trim();
  return entries
    .map((entry) => {
      const tsPart = fmtTs(entry.ts);
      const header = tsPart ? `[${tsPart}] ${entry.role}` : `${entry.role}`;
      return `${header}\n${entry.text}`;
    })
    .join("\n\n");
};

export const JobsPage = ({ jobs, agents, selectedJob, selectedOutput, onSelectJob, onRerun, onClearRecentJobs, clearingRecentJobs }: Props) => {
  const [selectedAgentId, setSelectedAgentId] = useState<string>("");
  const [selectedSessionKey, setSelectedSessionKey] = useState<string>("");
  const [deviceFilterId, setDeviceFilterId] = useState<string>("all");

  const runningSessions = useMemo(() => {
    return agents.flatMap((agent) => {
      const runtimes = (agent.ai_context?.runtimes ?? []).filter((runtime) => runtime.kind === "codex" || runtime.kind === "claude");
      const latestJob = jobs.find((job) => job.agent_id === agent.id) ?? null;
      const sessions = (agent.ai_context?.sessions ?? []).filter((session) => (session.snippet ?? "").trim().length > 0);
      if (sessions.length === 0) {
        if (runtimes.length === 0) return [];
        return [{
          key: makeSessionKey(agent.id, null, 0),
          agent,
          runtimes,
          latestJob,
          session: null as AgentSession | null,
          ts: latestJob?.created_at ?? agent.last_seen ?? agent.created_at
        }];
      }

      return sessions.map((session, index) => ({
        key: makeSessionKey(agent.id, session, index),
        agent,
        runtimes,
        latestJob,
        session,
        ts: session.updated_at ?? latestJob?.created_at ?? agent.last_seen ?? agent.created_at
      }));
    }).sort((a, b) => new Date(b.ts).getTime() - new Date(a.ts).getTime());
  }, [agents, jobs]);

  const filteredJobs = useMemo(() => {
    const base = deviceFilterId === "all" ? jobs : jobs.filter((job) => job.agent_id === deviceFilterId);
    return [...base].sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
  }, [deviceFilterId, jobs]);

  const filteredSessions = useMemo(() => {
    if (deviceFilterId === "all") return runningSessions;
    return runningSessions.filter((entry) => entry.agent.id === deviceFilterId);
  }, [deviceFilterId, runningSessions]);

  const listItems = useMemo(() => {
    const sessionItems = filteredSessions.map((entry) => ({
      kind: "session" as const,
      key: `session-${entry.key}`,
      ts: entry.ts,
      entry
    }));
    const jobItems = filteredJobs.map((job) => ({
      kind: "job" as const,
      key: `job-${job.id}`,
      ts: job.created_at,
      job
    }));
    return [...sessionItems, ...jobItems].sort((a, b) => new Date(b.ts).getTime() - new Date(a.ts).getTime());
  }, [filteredJobs, filteredSessions]);

  const hasItems = listItems.length > 0;

  const deviceOptions = useMemo(() => {
    const byId = new Map(agents.map((agent) => [agent.id, agent]));
    const ids = new Set<string>();
    jobs.forEach((job) => ids.add(job.agent_id));
    runningSessions.forEach((entry) => ids.add(entry.agent.id));
    return [...ids]
      .map((id) => byId.get(id))
      .filter((agent): agent is Agent => Boolean(agent))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [agents, jobs, runningSessions]);

  const selectedSessionEntry = useMemo(
    () => runningSessions.find((entry) => entry.key === selectedSessionKey) ?? null,
    [runningSessions, selectedSessionKey]
  );

  const selectedAgent = useMemo(() => {
    if (selectedSessionEntry) return selectedSessionEntry.agent;
    if (selectedJob) return agents.find((agent) => agent.id === selectedJob.agent_id) ?? null;
    if (selectedAgentId) return agents.find((agent) => agent.id === selectedAgentId) ?? null;
    return null;
  }, [agents, selectedAgentId, selectedJob, selectedSessionEntry]);

  const selectedSessionSnippet = selectedSessionEntry?.session?.snippet?.trim() ?? "";
  const selectedSessionTranscript = useMemo(
    () => buildSessionTranscript(selectedSessionSnippet),
    [selectedSessionSnippet]
  );
  const showingSession = Boolean(selectedSessionEntry);

  return (
    <section className="jobs-grid">
      <div className="card list">
        <div className="section-head">
          <h2>Recent jobs</h2>
          <div className="section-actions">
            <select value={deviceFilterId} onChange={(e) => setDeviceFilterId(e.target.value)} aria-label="Filter by device">
              <option value="all">All</option>
              {deviceOptions.map((agent) => (
                <option key={agent.id} value={agent.id}>{agent.name}</option>
              ))}
            </select>
            <button
              type="button"
              className="clear-jobs-btn"
              onClick={() => void onClearRecentJobs()}
              disabled={clearingRecentJobs || !hasItems}
            >
              {clearingRecentJobs ? "Clearing..." : "Clear"}
            </button>
          </div>
        </div>

        {listItems.map((item) => {
          if (item.kind === "session") {
            const { agent, runtimes, latestJob, session, key } = item.entry;
            const flowLabel = (session?.flow_id ?? session?.session_id ?? "").slice(0, 12);
            const isActive = selectedSessionKey === key;
            return (
              <button
                type="button"
                className={`job-item running-agent-item ${isActive ? "active" : ""}`}
                key={item.key}
                onClick={() => {
                  setSelectedAgentId(agent.id);
                  setSelectedSessionKey(key);
                }}
              >
                <div className="running-agent-context">
                  <strong>{latestJob?.command ?? `${agent.name} live flow`}</strong>
                  <small>{relativeTime(item.ts)}</small>
                  <small className="running-agent-live">
                    {runtimes.some((r) => r.kind === "codex") ? "Codex CLI " : ""}
                    {runtimes.some((r) => r.kind === "claude") ? "Claude CLI" : ""}
                  </small>
                  {flowLabel ? <small className="running-agent-flow">Flow {flowLabel}</small> : null}
                </div>
                <div className="job-meta">
                  {latestJob ? (
                    <span className={`chip ${latestJob.status}`}>{latestJob.status}</span>
                  ) : (
                    <span className={`chip ${statusFromLastSeen(agent.last_seen)}`}>{statusFromLastSeen(agent.last_seen)}</span>
                  )}
                </div>
              </button>
            );
          }

          const { job } = item;
          const isActive = !showingSession && selectedJob?.id === job.id;
          return (
            <button
              key={item.key}
              type="button"
              className={`job-item ${isActive ? "active" : ""}`}
              onClick={() => {
                setSelectedSessionKey("");
                onSelectJob(job.id);
              }}
            >
              <div className="job-main">
                <strong>{job.command}</strong>
                <small>{relativeTime(job.created_at)}</small>
              </div>
              <div className="job-meta">
                <span className={`chip ${job.status}`}>{job.status}</span>
                {job.push_warning ? <span title="Push retry warning">!</span> : null}
              </div>
            </button>
          );
        })}

        {!hasItems ? (
          <div className="card empty">
            <h2>No jobs yet</h2>
            <p>Try: <code>whoami</code>, <code>pwd</code>, <code>npm test</code>.</p>
          </div>
        ) : null}
      </div>

      {selectedJob || selectedAgent || selectedSessionEntry ? (
        <div className="card detail">
          <div className="detail-head">
            <div>
              <h2>
                {showingSession
                  ? `${selectedAgent?.name ?? "Agent"} flow ${selectedSessionEntry?.session?.flow_id?.slice(0, 12) ?? ""}`.trim()
                  : (selectedJob?.command ?? `${selectedAgent?.name ?? "Agent"} live session`)}
              </h2>
              <small>
                {showingSession
                  ? `Updated ${relativeTime(selectedSessionEntry?.ts ?? null)}`
                  : (selectedJob
                    ? relativeTime(selectedJob.created_at)
                    : `Updated ${relativeTime(selectedAgent?.ai_context?.sessions?.[0]?.updated_at ?? null)}`)}
              </small>
            </div>
            {selectedJob && !showingSession ? (
              <button type="button" className="btn ghost" onClick={() => void onRerun({ agentId: selectedJob.agent_id, command: selectedJob.command })}>
                rerun
              </button>
            ) : null}
          </div>

          {selectedAgent ? (
            <div className="detail-meta">
              <StatusBadge lastSeen={selectedAgent.last_seen} />
              <PolicyBadge policy={selectedAgent.policy} />
              {selectedAgent.policy === "FULL" ? <p className="warning-banner">This agent can execute any command</p> : null}
            </div>
          ) : null}

          {!showingSession && selectedJob?.policy_rejection_reason ? <p className="error-banner">{selectedJob.policy_rejection_reason}</p> : null}
          {!showingSession && selectedJob?.error_message ? <p className="error-banner">{selectedJob.error_message}</p> : null}

          <TerminalOutput
            title={
              showingSession
                ? `Flow ${selectedSessionEntry?.session?.flow_id?.slice(0, 12) ?? selectedSessionEntry?.session?.session_id?.slice(0, 12) ?? "live"}`
                : (selectedJob ? `Job ${selectedJob.id.slice(0, 8)}` : `${selectedAgent?.name ?? "Agent"} session`)
            }
            text={
              showingSession
                ? (selectedSessionTranscript || "(no output yet)")
                : (selectedOutput || "(no output yet)")
            }
            onLoadFull={async () => {
              if (showingSession) {
                return selectedSessionTranscript || "(no output yet)";
              }
              if (!selectedJob?.output_storage_path) {
                return selectedOutput;
              }
              const { data, error } = await supabase.storage.from("job-logs").download(selectedJob.output_storage_path);
              if (error || !data) return selectedOutput;
              return await data.text();
            }}
            mode={showingSession ? "chat" : "log"}
          />
        </div>
      ) : null}
    </section>
  );
};
