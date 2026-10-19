# Inbox agent workflow

The free tier uses one persisted sample of up to 100 unread inbox emails for discovery and cleanup. A database allowance reserves each email once before model work; additional and daily cleanups are gated by paid entitlements. Checkout and cloud daily scheduling are not enabled. Initial setup answers can apply to that sample; questions raised during a cleanup still hold emails permanently.

The main dashboard now asks for preferences, then runs the agent without asking the user to select individual messages. The old age/category preview is retained under advanced settings for compatibility; it is no longer the primary flow.

## Implemented agent flow

- Explicit AI-processing consent. Discovery sends sender/subject metadata from up to 100 unread inbox messages to the selected provider and asks for suggestions; it does not change mail or silently enable suggested preferences. Provider changes require renewed consent, and failures never switch providers automatically.
- Preferences for recruiting/job opportunities, cold outreach, people previously emailed, newsletters, interests, exceptions, permitted action, automatic unsubscribe, and daily schedule.
- Default permitted action is mark read. Archive and mark read plus archive are separate choices. Automatic unsubscribe is a separate opt-in, with a supported one-click request and consistent marketing-only list history. No delete, trash, or send tool is available.
- Discovery starts automatically when the user allows AI processing, and caches successful results by account/provider/model. It can create specific questions from the inbox sample in addition to the standard preference suggestions. No discovery happens before consent.
- The model has an actual OpenAI-compatible `ask_preference` function tool. Questions are broad category preferences across senders, with canonical server wording and category deduplication. The agent supplies a supported category, not a brand-specific rule. The server saves an encrypted question and holds the email. It never guesses after a timeout. A 30-second deferral deadline is recorded; unanswered questions remain in the tray until answered or snoozed. Similar mail in a pending category is also held.
- Answers create explicit, versioned, encrypted category preferences with timestamps and an audit trail, applying to future arrivals across senders. Previously held and pre-answer mail stays unchanged. Users can add separate sender/domain exceptions, such as keeping Apple product announcements while marking other announcements read. Preferences and exceptions remain editable. See [PREFERENCE_LEARNING.md](PREFERENCE_LEARNING.md).
- Paid runs collect up to 500 unread inbox message IDs before changes, across internal Gmail pages. It skips persisted assessments for the same preference/model version, allowing subsequent runs to reach further into a backlog without reclassifying kept mail. Enumeration is bounded at 1,000 pages per run. This is not a completed 100,000-message load test.
- Email text is capped at 12,000 characters per decision. Plain-text MIME parts are used; HTML-only mail falls back to Gmail's snippet. Attachments and external resources are not fetched. Incomplete context should produce a keep decision.
- Known people are approximated using sent-mail history, not Google Contacts. This evidence is cached by sender during a run.
- AI returns one permitted action and a reason, or asks a preference question. Invalid responses and unsupported actions become keep; low confidence produces a deferred question. Model-reported confidence is not a calibrated accuracy guarantee; evaluate before broad autonomous use.
- Gmail protections, preference consistency, unread state, and message history are rechecked before writes. Decisions are streamed as newline-delimited JSON; the UI animates only while the request is active and shows real processed counts.
- Changes are recorded before Gmail writes; ambiguous writes are not automatically replayed. Existing undo restores changed labels/read state. Decision history is encrypted and account-scoped; bodies are not retained in that history. Account deletion also clears assessment records.
- Daily local execution uses the same agent when explicitly enabled and the scheduler is active. The current local server was started with scheduling disabled. The UI exposes that fact.

## Configuration

Set the provider in the ignored `.env`, restart the server, then allow AI processing and save preferences in the app. Key presence alone does not authorize processing a connected mailbox.

```dotenv
AI_PROVIDER=nebius
NEBIUS_API_KEY=your-local-key
NEBIUS_MODEL=nvidia/Nemotron-3.5-Super-VL
```

To switch to OpenRouter, change only `AI_PROVIDER=openrouter` and configure `OPENROUTER_API_KEY` and `OPENROUTER_MODEL`. Legacy `AI_API_KEY` / `AI_MODEL` remain OpenRouter-only aliases. Each provider's model and key stay separate; a Nebius selection never reads an OpenRouter key. Nebius uses `https://api.tokenfactory.us-north1.nebius.com/v1/chat/completions`, matching the supplied hackathon example.

