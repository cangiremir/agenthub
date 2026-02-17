# Deployment

1. Create `.env.deploy` from `.env.deploy.example`
2. Fill required tokens and project URLs/keys
3. Run `make deploy`

Deploy script tasks:
- Links Supabase project and pushes DB migration
- Deploys all required Edge Functions
- Sets Fly worker runtime secrets
- Builds and deploys web app to Netlify
- Deploys push worker to Fly.io

Missing tokens never break local dev. `make deploy` exits with checklist.
