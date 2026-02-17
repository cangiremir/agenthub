import { useEffect, useMemo, useState } from "react";
import { NavLink, Route, Routes, useSearchParams } from "react-router-dom";
import { type EmailOtpType } from "@supabase/supabase-js";
import { CommandComposer } from "./components/CommandComposer";
import { ConfirmDialog } from "./components/ConfirmDialog";
import { Skeleton } from "./components/Skeleton";
import { ensurePushSubscription } from "./lib/push";
import { supabase } from "./lib/supabase";
import { Agent, CommandHistory, Job, JobEvent } from "./lib/types";
import { statusFromLastSeen } from "./lib/time";
import { DevicesPage } from "./pages/DevicesPage";
import { JobsPage } from "./pages/JobsPage";
import { SettingsPage } from "./pages/SettingsPage";

const AuthGate = ({ onReady }: { onReady: () => void }) => {
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [sent, setSent] = useState(false);
  const [authMessage, setAuthMessage] = useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setAuthMessage(null);
    await supabase.auth.signInWithOtp({ email, options: { emailRedirectTo: `${window.location.origin}/` } });
    setSent(true);
    setAuthMessage("Magic link/code sent. In local dev, open Mailpit and use either method.");
  };

  const verifyCode = async (e: React.FormEvent) => {
    e.preventDefault();
    setAuthMessage(null);
    const { error } = await supabase.auth.verifyOtp({
      email,
      token: code.trim(),
      type: "email"
    });
    if (error) {
      setAuthMessage(error.message);
      return;
    }
    setAuthMessage("Signed in successfully.");
    await onReady();
  };

  return (
    <main className="auth-page">
      <h1>AgentHub</h1>
      <p>Secure command execution for your paired devices.</p>
      <form onSubmit={submit} className="auth-form">
        <input value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" type="email" required />
        <button className="btn" type="submit">Send sign-in link</button>
      </form>
      {sent ? <p className="muted">Check your email to continue.</p> : null}
      {sent ? (
        <form onSubmit={verifyCode} className="auth-form">
          <input value={code} onChange={(e) => setCode(e.target.value)} placeholder="6-digit code" inputMode="numeric" pattern="[0-9]{6}" />
          <button className="btn ghost" type="submit">Sign in with code</button>
        </form>
      ) : null}
      <p className="muted">Local dev note: magic links are delivered to Mailpit at http://127.0.0.1:55324.</p>
      {authMessage ? <p className="muted">{authMessage}</p> : null}
      <button type="button" className="btn ghost" onClick={onReady}>Refresh session</button>
    </main>
  );
};