`npm.cmd run ai:check` sends one synthetic JSON connectivity request to the selected provider, without reading Gmail. The shared transport requests JSON, rejects incomplete output, uses a 120-second timeout, and redacts provider error bodies. Both discovery and advanced/autonomous decisions use it. Jev's typed decision API is a future adapter/evaluation task; changing to OpenRouter alone does not implement Jev support.

Nebius reference: https://docs.tokenfactory.nebius.com/ai-models-inference/json . Nemotron JSON-mode authentication and native `ask_preference` tool calls passed live synthetic checks on October 18, 2026; this is not a model-quality evaluation.

Run `npm.cmd run db:migrate` before starting this version against Postgres. Migration 004 adds the persistent free allowance, per-email reservations, and encrypted first-run sample. Migration 002 adds an assessment ledger; migration 003 adds questions, memories, audit events, held messages, subscription request state, and cached discovery. The existing encrypted plans/changes/runs tables hold decision history and undo records.

## Remaining work

- Cloud Tasks workers and Cloud Scheduler dispatch, bounded runtime/cost budgets, incremental Gmail history checkpoints, recovery and account cancellation across restarts. The current agent runs in a streamed HTTP request, not a durable queued job.
- Live validation of automatic unsubscribe and subscription intent classification. The implementation requires opt-in, at least two same-list messages classified as pure unwanted marketing, no transactional evidence or wanted publication, and supported authenticated one-click headers. Ambiguous requests are never replayed. Explicit learned list preferences still cannot bypass transactional protections. Unsubscribe cannot be reversed by undo.
- Model evaluation on a labeled dataset: important-mail false-clear rate first, then decision coverage, latency, and cost. Compare OpenRouter's configured model with Jev using the same preferences/content and permission gate. Include interviews, relevant LinkedIn mail, known correspondents, wanted newsletters, unwanted subscriptions, cold pitches, HTML-only/truncated emails, and malicious instructions inside emails. Jev has not been integrated or benchmarked.
- Public privacy/data-retention policy, restricted-scope OAuth verification, paid checkout, and multi-user load testing. The Cloud Run backend serves the landing page, OAuth, and `/app`; daily scheduling is deliberately disabled.

Official Jev sources reviewed: https://typesafe.ai/ and https://docs.typesafe.ai/introduction/quickstart . Its typed decision interface is relevant to classification; vendor confidence/price claims are not a substitute for this application's evaluation.

## Verification

`npm.cmd run build`, `npm.cmd test`, `node scripts/qa-agent.mjs`, and `node --env-file=data/neon-test.env scripts/verify-neon.mjs` cover compilation, agent permissions and uncertainty, tool calls, future-only preference learning, unsubscribe safeguards, desktop/mobile MCQ/edit flows, and question/memory persistence and undo on a real isolated Neon branch. Gmail, model responses and unsubscribe networking are fixtures in these checks. No live mailbox cleanup, live unsubscribe, or real model accuracy has been validated by them.

## Independent topic actions

New onboarding enables `agent.topicActions`. Each discovered topic offers keep, mark read, archive, both, and decide later. Category memories carry the independently authorized action; the final screen reviews each one instead of rewriting them all to a global action. Unclassified topics stay untouched. The examples in the discovery prompt are not a fixed question list: new `topic_` slugs require cited source evidence. First-run question wording is generated for the available handling choices. Legacy manual settings remain compatible.

The October 19 failure was reproduced read-only: the provider returned HTTP 200 with `finish_reason=length` after the app's 4096-token completion cap. Disabling reasoning temporarily avoided that truncation. At the user's request, both the app-imposed token cap and the reasoning override were subsequently removed. Requests now use provider/model defaults for output budgets and reasoning. Provider limits and the HTTP timeout still apply; incomplete responses cannot authorize mailbox writes. This change does not replay mailbox writes or change the free tier's 100-email allowance.
