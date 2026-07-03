# Quick Diagnosis

This file records the highest-leverage failure modes for future Ops Room coding-agent sessions. Read it before broad repo work.

## 1. Token leak from unbounded context intake

### Failure mode

The agent reads too much: full logs, full issue bodies, full PR diffs, broad directories, generated runtime files, or repeated copies of the same instructions. The session then loses the original goal or runs out of useful context before verification.

### Why it happens

Ops Room sits between GitHub, OpenAB, agent workspaces, logs, and runtime state. That makes it tempting to pull every artifact into the main conversation. The repo also separates safe templates from local runtime state, so careless scans may include irrelevant or sensitive paths.

### Fix

Use scoped context intake:

1. Identify the task type: docs, harness routing, GitHub workflow, dashboard, config template, or runtime debugging.
2. Read only the likely entry files first.
3. Summarize findings into a short scratch summary before reading more.
4. Do not read generated paths unless the task is explicitly about runtime state.

Default excluded paths unless explicitly needed:

- `data/`
- `secrets/`
- `.env`
- generated workspaces
- task logs
- agent home directories
- dependency folders

### Verification

A future session should show:

- The initial file list it chose to inspect
- Why each file was relevant
- No unrelated runtime or secret paths were read or edited
- The final answer references exact files changed or checked

## 2. Focus drift from commander doing worker tasks

### Failure mode

The main agent tries to scan the repo, design the approach, edit many files, review its own work, and summarize everything in one context. This leads to over-editing, missed acceptance criteria, or vague final reports.

### Why it happens

Ops Room is a harness/control surface, so tasks often span code, config, process, and agent behavior. A single agent can easily mix product decisions with implementation details.

### Fix

Use commander/worker separation when available:

- Commander: define goal, constraints, acceptance criteria, and final decision.
- Worker: inspect files, implement scoped change, or perform fresh-context review.
- Verifier: read back changed files and run the relevant scripts.

If no worker agent exists, simulate the split by creating explicit sections in the work log:

1. Intake
2. Plan
3. Edit
4. Fresh read-back
5. Verification
6. Final risks

### Verification

A future session should show a clear acceptance contract before editing and a final completion contract after editing:

- Goal satisfied
- Files changed
- Verification performed
- Risks or unverified items

## 3. False completion from self-verification only

### Failure mode

The agent says the task is done after writing code or docs, but does not read back the result, run a script, or check whether the new instructions conflict with existing repo behavior.

### Why it happens

Agents often treat file writes as proof. In Ops Room, this is risky because many changes affect orchestration, tokens, GitHub permissions, OpenAB routing, or runtime services.

### Fix

Use evidence-based completion:

- For docs: read back every created or modified file.
- For code: run the closest available command from `ops-room/package.json`.
- For workflow or harness changes: include a dry-run checklist if live execution is not possible.
- For high-risk decisions: request fresh-context review or write an adversarial review section.

### Verification

A future session should not claim done unless it provides at least one of:

- Read-back result with file paths
- Test or smoke command result
- Manual verification checklist with explicit unknowns
- Fresh-context review findings and fixes

## Use This Diagnosis

When a future agent is stuck, compare the current behavior against these three failure modes before retrying. If the same failure repeats twice, escalate to a stronger model with the full failure trail.
