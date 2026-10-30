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

## Custom domain

The purchased domain is `cleanmyinbox.space`. Its registrar/DNS host is Hostinger. Leave its nameservers unchanged and keep the Google verification TXT record. Domain ownership must be verified in Google Search Console before creating the Cloud Run domain mappings for the apex and `www` hostnames.

[Google's direct Cloud Run domain mapping](https://docs.cloud.google.com/run/docs/mapping-custom-domains) remains a Preview feature; Google does not recommend it for production. It avoids a separate load balancer for this initial deployment. A production rollout can move to the recommended external Application Load Balancer later.

Use the records returned by `gcloud beta run domain-mappings describe`, rather than pointing a CNAME directly at the Run URL. For this mapping the records are:

| Type | Host | Value |
| --- | --- | --- |
| A | @ | 216.239.32.21 |
| A | @ | 216.239.34.21 |
| A | @ | 216.239.36.21 |
| A | @ | 216.239.38.21 |
| AAAA | @ | 2001:4860:4802:32::15 |
| AAAA | @ | 2001:4860:4802:34::15 |
| AAAA | @ | 2001:4860:4802:36::15 |
| AAAA | @ | 2001:4860:4802:38::15 |
| CNAME | www | ghs.googlehosted.com |

Replace the registrar parking A record; do not leave competing apex A/AAAA records. Wait for DNS and Google-managed HTTPS to become ready before switching the app's public URL.

Add `https://cleanmyinbox.space/auth/google/callback` to the Google OAuth web client's authorized redirect URIs first. After HTTPS and OAuth configuration are ready, set `APP_URL=https://cleanmyinbox.space` and `REDIRECT_HOSTS` to the exact `www` and old Run hostnames (comma-separated). GET/HEAD requests on these aliases redirect to the canonical origin, preserving path and query. Arbitrary hosts are rejected, and API writes are not redirected between hosts. Health checks remain available on the configured aliases.

Set `SCHEDULER_AUDIENCE` to the existing Run origin used by Cloud Scheduler. The signed scheduler POST continues on its original hostname and must still pass Google signature, audience and service-account verification. Changing the public URL does not change its audience or require moving its scheduled job. Scheduler setup scripts preserve this separation; the main deployment script preserves the existing `APP_URL` and other environment settings on subsequent builds. `-PublicUrl` can explicitly select a new origin after the migration prerequisites are met.

Sessions use host-only cookies, so users may need to sign in once on the new domain; their saved preferences and schedules remain in the same database. Domain ownership and HTTPS do not replace Google's restricted-scope OAuth verification.
