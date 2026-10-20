# Architecture

The same Node service serves the React landing page, workspace, OAuth callback and API. Cloud Run uses Neon PostgreSQL and Secret Manager. Local development uses SQLite and environment keys. NVIDIA Nemotron 3.5 Super VL is called only through Nebius Token Factory; no alternate model provider is enabled.

## Agent flow

- Discovery freezes the initial Primary sample before cleanup. It sends header metadata in groups of 25, with two model requests at a time. Evidence-backed broad topics are deduplicated before questions are saved.
- Topic preferences and written conditions are encrypted, versioned and editable. Sender exceptions take precedence. Initial answers can authorize the initial sample; answers after cleanup starts affect future mail only.
- Written onboarding or workspace instructions are interpreted into a preview and explicitly confirmed. The preview is encrypted, account-bound, expires after 20 minutes and checks preference versions before saving. Background notes preserve the user's words and inform discovery/cleanup without granting action permissions. Saving preferences never runs cleanup or releases held mail.
- Cleanup fetches 20-message windows, asks for two concurrent batches of ten decisions, then rechecks permissions and labels before serial Gmail writes. A model decision cannot override protected labels or user permissions.
- Changes are reserved before external writes and confirmed afterward. Uncertain writes are not replayed. Undo restores only labels/read state that the run changed.
- Uncertain topics use `ask_preference`; the email is held unchanged and the agent continues. Pending questions persist until the user answers or snoozes them.
- Automatic unsubscribe is separately enabled and limited to verified one-click endpoints. DNS/address restrictions and signed headers prevent arbitrary network actions. There is no general browser or shell tool exposed to email content.

## Daily execution

Local development uses an in-process minute timer. Cloud Run uses Cloud Scheduler every five minutes, with a Google-signed OIDC identity token verified for the exact audience and expected scheduler service account. Only users who enabled daily cleanup are eligible. A database lease and an account-local daily claim prevent duplicate runs across replicas and retries. The browser can be closed, and the service can scale to zero between requests.

`HACKATHON_MODE=true` enables repeat manual runs and daily cleanups, capped at 100 Primary emails per run. The retained commercial allowance code is inactive in this mode; it is not a payment system. Account/model concurrency remains bounded. This demo deployment is not a verified thousand-concurrent-user capacity claim.

## Storage and observability

OAuth tokens, discovery/sample context, learned preferences, example subscription subjects and cleanup deltas use AES-256-GCM encryption. Sessions and account data are scoped per user. CSRF checks protect browser writes; the scheduler uses its separate authenticated endpoint.

Operational logs report durations, token/cache counts and failure statuses without email text, subjects or credentials. Schema changes live in versioned SQL migrations; validate them on an expiring Neon branch before production.
