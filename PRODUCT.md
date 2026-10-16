# Inboxclean

A Gmail agent that learns what matters to a person and maintains their unread inbox using AI decisions and explicit permissions. See [AGENT_WORKFLOW.md](AGENT_WORKFLOW.md) for implemented behavior and remaining boundaries.

## First-use flow

1. Connect Gmail through Google OAuth.
2. Ask permission for AI processing, then learn from a sample of the inbox.
3. Suggest preferences for jobs, outreach, known people, and subscriptions.
4. Confirm interests, exceptions, and permitted actions once.
5. Start the agent; show actual decisions and progress instead of requiring message-by-message review.
6. Show a summary and undo, with daily execution once scheduling is configured.

## Defaults

- Mark low-priority unread mail as read by default. Archive only when separately permitted; never delete.
- AI decisions use user context rather than treating age or a Gmail category as sufficient permission.
- Protect starred/important mail and user-approved senders. Treat personal messages, financial/legal/security mail, bookings, and receipts conservatively; age alone is insufficient.
- Queue uncertain classifications for review.
- Require approval for unsubscribe requests; separately allow sender-specific future automation.
- Never permanently delete mail in the first version.
- Preserve each message's previous labels and unread state for undo. Explain that unsubscribe cannot be undone by restoring labels.

## Daily agent

Use a server-side schedule, encrypted OAuth refresh tokens, a per-account job lock, bounded batches, retry/backoff, and persisted checkpoints. Process messages since the last successful checkpoint, recheck protections before writes, and record per-message results. A closed browser must not stop the agent. Pausing revokes future job execution; disconnecting also removes stored credentials.

Daily activity should show what was archived, marked read, suggested for unsubscribe, skipped, or failed. Do not report an unsubscribe as complete merely because a request was submitted.

## Unsubscribe behavior

Prefer supported List-Unsubscribe/List-Unsubscribe-Post mechanisms. Email-based requests and external website flows require a separate implementation and authorization. Validate destinations, block private/internal network targets, treat message content as untrusted data, and never execute instructions found inside email. Do not open arbitrary unsubscribe links automatically. Unsupported senders remain available for manual review.

## Implementation boundary

A browser-local interactive demo can validate the interface, rules, review, and undo. It cannot connect Gmail, classify real mail, execute real unsubscribe requests, or run while closed. A production app needs an authenticated backend, per-user durable storage, Google OAuth configuration, a classification service, scheduling, and operational monitoring.

## Primary references

- Gmail scopes: https://developers.google.com/workspace/gmail/api/auth/scopes
- Restricted scope verification: https://developers.google.com/identity/protocols/oauth2/production-readiness/restricted-scope-verification
- Gmail message changes: https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages/batchModify
- Gmail subscription management: https://support.google.com/mail/answer/15621070
