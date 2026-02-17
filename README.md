# AgentHub

AgentHub is a complete SaaS-style remote command runner:
- Web PWA (`apps/web`) for jobs, devices, settings, and push subscriptions
- Supabase backend (`supabase`) with Auth PKCE, Postgres + RLS, Realtime, Storage, and Edge Functions
- Local connector (`services/connector`) that executes approved commands and streams output
- Push worker (`services/push-worker`) for Web Push delivery with retries (Fly.io in prod)

## Local run

Prereqs:
- Node.js 22+
- npm 10+
- Supabase CLI (for full local backend)
- Docker (for `supabase start`)

```bash
cp .env.local.example .env.local
make dev
```

`make dev` runs:
- Supabase local bootstrap (best-effort)
- Vite web app
- Connector service
- Push worker service

## UX features included
- Live terminal-style output streaming with auto-scroll pause-on-scroll-up
- Copy output and download full logs
- Very long output truncation + `show more`
- Command history dropdown and `rerun` action
- Device status colors (online/stale/offline) + human-readable last seen
- Policy visibility badges (SAFE/DEV/FULL)
- FULL policy warning + confirmation dialog before execution
- Clear offline and policy rejection errors
- Push retry warning signal on jobs
- Empty-state onboarding for devices/jobs
- Paired device settings + revoke
- Skeleton loaders + button spinners
- Mobile-first responsive layout

## Deploy

```bash
cp .env.deploy.example .env.deploy
# fill tokens
make deploy
```

If tokens are missing, deploy exits gracefully and prints a token checklist.

## Connector pairing flow
1. Sign in to web app.
2. Open Devices and generate pairing code.
3. Copy the generated remote one-liner and run it on the target machine.

## Directories
- `apps/web`: React + Vite + PWA
- `supabase/migrations`: SQL schema + RLS
- `supabase/functions`: edge APIs for pairing, job lifecycle, revocation
- `services/connector`: outbound-only runner
- `services/push-worker`: queue-based Web Push sender
- `scripts`: dev and deploy automation