export const App = () => {
  const [searchParams] = useSearchParams();
  const [loading, setLoading] = useState(true);
  const [session, setSession] = useState<Awaited<ReturnType<typeof supabase.auth.getSession>>["data"]["session"]>(null);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [events, setEvents] = useState<JobEvent[]>([]);
  const [history, setHistory] = useState<CommandHistory[]>([]);
  const [selectedAgentId, setSelectedAgentId] = useState("");
  const [selectedJobId, setSelectedJobId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [pendingFull, setPendingFull] = useState<{ agentId: string; command: string } | null>(null);
  const [authError, setAuthError] = useState<string | null>(null);

  const refreshSession = async () => {
    const { data } = await supabase.auth.getSession();
    setSession(data.session);
  };

  const handleAuthRedirect = async () => {
    const url = new URL(window.location.href);
    const code = url.searchParams.get("code");
    const tokenHash = url.searchParams.get("token_hash");
    const type = url.searchParams.get("type");

    if (code) {
      const { error } = await supabase.auth.exchangeCodeForSession(code);
      if (error) setAuthError(error.message);
      url.searchParams.delete("code");
      window.history.replaceState({}, "", url.toString());
      return;
    }

    if (tokenHash && type) {
      const { error } = await supabase.auth.verifyOtp({ token_hash: tokenHash, type: type as EmailOtpType });
      if (error) setAuthError(error.message);
      url.searchParams.delete("token_hash");
      url.searchParams.delete("type");
      window.history.replaceState({}, "", url.toString());
    }
  };

  const loadAll = async () => {
    const [a, j, e, h] = await Promise.all([
      supabase.from("agents").select("*").is("revoked_at", null).order("created_at", { ascending: true }),
      supabase.from("jobs").select("*").order("created_at", { ascending: false }).limit(100),
      supabase.from("job_events").select("*").order("created_at", { ascending: false }).limit(1500),
      supabase.from("command_history").select("*").order("created_at", { ascending: false }).limit(150)
    ]);

    setAgents((a.data as Agent[]) ?? []);
    setJobs((j.data as Job[]) ?? []);
    setEvents(((e.data as JobEvent[]) ?? []).reverse());
    setHistory((h.data as CommandHistory[]) ?? []);
  };

  useEffect(() => {
    void (async () => {
      await handleAuthRedirect();
      await refreshSession();
    })();
    const sub = supabase.auth.onAuthStateChange((_event, nextSession) => {
      setSession(nextSession);
    });
    setLoading(false);
    return () => sub.data.subscription.unsubscribe();
  }, []);

  const sessionUserId = session?.user?.id ?? null;

  useEffect(() => {
    if (!sessionUserId) return;
    void loadAll();
    void ensurePushSubscription(import.meta.env.VITE_VAPID_PUBLIC_KEY as string | undefined);

    const channel = supabase
      .channel("live")
      .on("postgres_changes", { event: "*", schema: "public", table: "jobs" }, () => void loadAll())
      .on("postgres_changes", { event: "*", schema: "public", table: "job_events" }, (payload) => {
        const next = payload.new as JobEvent;
        if (next && next.id) setEvents((prev) => [...prev, next].slice(-2000));
      })
      .on("postgres_changes", { event: "*", schema: "public", table: "agents" }, () => void loadAll())
      .subscribe();

    return () => {
      void supabase.removeChannel(channel);
    };
  }, [sessionUserId]);

  useEffect(() => {
    if (!selectedAgentId && agents.length > 0) setSelectedAgentId(agents[0].id);
  }, [agents, selectedAgentId]);

  useEffect(() => {
    const requestedJobId = searchParams.get("job");
    if (!requestedJobId) return;
    if (jobs.some((job) => job.id === requestedJobId)) {
      setSelectedJobId(requestedJobId);
    }
  }, [jobs, searchParams]);

  const runJob = async ({ agentId, command }: { agentId: string; command: string }) => {
    const agent = agents.find((item) => item.id === agentId);
    if (!agent) return;

    if (statusFromLastSeen(agent.last_seen) === "offline") {
      setError("Device offline");
      return;
    }

    if (agent.policy === "FULL" && pendingFull === null) {
      setPendingFull({ agentId, command });
      return;
    }

    setSubmitting(true);
    setError(null);

    const { error: invokeError, data } = await supabase.functions.invoke("create-job", {
      body: { agent_id: agentId, command }
    });

    if (invokeError) {
      setError(invokeError.message);
    } else if ((data as { error?: string })?.error) {
      setError((data as { error: string }).error);
    }

    await loadAll();
    setSubmitting(false);
    setPendingFull(null);
  };

  const selectedJob = useMemo(() => jobs.find((job) => job.id === selectedJobId) ?? jobs[0] ?? null, [jobs, selectedJobId]);
  const selectedOutput = useMemo(() => {
    if (!selectedJob) return "";
    const chunks = events.filter((event) => event.job_id === selectedJob.id).sort((a, b) => a.seq - b.seq).map((e) => e.chunk);
    return chunks.length > 0 ? chunks.join("") : selectedJob.output_preview;
  }, [events, selectedJob]);

  if (loading) {
    return (
      <main className="page shell">
        <Skeleton height={28} />
        <Skeleton height={140} />
        <Skeleton height={180} />
      </main>
    );
  }

  if (!session) {
    return <AuthGate onReady={() => void refreshSession()} />;
  }

  return (
    <main className="shell">
      <header className="topbar">
        <h1>AgentHub</h1>
        <button type="button" className="btn ghost" onClick={() => void supabase.auth.signOut()}>
          Sign out
        </button>
      </header>

      <nav className="tabs">
        <NavLink to="/jobs">Jobs</NavLink>
        <NavLink to="/devices">Devices</NavLink>
        <NavLink to="/settings">Settings</NavLink>
      </nav>

      <CommandComposer
        agents={agents}
        selectedAgentId={selectedAgentId}
        onSelectAgent={setSelectedAgentId}
        recentCommands={history.filter((h) => h.agent_id === selectedAgentId).slice(0, 20)}
        submitting={submitting}
        onRun={runJob}
      />

      {authError ? <p className="error-banner">Auth error: {authError}</p> : null}
      {error ? <p className="error-banner">{error}</p> : null}

      <Routes>
        <Route
          path="/"
          element={<JobsPage jobs={jobs} agents={agents} selectedJob={selectedJob} selectedOutput={selectedOutput} onSelectJob={setSelectedJobId} onRerun={runJob} />}
        />
        <Route
          path="/jobs"
          element={<JobsPage jobs={jobs} agents={agents} selectedJob={selectedJob} selectedOutput={selectedOutput} onSelectJob={setSelectedJobId} onRerun={runJob} />}
        />
        <Route path="/devices" element={<DevicesPage agents={agents} onChanged={loadAll} />} />
        <Route path="/settings" element={<SettingsPage agents={agents} onChanged={loadAll} />} />
      </Routes>

      <ConfirmDialog
        open={Boolean(pendingFull)}
        title="FULL policy confirmation"
        message="This agent can execute any command. Continue?"
        confirmLabel="Run anyway"
        onCancel={() => setPendingFull(null)}
        onConfirm={() => {
          if (!pendingFull) return;
          void runJob(pendingFull);
        }}
      />
    </main>
  );
};
