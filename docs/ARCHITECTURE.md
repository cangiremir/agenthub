# Architecture

## Data flow
1. User creates a job via `create-job` edge function.
2. Connector polls `connector-pull-jobs`, executes allowed command, streams chunks with `connector-stream-event`, then calls `connector-complete-job`.
3. Completion enqueues push payload in `push_queue`.
4. Push worker sends Web Push and retries silently on failure.
5. Frontend subscribes via Supabase Realtime to `jobs`, `job_events`, `agents`.

## Security model
- Auth: Supabase PKCE session for web
- Connector auth: per-agent bearer token hashed in DB
- DB access: RLS owner isolation
- Command safety: enforced in SQL + edge function + connector runtime checks
- Device revocation: immediate via `revoke-agent`
