# Implementation and deployment plan

## Implemented locally

- JavaScript Node.js backend with REST endpoints and SQLite persistence.
- Google OAuth 2.0 authorization-code flow with state, PKCE, offline access, encrypted tokens, and CSRF-protected writes.
- Configurable Gmail queries, bounded/paginated metadata scans, explicit cleanup approvals, per-message label deltas, and undo.
- User-approved HTTPS one-click unsubscribe requests for supported headers; manual Gmail review otherwise.
- Optional OpenRouter classification with explicit data-sharing opt-in and validated model decisions.
- Local timezone-aware scheduler with durable account/day claims and account-level job leases.
- React/TypeScript product preview and a Dockerfile for the local backend.
- 20 automated backend/preview tests. Provider behavior is simulated in tests; live Gmail integration remains unverified.

## Selected production target: Google Cloud Run

The intended production frontend is React and TypeScript. The intended backend is TypeScript/NestJS with PostgreSQL/Prisma. These are migration targets, not claims about the current JavaScript/SQLite prototype.

Deploy separate stateless API and task-handler services as Docker containers. Use PostgreSQL for account-owned records, schedules, approvals, audit history, and durable checkpoints. Replace process-local timers with a Cloud Scheduler dispatcher that finds due accounts and enqueues authenticated Cloud Tasks HTTP requests. The worker processes bounded batches and persists progress before returning.

Cloud Tasks replaces the earlier Redis/BullMQ deployment proposal for this target. Request-based Cloud Run instances can scale to zero; background polling inside an idle API container is not the production scheduler. Database identity and authorization must remain scoped to the connected account. Task handlers must validate Cloud Tasks service identity and persisted authorization, rather than trust a user ID supplied in an unauthenticated request.

Use unique account/date/job keys and transactional leases to prevent duplicate execution. Mutating Gmail requests with ambiguous completion must be reconciled, never blindly replayed. Separate job retries from non-idempotent external effects. Enforce per-account/provider quotas, bounded worker concurrency, and global dispatch backpressure. Store encrypted OAuth refresh tokens in the database and encryption material in Secret Manager.

Deploy using GitHub Actions with short-lived cloud identity, health checks, and a rollback procedure. Add logging, monitoring, retention, and secret-safe backups. Benchmark representative mailbox sizes and simultaneous sessions before publishing capacity claims.

## Not implemented or verified yet

- Production NestJS/PostgreSQL migration, Cloud Tasks, Cloud Scheduler, Secret Manager, and GitHub Actions deployment.
- Google Cloud Run deployment or a public application URL.
- Live OAuth/token refresh, real Gmail changes, real unsubscribe delivery, or real model-provider responses.
- Public Google OAuth verification and any required security assessment.
- Thousand-user load testing or measured infrastructure/AI cost.

The public GitHub repository is a source-code project link; it is not evidence of a deployed or fully operational SaaS product.

## Deployment preparation

The React preview now has a multi-stage Cloud Run Docker image, a static HTTP entrypoint, Cloud Build configuration, and a PowerShell deployment script. The script creates a runtime identity without application IAM grants, deploys with a zero-instance minimum and two-instance maximum, and verifies a health endpoint that declares Gmail disabled. Local HTTP tests cover asset boundaries and disabled Gmail routes. This prepares the first public preview; it does not implement production mailbox processing. See [deploy/README.md](deploy/README.md).
