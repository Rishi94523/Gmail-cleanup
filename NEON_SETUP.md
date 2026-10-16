# Neon setup and verification

Configured on October 16, 2026 for the user-selected project `gentle-bar-11476855`, organization `org-soft-hat-41423761`, branch `production`.

## Setup commands

```powershell
npm.cmd i -g neon@latest
neon.cmd init -y --org-id org-soft-hat-41423761 --project-id gentle-bar-11476855 --branch production --services postgres
neon.cmd deploy
```

The installer also installed Neon agent skills/tooling. Init initially reported an offline/unverified link; deploy opened browser authentication, which the user completed. The resulting provider output was:

```text
Auth complete (profile DEFAULT)
No changes — branch production already matches the policy.
Utilized services: Postgres
Pulled 3 Neon variables into .env
  Postgres        DATABASE_URL, DATABASE_URL_UNPOOLED
  Branch          NEON_BRANCH
```

The app uses these variables server-side. No Neon Auth, Functions, object storage, realtime, or AI Gateway was provisioned. Google OAuth and the chosen Cloud Run hosting architecture are preserved. Credentials are ignored by Git/Docker/Cloud Build and were not printed or committed.

## Storage implementation

- Reusable `pg.Pool`, pooled application traffic, verified TLS, channel binding, bounded connection count and query/connect timeouts.
- Parameterized Postgres queries and pinned-client transactions for multi-statement changes.
- Async storage operations across sessions, OAuth state, preferences, plans, audit records, leases, and Gmail token updates.
- Versioned/checksummed SQL migration using a direct connection and transaction-scoped advisory lock. Startup never creates the Postgres schema ad hoc.
- Local SQLite fallback for offline tests. Configured Postgres failures never silently fall back to SQLite; Cloud Run requires a shared database.

Driver guidance followed the installed `neon` and `neon-postgres` agent skills and [Neon's connection-method documentation](https://neon.com/docs/connect/choose-connection).

## Migration and real database checks

Created the expiring branch `dev-postgres-20261016` from production, expiring October 17, 2026 at 12:00 UTC, and pulled only its Postgres variables into ignored `data/neon-test.env`. The workspace remains linked to production.

```powershell
node --env-file=data/neon-test.env scripts/migrate.mjs
node --env-file=data/neon-test.env scripts/verify-neon.mjs
npm.cmd run db:migrate
node --env-file=.env scripts/smoke-production.mjs
```

The initial migration was tested on the development branch, then applied to production. The verification harness starts actual HTTP app instances with separate Postgres pools. It creates isolated test records only on the development branch, exercises the application, and removes its fixtures afterward. Gmail itself is replaced with a test-only adapter: no real mail is read or changed. Production verification starts/restarts the real server and checks a newly created anonymous session; it removes only that session afterward.

Validated checks include real database connectivity, shared session/rule persistence, scan/approval records, account isolation, duplicate prevention, audit/undo, distributed account leases, and transaction rollback. Production health returned `database: "postgres"`, `connected: true`, and `gmailConfigured: false`; the dashboard and status routes returned HTTP 200 and session state survived an actual server restart.

## Remaining boundaries

The public Cloud Run deployment still serves the marketing preview and has not been switched to the Postgres-backed API. Next configure runtime secrets and real Google OAuth before deploying that backend. Google authorization/token refresh, actual Gmail writes/unsubscribe, AI provider behavior, and cloud daily job execution remain unverified. NestJS/Prisma and a public-user scale benchmark are not implemented.
