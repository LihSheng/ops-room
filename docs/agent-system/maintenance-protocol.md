# Maintenance Protocol

Use this protocol when updating `AGENTS.md`, `AGENT.md`, `CLAUDE.md`, or any file under `docs/agent-system/`.

## Ownership Rules

### Agents may update autonomously

Agents may update these when the change is narrow, evidence-based, and directly connected to a recent task:

- `docs/agent-system/quick-diagnosis.md`
- `docs/agent-system/delegation-templates.md`
- `docs/agent-system/maintenance-protocol.md`
- `docs/agent-system/future-session-letter.md`

Examples:

- Add a repeated failure mode after it happened twice.
- Improve a prompt template with a missing acceptance criterion.
- Add a verification command discovered from the repo.

### Ask the user before editing

Ask before changing:

- Core behavior or philosophy in `AGENTS.md`
- Escalation policy in `docs/agent-system/model-orchestration.md`
- Quality floor rules in `docs/agent-system/judgment-rubric.md`
- Any instruction that changes which agent/model/person owns final decisions
- Any instruction that would increase cost, runtime, permissions, or production risk

Exception: typo fixes and broken path fixes can be made in a PR without asking first.

## Required Update Process

1. Identify the concrete failure or improvement.
2. Locate the smallest instruction file that should own the lesson.
3. Make the smallest edit that prevents recurrence.
4. Read back the edited file.
5. Check for conflicts with `AGENTS.md` and related docs.
6. Include the reason in the PR or final response.

## Lesson Format

When recording a lesson, use this format:

```md
## Lesson: [short name]

Date: YYYY-MM-DD
Source: [issue, PR, task, command, or user request]

### Trigger
What happened?

### Root Cause
Why did it happen?

### New Rule
What should future agents do differently?

### Verification
How can a future agent know the rule worked?
```

## Where Lessons Belong

- Token waste, focus drift, false completion: `quick-diagnosis.md`
- Delegation, model choice, retries, escalation: `model-orchestration.md`
- Completion quality, asking user, wrong-direction signals: `judgment-rubric.md`
- Reusable prompts: `delegation-templates.md`
- Instruction update process: `maintenance-protocol.md`
- Handoff notes and strategic warnings: `future-session-letter.md`

## Avoid Instruction Bloat

Do not keep adding rules forever.

Condense when any file exceeds one of these thresholds:

- More than 200 lines
- More than 10 lessons
- Multiple rules saying the same thing
- Future agents must read too many files before simple work

Condensing method:

1. Group repeated lessons by root cause.
2. Keep the rule that changes behavior.
3. Delete repeated narrative details.
4. Preserve one positive and one negative example when useful.
5. Update `AGENTS.md` only if the read order or core routing changes.

## Conflict Resolution

If two instruction files conflict, use this priority order:

1. Current user request
2. Safety and secret-handling rules
3. `AGENTS.md`
4. `docs/agent-system/judgment-rubric.md`
5. `docs/agent-system/model-orchestration.md`
6. Task-specific templates
7. Older lessons and notes

When resolving conflict, edit the lower-priority file unless the higher-priority file is clearly outdated.

## Review Checklist Before Merging Instruction Changes

- [ ] Does the change prevent a real failure or improve a repeated workflow?
- [ ] Is it specific enough for a weaker coding agent?
- [ ] Does it include acceptance or verification criteria?
- [ ] Does it avoid naming unverified models/tools as guaranteed?
- [ ] Does it avoid exposing secrets or runtime state?
- [ ] Did the agent read back the changed file?
- [ ] Did the final report state what remains unverified?
