# Gmail-cleanup (Inboxclean)

[Open Inboxclean](https://gmail-cleanup-web-450826266929.us-central1.run.app). The Cloud Run service serves the React landing page, Google OAuth, and the Gmail dashboard at `/app`, backed by Neon PostgreSQL. New accounts receive one free cleanup of up to 100 unread inbox emails. Daily and additional cleanups require a server-controlled paid entitlement; checkout and cloud daily scheduling are not enabled yet.

The first connection opens a focused screen without the workspace sidebar. It asks for AI consent, shows an animated analysis state, presents one inbox-grounded question at a time, and saves an independent keep/read/archive/both action for each topic, then reviews those actions before cleanup. It resumes unanswered questions after a refresh. The workspace appears after completion.

The free first-run flow is: connect Gmail, explicitly allow AI processing, discover preferences from a saved sample of up to 100 emails, answer broad questions, then authorize cleanup. The same sample is used for cleanup. Important and uncertain mail stays; eligible mail is marked read, archived, or both according to saved permissions. An exhausted allowance cannot be reset by reloading, changing preferences, undoing a run, or reconnecting. Ambiguous failures consume a reservation rather than replaying model calls. The encrypted sample is removed on disconnect; hashed quota and message-use records remain to prevent repeated free trials.

A Gmail agent with editable preferences, persistent questions for uncertain mail, reversible label/read changes, and separately permitted intelligent unsubscribe. It learns from explicit answers and leaves held emails unchanged. See [PREFERENCE_LEARNING.md](PREFERENCE_LEARNING.md) for storage and behavior. No fabricated mailbox results are shown in the app.

## Run locally

Requires Node.js 24+. The backend uses `pg` for PostgreSQL, Node crypto, and an optional local SQLite adapter. Playwright is a development dependency for interface verification.

```powershell
npm.cmd ci
npm.cmd run setup
# Open .env in your editor and configure the Google OAuth client below.
npm.cmd start
```

Open http://localhost:3000. Until OAuth is configured, the app shows setup instructions and lets you explore the rules. It cannot read or change Gmail yet. The generated encryption key stays in the ignored `.env` file; do not share or commit it.

The public-facing React landing page builds with `npm.cmd run check:web` and `npm.cmd run build:web`. Its controls use explicitly labelled example messages and never access Gmail. Its Connect Gmail button starts Google OAuth. The dashboard is served by the same Node backend; set `SERVE_LANDING=true` locally to serve the landing page at `/` and the dashboard at `/app`.

## Neon Postgres

`neon.ts` declares the Postgres-only setup. The ignored `.neon` file links the selected project/branch; `neon deploy` applies its policy and pulls `DATABASE_URL`, `DATABASE_URL_UNPOOLED`, and `NEON_BRANCH` into `.env` (or `.env.local`). Both files are supported by the app scripts. Never put database URLs in frontend `VITE_*` variables or commit them.

The application reuses a small `pg.Pool` with the pooled URL. Versioned migrations use the direct URL and a transaction/advisory lock. TLS certificate verification is explicit for Neon, with channel binding enabled. Cloud Run startup refuses local SQLite, and the local timer is disabled automatically in Cloud Run; production daily processing still requires Cloud Tasks/Scheduler.

```powershell
neon.cmd deploy
npm.cmd run db:migrate
npm.cmd run build
npm.cmd start
```

Test schema changes on an expiring Neon branch first. The initial migration was validated that way before application to production. Existing local SQLite data is not automatically copied into Neon; no mailbox/account records were migrated during setup. See [NEON_SETUP.md](NEON_SETUP.md) for the real database verification commands and results.

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

Manual requests require sender-specific approval. Automatic requests require a separate saved opt-in plus consistent unwanted marketing history on an authenticated list; OTPs, transactional/mixed-purpose lists, known people, and wanted publications are excluded. Unclear intent creates a question and leaves mail unchanged. The server re-fetches context before POST, resolves and pins public IPv4 addresses, rejects private/internal/IP-literal destinations, sends no Google credentials, and refuses redirects. No email-based unsubscribe messages are sent. A successful HTTP response is recorded as **request submitted**, not proof that delivery stopped. Uncertain requests are not retried automatically. Unsubscribe cannot be undone by restoring messages. Protocol reference: [RFC 8058](https://www.rfc-editor.org/rfc/rfc8058.html).

## AI review

The main agent uses AI to decide what matters. Set `AI_PROVIDER=nebius`, `NEBIUS_API_KEY`, and `NEBIUS_MODEL=nvidia/Nemotron-3.5-Super-VL` for the hackathon. Alternatively use `AI_PROVIDER=openrouter`, `OPENROUTER_API_KEY`, and `OPENROUTER_MODEL` (default `google/gemini-2.5-flash`). Legacy `AI_API_KEY` / `AI_MODEL` still work for OpenRouter only. Restart after changing providers. See [AGENT_WORKFLOW.md](AGENT_WORKFLOW.md) for the agent flow and remaining boundaries.

The user must explicitly allow AI processing for the selected provider. Discovery shares sender addresses, subjects, sent/received dates, calculated ages and body excerpts, together with the current clock and account timezone. The autonomous agent also shares capped email text, up to 12,000 characters per decision. Advanced batch review shares sender/subject metadata only. Attachments and OAuth tokens are excluded. Provider data policies apply. Message text is untrusted input; invalid or uncertain decisions keep mail, and AI cannot override deterministic protections or escalate the permitted action. A provider error stops remaining work; confirmed earlier changes remain in Activity with undo. The app never silently falls back to a different provider. Run `npm.cmd run ai:check` for a synthetic connectivity test without Gmail access.

## Daily agent

Daily cleanup is reserved for paid entitlements and is disabled on the Cloud Run release. The following local scheduler behavior applies only to a paid account on a continuously running local server: enable daily cleanup in saved rules and choose an hour and IANA timezone. This is explicit authorization for future matching cleanup actions; unsubscribe remains separately approved each time.

The **server** checks due accounts every minute, including after startup. A persisted account-local date prevents duplicate daily runs. An account lease prevents overlapping scans, cleanup, unsubscribe, and undo operations. Failed/ambiguous runs are not silently rerun that day; inspect Activity and reconnect or run a new approved scan as appropriate.

Each daily run inspects up to 100 matching messages and cleans only eligible candidates. It does not promise to clear a 30,000-message backlog overnight. If the first batch is entirely protected, use manual pagination to review later batches. Pausing saved rules stops subsequent writes at the next protection check; a request already sent to Gmail can still complete.

The browser can be closed; **the Node process and persistent storage must remain running**. A sleeping laptop, stopped server, or scale-to-zero host will pause scheduling. On restart, one due run may catch up; missed days are not replayed. The scheduler is part of the server, not a browser timer or a configured Codex automation.

## Storage and deployment

The configured Neon PostgreSQL database stores per-account rules, encrypted OAuth tokens, encrypted scan metadata/cleanup deltas, sessions, activity, subscription sender addresses, and job leases. Without `DATABASE_URL`, local development uses `data/inboxclean.sqlite` instead. Tokens and email metadata use AES-256-GCM with `TOKEN_ENCRYPTION_KEY`. Account addresses, rules, activity descriptions, and subscription addresses remain ordinary database fields; protect database access and backups. Keep the encryption key stable and backed up separately from the database. Losing it prevents token recovery and undo.

Sessions use random, hashed tokens and HttpOnly/SameSite cookies (Secure under HTTPS). OAuth state and PKCE bind callbacks to the initiating session. Mutating API routes require both same-origin requests and CSRF tokens. API data is scoped to the session's connected Gmail account. Disconnect pauses jobs, revokes Google access, and deletes that account's local data and undo history; emails themselves remain as previously modified.

A multi-stage Dockerfile builds the React site and runs `server/index.js` on port 8080. The deployment script stores OAuth credentials, the stable token-encryption key, the pooled Neon URL, and the selected AI key as version-pinned Google Secret Manager bindings. The runtime identity gets access only to those secrets. Local `.env` files and mailbox data are excluded from Docker and Cloud Build contexts. The process-local scheduler is disabled on Cloud Run. See [deployment instructions](deploy/README.md).

Google OAuth currently operates with configured test users. Public OAuth verification, paid checkout, Cloud Tasks/Scheduler, operational hardening, retention controls, and thousand-user load validation remain future work.

## Verification

```powershell
npm.cmd test
```

The suite checks actual HTTP routes, OAuth state/PKCE configuration, session parsing, CSRF, encrypted tokens, account isolation, preview approval, write-time protections, duplicate requests, ambiguous writes, undo, pagination, daily idempotency, and unsafe unsubscribe destinations. Service tests use a test-only Gmail adapter; they do not prove Google OAuth, provider email changes, AI provider responses, or live unsubscribe success. These require a configured OAuth client and an explicitly approved connected test mailbox.

Topic questions are generated from sender/subject and body excerpts in the actual 100-message sample. Discovery analyzes groups of 25 concurrently (two at a time), then merges evidence-backed questions across the sample. Job alerts and newsletters are examples, not mandatory questions; the model may introduce a new broad `topic_` category with an exact source quote. Cleanup uses batches of ten independent email decisions, with at most two concurrent AI requests. Topic actions stay independent, and mail without a matching saved preference stays untouched. AI output budgets and reasoning use provider/model defaults; the app imposes no completion token cap. A zero-change free trial offers one explicitly authorized reassessment of its original sample, preserving preferences and lifetime quota. Provider errors and mail awaiting review are reported separately from deliberate keeps.
