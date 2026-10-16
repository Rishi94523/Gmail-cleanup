# Inbox agent workflow

The main dashboard now asks for preferences, then runs the agent without asking the user to select individual messages. The old age/category preview is retained under advanced settings for compatibility; it is no longer the primary flow.

## Implemented locally

- Explicit AI-processing consent. Discovery sends sender/subject metadata from up to 40 inbox messages to the selected provider and asks for suggestions; it does not change mail or silently enable suggested preferences. Provider changes require renewed consent, and failures never switch providers automatically.
- Preferences for recruiting/job opportunities, cold outreach, people previously emailed, newsletters, interests, exceptions, permitted action, and daily schedule.
- Default permitted action is mark read. Archive and mark read plus archive are separate choices. No delete, trash, send, or automatic unsubscribe tool is available to this agent.
- Each run collects up to 500 unread inbox message IDs before changes, across internal Gmail pages. It skips persisted assessments for the same preference/model version, allowing subsequent runs to reach further into a backlog without reclassifying kept mail. Enumeration is bounded at 1,000 pages per run. This is not a completed 100,000-message load test.
- Email text is capped at 12,000 characters per decision. Plain-text MIME parts are used; HTML-only mail falls back to Gmail's snippet. Attachments and external resources are not fetched. Incomplete context should produce a keep decision.
- Known people are approximated using sent-mail history, not Google Contacts. This evidence is cached by sender during a run.
- AI returns one permitted action and a reason. Invalid responses, unsupported actions, or confidence below 0.98 become keep. Model-reported confidence is not a calibrated accuracy guarantee; evaluate before broad autonomous use.
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

Nebius reference: https://docs.tokenfactory.nebius.com/ai-models-inference/json . Live Nemotron JSON-mode support and account access must be verified once the key is present.

Run `npm.cmd run db:migrate` before starting this version against Postgres. Migration 002 adds an assessment ledger; the existing encrypted plans/changes/runs tables hold decision history and undo records.

## Remaining work

- Cloud Tasks workers and Cloud Scheduler dispatch, bounded runtime/cost budgets, incremental Gmail history checkpoints, recovery and account cancellation across restarts. The current agent request is local server execution, not a durable Cloud Run job.
- Subscription intent and newly detected subscription history. Keep approval for unsubscribe until sender-specific exceptions, explicit authorization, supported one-click mechanisms, and uncertainty handling are implemented. Unsubscribe cannot be reversed by undo.
- Connect-time discovery should begin after the user permits third-party AI processing. Currently OAuth returns to Preferences, where the user explicitly starts discovery.
- Model evaluation on a labeled dataset: important-mail false-clear rate first, then decision coverage, latency, and cost. Compare OpenRouter's configured model with Jev using the same preferences/content and permission gate. Include interviews, relevant LinkedIn mail, known correspondents, wanted newsletters, unwanted subscriptions, cold pitches, HTML-only/truncated emails, and malicious instructions inside emails. Jev has not been integrated or benchmarked.
- Public privacy/data-retention policy, restricted-scope OAuth verification, production backend deployment, and multi-user load testing. The existing public Cloud Run URL still serves the previous preview.

Official Jev sources reviewed: https://typesafe.ai/ and https://docs.typesafe.ai/introduction/quickstart . Its typed decision interface is relevant to classification; vendor confidence/price claims are not a substitute for this application's evaluation.

## Verification

`npm.cmd run build`, `npm.cmd test`, `node scripts/qa-agent.mjs`, and `node --env-file=data/neon-test.env scripts/verify-neon.mjs` cover compilation, agent permissions and uncertainty, desktop/mobile preference/stream flows, and persistence/undo on a real isolated Neon branch. Gmail and AI are fixtures in these checks. No live mailbox cleanup or real model accuracy has been validated by them.
