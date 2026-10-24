# Inboxclean

A Gmail agent that learns what matters to you, then marks low-priority email as read or archives it. Built for the **Nebius × NVIDIA Global AI Hackathon**, using **NVIDIA Nemotron 3.5 Super VL through Nebius Token Factory**.

[Live app](https://gmail-cleanup-web-450826266929.us-central1.run.app) · [Architecture](ARCHITECTURE.md) · [Cloud deployment](deploy/README.md)

## What it does

1. Connect Gmail and allow AI processing.
2. The agent learns from subjects, senders and dates in your latest **100 unread Primary emails** and asks a few broad preference questions.
3. Choose keep, mark read, archive, both, or write your own answer—independently for each topic.
   A final **“Anything else we should know?”** step accepts extra instructions or background before cleanup. The agent previews written preferences for confirmation; you can also skip it.
4. During cleanup, the model reads email text and makes decisions using those preferences. Important or uncertain emails stay unchanged. **Nothing is deleted.**
5. Unclear patterns become questions in your workspace. Answers are saved without automatically changing held mail. Both manual and daily cleanup apply current preferences to older and newer emails; only explicit topic-specific age conditions restrict age. Unanswered questions stay protected. You can edit preferences and sender exceptions later.
6. Enable a daily routine with your time and timezone, or run cleanup manually. Pause daily runs for 1 day, 1 week, 1 month (30 days), or until you resume. Timed pauses expire automatically and manual cleanup remains available. The hackathon edition includes repeat runs and daily cleanup, with up to 100 Primary emails per run.

The landing page has a looping, pausable animation of questions and inbox decisions. It uses example mail, not your Gmail.

The Preferences page shows a compact, searchable list with expandable editors. Add or change preferences in plain language, review the proposed topic actions and conditions, then save. Background notes help interpret your interests without granting cleanup permission. Preferences and notes are encrypted and remain editable; saving alone does not run cleanup. The next manual or daily run can reconsider resolved holds using the current preferences. Preference save dates never restrict email eligibility.

AI processing permission is collected during onboarding and retained on the account; settings do not repeat that checkbox. Pause daily runs without withdrawing setup permission, or disconnect Gmail from account settings to revoke access and remove account data. Daily scheduling has one control section; the obsolete separate AI filter permission is no longer shown.

## Run locally

Requires Node.js **24+** and a Nebius Token Factory API key.

```sh
npm ci
npm run setup
```

Edit the generated, ignored `.env` file:

```dotenv
GOOGLE_CLIENT_ID=your-google-web-client-id
GOOGLE_CLIENT_SECRET=your-google-web-client-secret
NEBIUS_API_KEY=your-nebius-token-factory-key
```

`npm run setup` generates `TOKEN_ENCRYPTION_KEY`. Keep that key stable. The template enables hackathon mode and the local daily timer, and selects `nvidia/Nemotron-3.5-Super-VL`. **This edition has no alternate AI provider or fallback.**

In your Google Cloud project, enable the **Gmail API**, configure an external OAuth consent screen, add your account as a test user, and create a **Web application** OAuth client with this authorized redirect URI:

```text
http://localhost:3000/auth/google/callback
```

```sh
npm run build
npm start
```

Open [localhost:3000](http://localhost:3000). SQLite is used locally; no database account is required. For Neon/PostgreSQL, set `DATABASE_URL` and a direct `DATABASE_URL_UNPOOLED`, then run `npm run db:migrate` before starting.

Daily cleanup is opt-in. Locally, leave the Node process running. On Cloud Run, the authenticated Cloud Scheduler setup in [deploy/README.md](deploy/README.md) wakes the service even after it scales to zero.

## Unsubscribe

Subscriptions show a sender name, address, and example email. Confirming **Unsubscribe** submits the sender’s verified one-click request directly from the app. “Request accepted” does not guarantee that delivery has stopped; senders can take a few days. Requests with uncertain outcomes are not automatically replayed.

The AI can also request automatic unsubscribe when you explicitly enable it. It requires clear unwanted marketing intent, signed one-click headers, and consistent sender history. OTPs, financial/security notices, wanted publications and uncertain cases are protected. Interactive unsubscribe pages remain manual; arbitrary browser automation is not part of this release.

## Stack and validation

React + TypeScript + Vite; Node.js HTTP API; PostgreSQL on Neon (SQLite locally); Google OAuth with PKCE and Gmail API; NVIDIA Nemotron via Nebius Token Factory; Docker, Google Cloud Run, Secret Manager and Cloud Scheduler.

```sh
npm test
npm run build
npm run ai:check
```

`ai:check` uses a synthetic prompt without Gmail access. Tests cover permissions, account isolation, Primary-only queries, learned preferences, daily idempotency, uncertain writes, undo, unsubscribe validation and scheduler authentication. Browser QA uses fixture APIs; no real email modifications are claimed by those tests.

OAuth refresh tokens, email context and preference memories are encrypted at rest. Discovery sends **no bodies**; cleanup sends up to **12,000 characters** of extracted email text per decision, without attachments. Each model request permits up to 50,000 output tokens. Prompt caching is automatic on the configured Nebius endpoint; diagnostic logs contain timings and token counts, not email contents or credentials.

## Submission and remaining work

This public repository is the hackathon source. Keep a tag pointing to the exact submitted commit; build a separate private repository later if commercial/payment work needs to stay private.

The live OAuth app currently accepts configured Google test users. Public Gmail onboarding still needs Google's applicable verification process. Payment checkout, browser-based unsubscribe and bulk backlog processing are outside this hackathon version. The [official rules](https://nebiusglobalaihackathon.devpost.com/rules) also require an open-source license. License selection is pending; this must be resolved before submission. A real submission demo video and the event's required feedback must be prepared separately; the landing animation is an illustrative product demo.
