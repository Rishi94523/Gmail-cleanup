# Google Cloud Run deployment

The existing project is `gmail-cleanup-511806` in `us-central1`. Sign in with `gcloud.cmd auth login` if your CLI session expires. Configure the Google OAuth web client with the exact callback `https://gmail-cleanup-web-450826266929.us-central1.run.app/auth/google/callback` and add test users.

Save credentials in the ignored `.env` file: `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `TOKEN_ENCRYPTION_KEY`, pooled `DATABASE_URL`, direct `DATABASE_URL_UNPOOLED`, and the selected provider key/model. Keep the encryption key stable. Never put secrets in frontend variables, Git, or chat.

```powershell
npm.cmd run build
npm.cmd test
npm.cmd run ai:check
npm.cmd run db:migrate
pwsh -File scripts/deploy-cloudrun.ps1 -ProjectId gmail-cleanup-511806
```

The script builds remotely with Cloud Build, provisions version-pinned runtime secrets through Secret Manager, attaches narrowly scoped secret access to the runtime identity, and deploys the combined landing page and Node API. Secrets travel to Secret Manager through stdin and are never included in build sources or printed. Google Cloud billing must be enabled; Docker Desktop and application-default credentials are not required.

Current service limits: 1 vCPU, 512 MiB, min 0 / max 2 instances, concurrency 8, request timeout 3600 seconds. Long requests stream per-email progress and keepalives. These are initial test-deployment limits, not a thousand-user capacity claim or a hard spending cap.

`/` serves the landing page, `/app` serves the dashboard, and `/api/health` checks Neon connectivity and credential configuration. OAuth, Gmail, and model connectivity require separate real checks; health alone is not proof of mailbox changes. The process-local scheduler stays disabled on Cloud Run. Free users receive up to 100 emails total and cannot access daily or advanced additional cleanup endpoints. Paid entitlement is server-controlled; no public endpoint can grant it. Billing checkout and Cloud Tasks/Scheduler are future work.

Mailbox changes require saved AI-processing consent and an authorized cleanup request. The deployment does not trigger cleanup. Important and uncertain messages stay; deletion and sending are unavailable. Google OAuth is currently limited to configured test users.
