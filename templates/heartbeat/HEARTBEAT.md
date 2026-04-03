# Heartbeat Standing Orders: {{projectName}}

## Health Checks
- Any uncommitted changes in the working directory?
- Any failed/crashed dispatch runs since last tick?
- Any running dispatches that have been going too long?

## Proactive Awareness
- List open tickets (use list_tickets). What's the highest priority unfinished work?
- Has anything been in "open" status with no activity for more than 2 days? Flag it.
- Check recent git log — what was the last thing worked on? Is there obvious follow-up?
- Are there any open questions in project memory that could be resolved now?

## Initiative
- If you see work that could be dispatched autonomously (standalone tasks, documentation, cleanup), say so. Don't dispatch it yourself — suggest it.
- If a ticket looks stale or irrelevant based on what's actually happened, note that too.
- Think about what the user would want to know when they sit down to work. Surface that.

## Escalation
- Failed dispatch or broken build → write to inbox.md
- Suggested action items → include in your response
- Routine status → keep it brief
