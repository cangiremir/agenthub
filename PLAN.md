You are Codex CLI running locally in this repository. Build a complete SaaS product “AgentHub” using:
- Supabase (Auth PKCE, Postgres + RLS, Realtime via Postgres Changes, Storage, Edge Functions)
- Netlify (PWA hosting)
- Fly.io (Node push worker service that sends Web Push via VAPID)

IMPORTANT BEHAVIOR RULES
- Do NOT ask me questions.
- Do NOT pause waiting for tokens or manual console steps.
- If you need any tokens/credentials to deploy, you must still finish the entire repo and leave it in a “ready-to-run locally” state.
- At the end, print a short “Token Checklist” section: “Everything is ready; to run deploy you only need to provide these tokens: ...” and show exactly where to put them (env vars) and the exact commands to run. Do NOT block on them.
- Your work must be complete even if no tokens exist.

DELIVERABLE OUTCOME
- Repo contains all code, schema, migrations, RLS policies, edge functions, frontend PWA, push worker, local connector, installers, scripts, and docs.
- Local dev must run with ONE command: `make dev`.
- Cloud deployment must be possible via `make deploy` but may require tokens; if tokens are missing, deploy should fail gracefully and print the token checklist without breaking local dev.

ARCHITECTURE
- Web app PWA on Netlify in production, Vite dev locally.
- Backend is Supabase project; in dev use `supabase start`.
- Connector runs on user PC; outbound only; receives jobs from Supabase; executes allowed commands; streams output events; completes job.
- Push worker runs on Fly.io; in dev run locally; reads push_queue in Supabase and sends Web Push to user subscriptions.

FEATURE REQUIREMENTS
(… existing sections unchanged …)

[ keep everything from the previous prompt here exactly as-is:
database schema, edge functions, frontend, connector, worker, installers, scripts, CI, docs, etc.
Do not remove any requirement. ]

────────────────────────────────────────
PRODUCT POLISH BLOCK (MANDATORY UX RULES)
────────────────────────────────────────

You must implement these UX/product features so the result feels like a real SaaS product, not just a demo:

1) JOB OUTPUT EXPERIENCE
- Show live streaming output with a terminal-like monospace view.
- Auto-scroll while streaming but pause auto-scroll if the user scrolls up.
- Provide “Copy output” button.
- Provide “Download full log” button (store large logs in Supabase Storage if needed).
- Truncate extremely long output in UI with “show more”.

2) COMMAND HISTORY
- Persist last N commands per agent in DB.
- In UI show a dropdown of recent commands for quick reuse.
- Provide “rerun” button on previous jobs.

3) DEVICE STATUS UX
- Show colored status indicator:
  - green = online (heartbeat < 30s)
  - yellow = stale
  - red = offline
- Show last_seen timestamp human-readable (“2 minutes ago”).

4) POLICY VISIBILITY
- Show agent policy badge in UI:
  SAFE / DEV / FULL
- If FULL, show warning banner: “This agent can execute any command”.
- Require confirmation dialog before running FULL-profile command.

5) ERROR SURFACING
- If connector offline and user runs job:
  show immediate UI warning: “Device offline”.
- If policy rejects command:
  show clear message with reason.
- If push fails:
  silently retry but show small warning icon in job view.

6) PUSH NOTIFICATION QUALITY
- Push message title = agent name + result (success/fail).
- Body = first line of output or error.
- Clicking notification opens job detail page.

7) EMPTY STATE UX
- Devices page with no devices:
  show onboarding instructions and pairing flow.
- Jobs page with no jobs:
  show sample commands and help text.

8) SECURITY SIGNALS
- Show “paired devices” list in settings with revoke button.
- Show last command executed per device.

9) LOADING STATES
- Skeleton loaders instead of blank screens.
- Button spinners for async actions.

10) MOBILE FIRST
- UI must be usable on phone.
- Command input should focus automatically.
- Output must wrap nicely on small screens.

────────────────────────────────────────

END-OF-RUN OUTPUT
At the end print:
1) `make dev` instructions
2) Token Checklist with env vars for Supabase, Netlify, Fly.io
3) `make deploy` command
4) Connector install one-liners

NOW EXECUTE
Create the entire repo accordingly. Implement all code. Run lint/tests/builds. Ensure `make dev` works. Do not stop to ask questions.

