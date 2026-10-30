# Clean My Inbox

A Gmail agent that learns what matters to you, then marks low-priority email as read or archives it. Built for the **Nebius × NVIDIA Global AI Hackathon**, using **NVIDIA Nemotron 3.5 Super VL through Nebius Token Factory**.

[Live app](https://gmail-cleanup-web-450826266929.us-central1.run.app) · [Architecture](ARCHITECTURE.md) · [Cloud deployment](deploy/README.md)

## What it does

1. Connect Gmail and allow AI processing.
2. The agent learns from subjects, senders and dates in your latest **100 unread Primary emails** and asks a few broad preference questions.
3. Choose keep, mark read, archive, both, or write your own answer—independently for each topic.
   A final **“Anything else we should know?”** step accepts extra instructions or background before cleanup. The agent previews written preferences for confirmation; you can also skip it.
4. During cleanup, the model reads email text and makes decisions using those preferences. Clearly low-priority mail that fits none of your topics (promotions, welcome emails, credit reminders) still gets your general “When an email doesn’t matter” action when the model is confident. Important or uncertain emails stay unchanged. **Nothing is deleted.**
5. Unclear patterns become questions in your workspace. Answering saves the preference and immediately rechecks only the emails held for that question. Both manual and daily cleanup apply current preferences to older and newer emails; only explicit topic-specific age conditions restrict age. Unanswered questions stay protected. You can edit preferences and sender exceptions later.
6. Daily cleanup turns on when setup finishes; turn it off in Preferences at any time. Choose a start time, timezone, and 1–3 cleanups per day, evenly spaced from the start time (3 a day from 09:00 runs at 09:00, 17:00 and 01:00). You can also run cleanup manually. Pause daily runs for 1 day, 1 week, 1 month (30 days), or until you resume. Timed pauses expire automatically and manual cleanup remains available. The hackathon edition includes repeat runs and daily cleanup, with up to 100 Primary emails per run.

The landing page has a looping, pausable animation of questions and inbox decisions. It uses example mail, not your Gmail.

The Preferences page shows a compact, searchable list with expandable editors. Add or change preferences in plain language, review the proposed topic actions and conditions, then save. Background notes help interpret your interests without granting cleanup permission. Preferences and notes are encrypted and remain editable; Standalone preference edits do not start a general cleanup. If confirmed written instructions answer a pending question, only that question’s held emails are rechecked immediately. Other eligible mail is handled by manual or daily runs. Preference save dates never restrict email eligibility.

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
npm run ai:benchmark
```

`ai:check` uses a synthetic prompt without Gmail access. Tests cover permissions, account isolation, Primary-only queries, learned preferences, daily idempotency, uncertain writes, undo, unsubscribe validation and scheduler authentication. Browser QA uses fixture APIs; no real email modifications are claimed by those tests.

OAuth refresh tokens, email context and preference memories are encrypted at rest. Discovery sends **no bodies**; cleanup sends up to **12,000 characters** of extracted email text per decision, without attachments. Each model request permits up to 50,000 output tokens. Prompt caching is automatic on the configured Nebius endpoint; diagnostic logs contain timings and token counts, not email contents or credentials.

### Prompt caching and model speed

[Nebius prompt caching](https://docs.tokenfactory.nebius.com/cached-tokens) is implicit and best-effort: no opt-in flag, explicit cache marker, or TTL is needed. Clean My Inbox puts stable instructions first, then shared user preferences, then individual emails. Discovery dates and user notes are separate from system instructions. Identical batch-wide context is sent once; email-specific instructions and exceptions remain attached to their email. Existing logs report `cachedPromptTokens` from the API, so a zero-hit request remains visible rather than being assumed cached.

`npm run ai:benchmark` makes three streaming requests per model (Super 3.5 VL and Ultra 3), using the same ten synthetic emails and the production prompt/request builders. It never reads the database or Gmail. It records first-token latency, time to visible JSON, total duration, provider-reported token counts, approximate generation tokens/second and cache hits in ignored `data/nebius-benchmark-*.json` files. Super uses the application's medium reasoning setting; Ultra uses its provider default. Repeats test prefix reuse, but the first call is not guaranteed cold. Streaming token speed includes reasoning tokens when reported and does not measure classification accuracy, production capacity, or the whole Gmail cleanup. Set `BENCHMARK_ROUNDS` to 1–10 to change the request count; inference uses your normal API credits.

## Submission and remaining work

Public disclosures are available without login at [Privacy policy](https://cleanmyinbox.space/privacy) and [Terms of service](https://cleanmyinbox.space/terms), with links in both footers and before AI consent. They describe the implemented Gmail actions, Nebius inference, current retention, account deletion, and unsubscribe/undo limitations. The contact is the existing support address, `rishidv2005@gmail.com`. Review these disclosures whenever providers, retention, pricing or features change; publishing them is not Google verification or a legal compliance certification.

The display brand is **Clean My Inbox** on `cleanmyinbox.space`. The homepage includes a descriptive title, canonical URL, social metadata, and a sitemap. The robots file excludes workspace/auth/API routes from crawling; it is not an access-control mechanism.

This public repository is the hackathon source. Keep a tag pointing to the exact submitted commit; build a separate private repository later if commercial/payment work needs to stay private.

The live OAuth app currently accepts configured Google test users. Public Gmail onboarding still needs Google's applicable verification process. Payment checkout, browser-based unsubscribe and bulk backlog processing are outside this hackathon version. The repository includes an open-source license as required by the [official rules](https://nebiusglobalaihackathon.devpost.com/rules). The landing animation is illustrative; use a recording of the working application for submission and complete the event's required feedback.

## License

Copyright © 2026 Rishi (Rishi94523).

Original project source code in this repository is licensed under the **GNU Affero General Public License, version 3 only** (`AGPL-3.0-only`). See [LICENSE](LICENSE) for the complete, unmodified license text. Third-party dependencies, models, and services retain their own licenses and terms.

AGPL permits commercial use, modification and redistribution, with strong copyleft obligations. In particular, someone who modifies this application and makes that modified version available for remote network interaction must offer its corresponding source to those users under AGPL. This is stronger protection for a web application than MIT, Apache 2.0, MPL 2.0, or GPL's distribution-triggered copyleft; it is not a ban on commercial use.

The existing release remains available under its granted license even if later versions are developed privately. The license does not grant rights to third-party trademarks or imply endorsement by Google, NVIDIA, or Nebius.
