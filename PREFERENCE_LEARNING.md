# Persistent preference learning

Use Postgres as the source of truth, not model conversation history or embeddings. Answers must be explicit, scoped, editable, and traceable. A restart or a different Cloud Run instance must see the same state.

## Stored state

| State | Purpose |
| --- | --- |
| `accounts.rules.agent` | General preferences, action permissions, provider-bound consent, and automatic-unsubscribe permission. |
| `agent_questions` | Encrypted MCQ payload, server-bound broad category key, version, pending/answered state, 30-second deferral deadline, and optional one-day snooze. |
| `preference_memories` | Encrypted general category answer (or legacy sender exception), source question, effective timestamp, and version. Indexed by account and scope hash. |
| `preference_events` | Encrypted record of user answers, edits, and removals. |
| `agent_holds` | Message IDs left unchanged because of uncertainty or because they predate an answer. Holds survive answers, edits, and memory deletion. |
| `agent_discoveries` | Encrypted initial suggestions cached by account, provider, and model. |
| `subscription_actions` | Per-account/list request state recorded before the external unsubscribe POST. Unknown outcomes never automatically retry. |

Questions, learned preferences, and audit records are encrypted with the app key. New question scopes use stable category keys, such as `category:product_announcements`, indexed per account; operational timestamps remain queryable. Every API access is scoped to the authenticated account; answer/edit endpoints also require the existing CSRF protections. Changes use an account lease, a transaction, and version checks to reject stale browser answers. Disconnect removes all these records.

## Agent tool

```json
{
  "name": "ask_preference",
  "arguments": {
    "category": "product_announcements",
    "question": "Do you want product announcements in your inbox?",
    "reason": "Your preferences do not yet explain whether these announcements matter."
  }
}
```

The model selects a supported broad category and supplies context, not an account ID, arbitrary executable rule, unsubscribe URL, or permission. The backend supplies canonical category-level question wording and permitted choices, deduplicated across senders. Product announcements from Apple and another product produce one question, not one per brand. Categories currently cover announcements, sales/discounts, jobs, newsletters, social notifications, events, surveys, and cold outreach. Answered categories are not repeatedly asked. The model cannot save a preference itself. Only a user answer creates preference memory.

The agent immediately leaves the current email alone and continues with other mail. The recorded deadline never becomes permission to act. Unanswered questions remain available when the user returns. The tray serves 20 questions at a time and loads the next pending questions as answers are saved; learned preferences currently display the latest 200.

When the user answers, the preference applies to future arrivals in that category across senders. Protected mail stays protected. If the model cannot confidently classify a category where existing preferences could apply, it leaves the email unchanged. Previously held and pre-answer mail stays unchanged.

Users can separately add exact-sender or domain exceptions with a category and handling choice. For example, the general preference can mark product announcements read, while an exception keeps product announcements from `apple.com`; alternatively an Apple exception can mark them read while the general preference keeps them. Exact sender exceptions take precedence over domain exceptions; category-specific exceptions take precedence over all-mail exceptions. Domain matching checks boundaries, so `evilapple.com` does not match `apple.com`. Deterministic important-mail protections still take precedence. Existing sender/list memories are preserved as narrow exceptions; old sender-specific questions are no longer served. No database schema change is required for category scopes.

Discovery cache keys include this preference-system version so obsolete product-specific suggestions do not persist after the update.

## Automatic unsubscribe

Having List-Unsubscribe does not prove that an email is unwanted marketing. In addition to the user's separate opt-in, require:

1. An AI classification of unwanted pure marketing with confidence at least 0.995. This confidence is model-reported, not validated accuracy.
2. At least two recent messages from the exact sender/List-ID, classified consistently as marketing. Transactional or mixed-purpose evidence blocks automation.
3. No known-person, protected-sender, always-keep, OTP/security/transactional, or wanted-publication protection. Newsletter/blog/Substack evidence blocks automatic requests unless the user explicitly answered for that exact list; transactional evidence always blocks them.
4. Supported HTTPS one-click headers covered by the passing DKIM signature reported by Gmail. URLs come from those headers only; the model cannot choose one.
5. Fresh message context, unchanged preferences, and an active account lease. DNS/IP validation and redirect refusal remain enforced by the existing unsubscribe transport.
6. Persist an uncertain request before sending it. Record accepted requests separately from guaranteed removal; requests are not undoable. Unclear intent becomes a question, not an unsubscribe.

One-message new signup promotions therefore usually generate a question first. Consistent unwanted marketing can be handled automatically on subsequent mail after permission is established. Models still need an evaluation against representative wanted/unwanted mail before broad deployment.

Official references: [Nebius tool calling](https://docs.tokenfactory.nebius.com/ai-models-inference/function-calling), [Google sender guidelines FAQ](https://support.google.com/mail/answer/14229414?hl=en).

Cloud Scheduler/Cloud Tasks execution, live model quality and tool-call compatibility, and production-scale validation remain separate unfinished work. Current automated checks use simulated AI/Gmail/unsubscribe responses, with real Neon used for persistence and HTTP account-isolation checks.

## First free cleanup

Discovery and cleanup share one encrypted sample of up to 100 unread inbox emails. Questions created during initial discovery, before any trial emails have been processed, are explicitly marked as setup questions. Their answers apply to that saved sample and future arrivals. Questions raised during cleanup still hold the current emails; later answers never release those held messages. Editing a learned preference does not release a hold.

Nebius Nemotron authenticated JSON responses and native `ask_preference` tool calls passed synthetic live checks on October 18, 2026. Model decision quality and live unsubscribe outcomes remain unvalidated.
