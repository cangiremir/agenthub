create extension if not exists pgcrypto;

create type public.agent_policy as enum ('SAFE', 'DEV', 'FULL');
create type public.job_status as enum ('queued', 'running', 'success', 'failed', 'rejected', 'canceled');
create type public.push_status as enum ('pending', 'sent', 'failed');

create table public.agents (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  policy public.agent_policy not null default 'SAFE',
  token_hint text not null,
  device_os text not null default 'unknown',
  last_seen timestamptz,
  last_command text,
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.agent_tokens (
  agent_id uuid primary key references public.agents(id) on delete cascade,
  token_hash text not null,
  created_at timestamptz not null default now()
);

create table public.pairing_tokens (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  code text not null unique,
  expires_at timestamptz not null,
  consumed_at timestamptz,
  created_at timestamptz not null default now()
);

create table public.jobs (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  agent_id uuid not null references public.agents(id) on delete cascade,
  command text not null,
  status public.job_status not null default 'queued',
  started_at timestamptz,
  completed_at timestamptz,
  exit_code integer,
  output_preview text not null default '',
  output_storage_path text,
  error_message text,
  policy_rejection_reason text,
  push_warning boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.job_events (
  id bigint generated always as identity primary key,
  job_id uuid not null references public.jobs(id) on delete cascade,
  seq integer not null,
  stream text not null check (stream in ('stdout', 'stderr', 'system')),
  chunk text not null,
  created_at timestamptz not null default now(),
  unique(job_id, seq)
);

create table public.command_history (
  id bigint generated always as identity primary key,
  owner_id uuid not null references auth.users(id) on delete cascade,
  agent_id uuid not null references public.agents(id) on delete cascade,
  command text not null,
  created_at timestamptz not null default now()
);

create table public.push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  endpoint text not null unique,
  p256dh text not null,
  auth text not null,
  user_agent text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.push_queue (
  id bigint generated always as identity primary key,
  owner_id uuid not null references auth.users(id) on delete cascade,
  job_id uuid not null references public.jobs(id) on delete cascade,
  subscription_id uuid references public.push_subscriptions(id) on delete set null,
  payload jsonb not null,
  status public.push_status not null default 'pending',
  attempts integer not null default 0,
  last_error text,
  next_attempt_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index agents_owner_idx on public.agents(owner_id);
create index jobs_owner_created_idx on public.jobs(owner_id, created_at desc);
create index jobs_agent_created_idx on public.jobs(agent_id, created_at desc);
create index job_events_job_seq_idx on public.job_events(job_id, seq);
create index command_history_agent_created_idx on public.command_history(agent_id, created_at desc);
create index push_queue_pending_idx on public.push_queue(status, next_attempt_at, attempts);

create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger set_agents_updated_at
before update on public.agents
for each row execute function public.set_updated_at();

create trigger set_jobs_updated_at
before update on public.jobs
for each row execute function public.set_updated_at();

create trigger set_push_subscriptions_updated_at
before update on public.push_subscriptions
for each row execute function public.set_updated_at();

create trigger set_push_queue_updated_at
before update on public.push_queue
for each row execute function public.set_updated_at();

create or replace function public.can_run_command(policy public.agent_policy, cmd text)
returns boolean
language plpgsql
as $$
begin
  if policy = 'FULL' then
    return true;
  end if;

  if policy = 'DEV' then
    return cmd ~* '^(echo|pwd|ls|dir|cat|type|whoami|date|npm|node|pnpm|yarn|git|python|py|powershell|pwsh)\b';
  end if;

  return cmd ~* '^(echo|pwd|ls|dir|whoami|date)\b';
end;
$$;

create or replace function public.command_policy_reason(policy public.agent_policy, cmd text)
returns text
language plpgsql
as $$
begin
  if public.can_run_command(policy, cmd) then
    return null;
  end if;

  if policy = 'SAFE' then
    return 'SAFE policy allows only read-only baseline commands (echo/pwd/ls/dir/whoami/date).';
  elsif policy = 'DEV' then
    return 'DEV policy allows developer tooling commands only.';
  end if;

  return null;
end;
$$;

alter table public.agents enable row level security;
alter table public.jobs enable row level security;
alter table public.job_events enable row level security;
alter table public.command_history enable row level security;
alter table public.push_subscriptions enable row level security;
alter table public.push_queue enable row level security;
alter table public.pairing_tokens enable row level security;

create policy "agents_owner_all" on public.agents
for all
using (auth.uid() = owner_id)
with check (auth.uid() = owner_id);

create policy "jobs_owner_all" on public.jobs
for all
using (auth.uid() = owner_id)
with check (auth.uid() = owner_id);

create policy "job_events_owner_read" on public.job_events
for select
using (exists (select 1 from public.jobs j where j.id = job_events.job_id and j.owner_id = auth.uid()));

create policy "command_history_owner_all" on public.command_history
for all
using (auth.uid() = owner_id)
with check (auth.uid() = owner_id);

create policy "push_subscriptions_owner_all" on public.push_subscriptions
for all
using (auth.uid() = owner_id)
with check (auth.uid() = owner_id);

create policy "push_queue_owner_select" on public.push_queue
for select
using (auth.uid() = owner_id);

create policy "pairing_tokens_owner_all" on public.pairing_tokens
for all
using (auth.uid() = owner_id)
with check (auth.uid() = owner_id);

insert into storage.buckets (id, name, public)
values ('job-logs', 'job-logs', false)
on conflict (id) do nothing;

create policy "job_logs_read_own" on storage.objects
for select
using (bucket_id = 'job-logs' and split_part(name, '/', 1) = auth.uid()::text);

create policy "job_logs_insert_own" on storage.objects
for insert
with check (bucket_id = 'job-logs' and split_part(name, '/', 1) = auth.uid()::text);

create or replace function public.trim_command_history()
returns trigger
language plpgsql
as $$
begin
  delete from public.command_history
  where id in (
    select id
    from public.command_history
    where agent_id = new.agent_id
    order by created_at desc
    offset 50
  );
  return new;
end;
$$;

create trigger trim_command_history_after_insert
after insert on public.command_history
for each row execute function public.trim_command_history();

alter publication supabase_realtime add table public.agents;
alter publication supabase_realtime add table public.jobs;
alter publication supabase_realtime add table public.job_events;
alter publication supabase_realtime add table public.command_history;
