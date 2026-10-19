# Deploy on Google Cloud Run

The Node service hosts both the landing page and Gmail workspace. You need Google Cloud billing enabled, `gcloud` signed in, a Google OAuth Web client, a Nebius Token Factory key, and a Neon PostgreSQL database. Keep all credentials in ignored environment files or Secret Manager.

1. Complete the local setup in the root README. Set the pooled `DATABASE_URL` and direct `DATABASE_URL_UNPOOLED`.
2. Run `npm run db:migrate`, `npm test`, `npm run build`, and `npm run ai:check`.
3. Deploy from PowerShell:

```powershell
gcloud.cmd auth login
pwsh -File scripts/deploy-cloudrun.ps1 -ProjectId YOUR_PROJECT_ID
```

The script provisions Cloud Build/Artifact Registry, runtime secrets, Cloud Run, and an authenticated Cloud Scheduler job. The job calls `/internal/scheduler/tick` every five minutes with an OIDC token. The app verifies the Google signature, audience and dedicated service-account email; an anonymous request is rejected. Each opted-in account is claimed once per local day before work starts. Failed or uncertain writes are not replayed automatically.

For an existing deployment, scheduler setup can be run separately:

```powershell
pwsh -File scripts/deploy-scheduler.ps1 -ProjectId YOUR_PROJECT_ID
```

Add the deployed origin's `/auth/google/callback` URL to your Google OAuth client and update its test-user list. The deployment sets `APP_URL`, `SERVE_LANDING=true`, `HACKATHON_MODE=true`, `ENABLE_LOCAL_SCHEDULER=false`, `NEBIUS_MODEL` and `SCHEDULER_SERVICE_ACCOUNT`. Secret bindings include Google credentials, the stable encryption key, pooled database URL and Nebius key. The direct database URL is used only for migrations.

Local daily scheduling needs a running Node process. Cloud Run uses Cloud Scheduler so it can scale to zero between requests; enabling a browser timer is not required. Users must explicitly enable daily cleanup in Preferences. Creating the scheduler job does not enable their routines.

Initial service limits are 1 vCPU, 512 MiB, min 0 / max 2 instances, concurrency 8 and a 3600-second request timeout. These are hackathon deployment settings, not a load-tested capacity claim. `/api/health` verifies database connectivity and configured credentials; it does not prove real mailbox changes.
