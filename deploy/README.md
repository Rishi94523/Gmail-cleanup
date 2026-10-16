# Google Cloud Run deployment

## Personal setup

The Google Cloud CLI (`gcloud.cmd`) is installed on the development machine. Its previously saved login has expired; refresh it in your own PowerShell:

```powershell
gcloud.cmd auth login
gcloud.cmd projects list
```

Use your own browser to sign in. Create or select a dedicated project in [Google Cloud Console](https://console.cloud.google.com/projectcreate), and link an active billing account in [Billing](https://console.cloud.google.com/billing). Cloud Run's monthly allowances still apply after the one-time $300 trial, but excess and other services can incur charges. Billing budgets notify; they are not a hard spending cap. No password, credential JSON, or access token needs to be pasted into chat. Send only the project ID when ready.

The app can be built remotely with Cloud Build; Docker Desktop is not required on the development machine. `gcloud auth application-default login` is not required for this deployment script. Deployed services use attached service accounts; GitHub deployment will use Workload Identity Federation rather than a long-lived service-account key.

## First release: public product preview

```powershell
pwsh -File scripts/deploy-cloudrun.ps1 -ProjectId YOUR_PROJECT_ID
```

The script verifies billing, enables Run/Build/Artifact Registry APIs, creates an image repository and dedicated runtime/build service accounts if absent, builds the container, deploys the preview, and verifies `/api/health`. It uses explicit project arguments without changing the user's default project. The build identity receives source-object read access on one source bucket, image-write access on this repository, and log-write access in the project. The web runtime identity receives no application data permissions. The account running the script needs sufficient permissions to create these resources, set those bindings, and attach service identities; it never grants Owner or Editor. If access is denied, inspect the stated identity and missing permission before changing IAM.

Defaults: `us-central1`, 1 vCPU, 512 MiB RAM, minimum zero instances, maximum two instances, concurrency 80, request-based CPU allocation. These settings limit the initial deployment's footprint; they are not a spending cap or capacity benchmark. Image storage, builds, logs, networking, and other services have separate billing and allowances.

The public container serves the React marketing site and its labelled example workflow. `/api/health` explicitly reports `gmailEnabled: false`; live Gmail routes return 503. OAuth secrets and local databases are excluded from both Docker and Cloud Build upload contexts. No task queues or scheduled mailbox writes are created in this release.

The first preview was deployed on October 16, 2026 to `gmail-cleanup-511806` in `us-central1`: [Open Inboxclean](https://gmail-cleanup-web-450826266929.us-central1.run.app). The public homepage and `/api/health` were verified over HTTPS. Use the application health path rather than `/healthz`, which returned a Google frontend 404 on this deployment without reaching the container.

## Full application rollout

1. Shared PostgreSQL storage and asynchronous data access are now implemented and verified against Neon; existing local SQLite records are not automatically migrated. Configure its pooled URL in Cloud Run Secret Manager before deploying the real backend.
2. Serve the real authenticated dashboard alongside the website/API on Cloud Run.
3. Deploy a separate private Cloud Run task service. Only the Cloud Tasks invocation identity may invoke it.
4. Use Cloud Scheduler to invoke a private dispatcher, which selects due accounts and enqueues bounded jobs. Do not create a cron resource per end user.
5. Preserve user's chosen local time, approvals, protections, pause/disconnect state, and idempotency. Reconcile ambiguous Gmail writes before retries.
6. Store OAuth credentials, token-encryption material, database connection configuration, and AI keys in Secret Manager with narrowly scoped runtime access.
7. Configure the Google OAuth web client with the public app's exact `/auth/google/callback` URL, add test users, and verify a connected test mailbox with explicit approval.
8. Add deployment automation, monitoring, retention, load testing, and public OAuth verification before opening broad signup.

The Node `server/index.js` now uses Neon Postgres when configured and disables its process-local scheduler under Cloud Run. It remains separate from the deployed marketing preview. The production API, worker, and scheduler must not be reported as working Gmail automation until their live paths have been exercised.
