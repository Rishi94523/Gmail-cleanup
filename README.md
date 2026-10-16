# Gmail-cleanup (Inboxclean)

**Status: in development.** This repository contains a local Gmail backend prototype and an interactive React/TypeScript product preview. Google Cloud Run is the selected deployment target; production cloud scheduling and deployment are not implemented yet. No live Gmail validation or thousand-user load test has been completed.

The local backend implements OAuth, cleanup review, reversible label changes, and scheduling. Its 20 automated backend/preview tests use a test-only provider adapter for Gmail actions. Cloudflare deployment files are retained from an earlier hosting exploration; no Cloudflare deployment has been made. See [ARCHITECTURE.md](ARCHITECTURE.md) for the boundary between current implementation and the planned production system.

A calm Gmail cleanup application with a real server-side integration, review-before-cleanup, reversible Gmail label changes, subscription discovery, and a daily maintenance agent. No demo mailbox or fabricated provider results are included.

## Run locally

Requires Node.js 24+. The backend uses Node's built-in SQLite and crypto modules; Playwright is a development dependency for interface verification.

```powershell
npm.cmd ci
npm.cmd run setup
# Open .env in your editor and configure the Google OAuth client below.
npm.cmd start
```

Open http://localhost:3000. Until OAuth is configured, the app shows setup instructions and lets you explore the rules. It cannot read or change Gmail yet. The generated encryption key stays in the ignored `.env` file; do not share or commit it.

The separate public-facing React preview builds with `npm.cmd run check:web` and `npm.cmd run build:web`. Its controls use explicitly labelled example messages and never access Gmail. The local dashboard is served by the Node backend above.

## Configure Google Gmail access

