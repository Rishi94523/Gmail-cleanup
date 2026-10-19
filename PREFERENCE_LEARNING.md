# Preference learning

Questions concern broad topics across senders, such as product announcements or routine notices. The model cites actual inbox evidence and explains it in ordinary language. Sender/domain exceptions are configured separately.

Answers save an encrypted topic action (`keep`, `read`, `archive`, or `both`), optional age threshold, original typed conditions, version, and effective timestamp. Typed answers are interpreted first, shown for confirmation, then saved. Sensitive old bank/login notices require their own explicit age-based preference; urgent or unresolved notices stay protected.

During cleanup, `ask_preference` immediately holds the current email, queues one question per broad topic and continues with other messages. It never waits for a browser response. Matching held emails remain untouched. Answering later guides future cleanups and does not automatically revisit the earlier held messages. Preferences and exceptions can be edited in the workspace.

Initial onboarding answers can authorize the frozen initial sample before cleanup begins. After cleanup starts, even an older unanswered onboarding question becomes future-only. Cleanup history and quota records are never silently reset.
