# Persistent preference learning

Use Postgres as the source of truth, not model conversation history or embeddings. Answers must be explicit, scoped, editable, and traceable. A restart or a different Cloud Run instance must see the same state.

## Stored state

| State | Purpose |
| --- | --- |
| `accounts.rules.agent` | General preferences, action permissions, provider-bound consent, and automatic-unsubscribe permission. |
| `agent_questions` | Encrypted MCQ payload, server-bound sender/list scope hash, version, pending/answered state, 30-second deferral deadline, and optional one-day snooze. |
| `preference_memories` | Encrypted user answer and scope, source question, effective timestamp, and version. Indexed by account and scope hash. |
| `preference_events` | Encrypted record of user answers, edits, and removals. |
| `agent_holds` | Message IDs left unchanged because of uncertainty or because they predate an answer. Holds survive answers, edits, and memory deletion. |
| `agent_discoveries` | Encrypted initial suggestions cached by account, provider, and model. |
| `subscription_actions` | Per-account/list request state recorded before the external unsubscribe POST. Unknown outcomes never automatically retry. |

Questions, learned preferences, and audit records are encrypted with the app key. Scope hashes and operational timestamps remain queryable. Every API access is scoped to the authenticated account; answer/edit endpoints also require the existing CSRF protections. Changes use an account lease, a transaction, and version checks to reject stale browser answers. Disconnect removes all these records.

## Agent tool

```json
{
  "name": "ask_preference",
  "arguments": {
    "question": "Would you like to keep announcements from this product?",
    "reason": "These look promotional, but your subscription intent is unclear."
  }
}
```

The model supplies wording, not an account ID, arbitrary executable rule, unsubscribe URL, or permission. The backend binds the question to the current sender and List-ID where present, deduplicates questions, and generates the choices from the user's permitted actions. The model cannot save a preference itself. Only a user answer creates preference memory.

The agent immediately leaves the current email alone and continues with other mail. The recorded deadline never becomes permission to act. Unanswered questions remain available when the user returns. The tray serves 20 questions at a time and loads the next pending questions as answers are saved; learned preferences currently display the latest 200.

When the user answers, the preference applies to messages arriving after that answer. Protected mail still stays protected, and a learned answer cannot expand the global action permission. Exact sender/list scope intentionally avoids generalizing a user's answer across unrelated senders. General interests and exceptions remain editable in Preferences.

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
