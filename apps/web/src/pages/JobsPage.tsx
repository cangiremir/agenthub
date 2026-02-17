import { TerminalOutput } from "../components/TerminalOutput";
import { PolicyBadge } from "../components/PolicyBadge";
import { StatusBadge } from "../components/StatusBadge";
import { relativeTime } from "../lib/time";
import { supabase } from "../lib/supabase";
import { Agent, Job } from "../lib/types";

type Props = {
  jobs: Job[];
  agents: Agent[];
  selectedJob: Job | null;
  selectedOutput: string;
  onSelectJob: (id: string) => void;
  onRerun: (input: { agentId: string; command: string }) => Promise<void>;
};

export const JobsPage = ({ jobs, agents, selectedJob, selectedOutput, onSelectJob, onRerun }: Props) => {
  if (jobs.length === 0) {
    return (
      <section className="card empty">
        <h2>No jobs yet</h2>
        <p>Try: <code>whoami</code>, <code>pwd</code>, <code>npm test</code>.</p>
      </section>
    );
  }

  const activeAgent = selectedJob ? agents.find((agent) => agent.id === selectedJob.agent_id) : undefined;

  return (
    <section className="jobs-grid">
      <div className="card list">
        <h2>Recent jobs</h2>
        {jobs.map((job) => {
          const agent = agents.find((item) => item.id === job.agent_id);
          return (
            <button key={job.id} type="button" className={`job-item ${selectedJob?.id === job.id ? "active" : ""}`} onClick={() => onSelectJob(job.id)}>
              <div className="job-main">
                <strong>{job.command}</strong>
                <small>{agent?.name ?? "Unknown"} • {relativeTime(job.created_at)}</small>
              </div>
              <div className="job-meta">
                <span className={`chip ${job.status}`}>{job.status}</span>
                {job.push_warning ? <span title="Push retry warning">!</span> : null}
              </div>
            </button>
          );
        })}
      </div>

      {selectedJob ? (
        <div className="card detail">
          <div className="detail-head">
            <div>
              <h2>{selectedJob.command}</h2>
              <small>{relativeTime(selectedJob.created_at)}</small>
            </div>
            <button type="button" className="btn ghost" onClick={() => void onRerun({ agentId: selectedJob.agent_id, command: selectedJob.command })}>
              rerun
            </button>
          </div>

          {activeAgent ? (
            <div className="detail-meta">
              <StatusBadge lastSeen={activeAgent.last_seen} />
              <PolicyBadge policy={activeAgent.policy} />
              {activeAgent.policy === "FULL" ? <p className="warning-banner">This agent can execute any command</p> : null}
            </div>
          ) : null}

          {selectedJob.policy_rejection_reason ? <p className="error-banner">{selectedJob.policy_rejection_reason}</p> : null}
          {selectedJob.error_message ? <p className="error-banner">{selectedJob.error_message}</p> : null}

          <TerminalOutput
            title={`Job ${selectedJob.id.slice(0, 8)}`}
            text={selectedOutput}
            onLoadFull={async () => {
              if (!selectedJob.output_storage_path) return selectedOutput;
              const { data, error } = await supabase.storage.from("job-logs").download(selectedJob.output_storage_path);
              if (error || !data) return selectedOutput;
              return await data.text();
            }}
          />
        </div>
      ) : null}
    </section>
  );
};