1. Create/select a project in [Google Cloud Console](https://console.cloud.google.com/).
2. Enable **Gmail API** for the project.
3. Configure Google Auth Platform branding, audience, and data access. Request `https://www.googleapis.com/auth/gmail.modify`.
4. While the application is in Testing, add the Gmail address you will connect as a test user.
5. Create an OAuth client of type **Web application**. Set the exact authorized redirect URI to `http://localhost:3000/auth/google/callback`.
6. Set `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` in `.env`. Keep `APP_URL=http://localhost:3000` and the generated `TOKEN_ENCRYPTION_KEY`. Restart the server.
7. Click **Connect Gmail**, grant the requested permission, and review your rules. Nothing is cleaned just by connecting or scanning.

When deploying, use your HTTPS origin for `APP_URL`, add its exact `/auth/google/callback` redirect URI to Google, and supply secrets through the host's secret configuration. Do not paste OAuth secrets into chat or the browser interface.

`gmail.modify` is a restricted scope. Public launch requires Google's applicable verification unless an exception applies, and a server that handles restricted data may require a security assessment. External apps left in Testing generally receive refresh tokens that expire after seven days for these scopes; reconnecting is a development workaround, not a production scheduling solution.

References: [Gmail scopes](https://developers.google.com/workspace/gmail/api/auth/scopes), [server-side OAuth](https://developers.google.com/identity/protocols/oauth2/web-server), [restricted-scope verification](https://developers.google.com/identity/protocols/oauth2/production-readiness/restricted-scope-verification), [refresh-token expiration](https://developers.google.com/identity/protocols/oauth2#expiration).

## Cleanup and undo

- Select promotions, social notifications, and optionally routine updates; choose an age threshold, archive and/or mark-read behavior, and protected email addresses.
- Scan up to **100 messages per batch**. Metadata is fetched with bounded concurrency. Use **Review next batch** to inspect further pages; doing so replaces the current preview without applying it. After applying a cleanup, start a fresh scan because the mailbox query has changed.
- Review individual candidates and explicitly approve a cleanup. Previews expire after one hour and after changes to the saved rules.
- Immediately before each write, the server fetches current metadata and checks the rules again. Starred/important mail and protected senders are excluded. Potentially important subjects, including financial, medical, travel, receipts, security, and account messages, are kept conservatively. This heuristic cannot guarantee perfect classification.
- Archive removes `INBOX` and adds **Cleaned by agent**; optional mark-read removes `UNREAD`. There is no delete endpoint.
- Activity offers undo using persisted per-message label deltas. Unrelated labels survive. Later manual changes to the same labels may be overwritten by an explicit undo; the UI explains this before approval.
- Ambiguous write failures are recorded before the provider request and never automatically replayed. The run exposes undo to reconcile its touched labels. An interrupted run becomes **needs review** after its job lease expires.
- Gmail calls have timeouts. Rate-limit/provider errors stop the current operation and require review; automatic write retries are deliberately absent. Large backlogs need repeated approved batches.

## Subscription requests

**Find subscriptions** inspects the latest 100 inbox messages; cleanup scans also discover mailing lists in older mail. Discovery is bounded, not a claim to enumerate every subscription across the entire account.

For one-click requests the server requires HTTPS, `List-Unsubscribe-Post: List-Unsubscribe=One-Click`, Google's DKIM-pass authentication result, and a matching DKIM signature listing both unsubscribe headers. This relies on Gmail's received metadata and is conservative; unsupported or ambiguous headers are sent to manual Gmail review. The app does not implement its own DKIM verifier.

Every request requires a separate user approval identifying the sender and destination host. The server re-fetches and checks the destination before POST, resolves and pins public IPv4 addresses, rejects private/internal/IP-literal destinations, sends no Google credentials, and refuses redirects. No email-based unsubscribe messages are sent. A successful HTTP response is recorded as **request submitted**, not proof that delivery stopped. Uncertain requests are not retried automatically. Unsubscribe cannot be undone by restoring messages. Protocol reference: [RFC 8058](https://www.rfc-editor.org/rfc/rfc8058.html).

## AI review

Cleanup rules work without a language model. To enable real AI classification, set `AI_API_KEY` to an OpenRouter key and optionally set `AI_MODEL` (default `google/gemini-2.5-flash`), then restart.

The user must explicitly enable AI review in their rules. Only candidate sender addresses and subject lines, up to 30 per model call, are shared with OpenRouter and the selected model provider. Bodies and OAuth tokens are never included. Provider data policies apply; review them before enabling. Message text is untrusted input. Model outputs are validated, missing/ambiguous decisions keep mail, and AI cannot override deterministic protections. A provider error stops the scan without cleanup.

## Daily agent

Enable daily cleanup in saved rules and choose an hour and IANA timezone. This is explicit authorization for future matching cleanup actions; unsubscribe remains separately approved each time.

The **server** checks due accounts every minute, including after startup. A persisted account-local date prevents duplicate daily runs. An account lease prevents overlapping scans, cleanup, unsubscribe, and undo operations. Failed/ambiguous runs are not silently rerun that day; inspect Activity and reconnect or run a new approved scan as appropriate.

Each daily run inspects up to 100 matching messages and cleans only eligible candidates. It does not promise to clear a 30,000-message backlog overnight. If the first batch is entirely protected, use manual pagination to review later batches. Pausing saved rules stops subsequent writes at the next protection check; a request already sent to Gmail can still complete.

The browser can be closed; **the Node process and persistent storage must remain running**. A sleeping laptop, stopped server, or scale-to-zero host will pause scheduling. On restart, one due run may catch up; missed days are not replayed. The scheduler is part of the server, not a browser timer or a configured Codex automation.

## Storage and deployment

`data/inboxclean.sqlite` stores per-account rules, encrypted OAuth tokens, encrypted scan metadata/cleanup deltas, sessions, activity, subscription sender addresses, and job leases. Tokens and email metadata use AES-256-GCM with `TOKEN_ENCRYPTION_KEY`. Account addresses, rules, activity descriptions, and subscription addresses remain ordinary database fields; protect the disk and backups. Keep the encryption key stable and backed up separately from the database. Losing it prevents token recovery and undo.

Sessions use random, hashed tokens and HttpOnly/SameSite cookies (Secure under HTTPS). OAuth state and PKCE bind callbacks to the initiating session. Mutating API routes require both same-origin requests and CSRF tokens. API data is scoped to the session's connected Gmail account. Disconnect pauses jobs, revokes Google access, and deletes that account's local data and undo history; emails themselves remain as previously modified.

A multi-stage Dockerfile builds the React site and serves the **public product preview** on port 8080. It intentionally does not deploy the local SQLite scheduler to Cloud Run. See [deployment instructions](deploy/README.md) for CLI login, project setup, and the rollout plan. No application has been deployed yet.

```powershell
docker build -t inboxclean .
docker run -p 127.0.0.1:8080:8080 inboxclean
```

For internet hosting, put the service behind a TLS reverse proxy, configure the external HTTPS `APP_URL` and OAuth redirect, mount persistent storage, and run one application instance. Add operational alerts, encrypted backups, retention policy, and Google-required privacy/verification materials before a public launch. Mail data is not currently auto-purged while an account remains connected, so disk usage must be managed. This is an initial application, not a completed public SaaS launch.

## Verification

```powershell
npm.cmd test
```

The suite checks actual HTTP routes, OAuth state/PKCE configuration, session parsing, CSRF, encrypted tokens, account isolation, preview approval, write-time protections, duplicate requests, ambiguous writes, undo, pagination, daily idempotency, and unsafe unsubscribe destinations. Service tests use a test-only Gmail adapter; they do not prove Google OAuth, provider email changes, AI provider responses, or live unsubscribe success. These require a configured OAuth client and an explicitly approved connected test mailbox.
