# Model Orchestration Guide

Use this guide when deciding what the main agent should do directly, what should be delegated, and how to verify agent work.

## Core Principle

The main agent is the commander. It should preserve context for decisions, synthesis, and final reporting. It should not spend the main context on broad scanning, repetitive edits, or independent verification when worker agents are available.

## Known Environment Assumption

The README names OpenAB-backed instances such as `gemini`, `opencode-1`, `opencode-2`, and `opencode-professor`. Treat these as examples until the current runtime or config confirms they exist.

Before assigning a model or worker, inspect the actual environment:

- `config/agents/*.example.toml`
- runtime agent list if available
- harness config under `config/harness/`
- current task runner or MCP/tool availability

Never invent available models, effort levels, or tool names.

## Delegate These Tasks

Delegate when available:

- Large repo scans
- Searching for related files
- Reading long logs or PR diffs
- Web or documentation research
- Batch edits after a pattern is proven
- Fresh-context verification
- Adversarial review

Keep in main context:

- User intent
- Constraints
- Acceptance criteria
- Final tradeoff decisions
- Final user-facing summary

## Delegation Three-Piece Format

Every delegated task must include these three parts.

### 1. Goal and motivation

State what the worker must achieve and why it matters.

Good:

> Find the files responsible for GitHub PR review routing so we can add a narrow fix without touching unrelated dashboard code.

Bad:

> Look around the repo and tell me what you find.

### 2. Acceptance criteria

State what must be true for the task to count as complete.

Good:

> Return the exact files and functions involved in PR review routing. Include line numbers. Do not propose implementation yet.

Bad:

> Be thorough.

### 3. Required report format

Force compact, verifiable output.

Required default format:

```text
Conclusion:
Files inspected:
Relevant files and lines:
Risks or unknowns:
Recommended next step:
```

## Report Contract

Worker agents must return conclusions, not long essays.

Required:

- File paths
- Line numbers when available
- Commands run
- Result of each command
- Risks or unknowns

Not allowed:

- Dumping full file contents into the main conversation
- Repeating instructions already stored in files
- Claiming completion without evidence
- Editing outside scope without approval

Long artifacts must be written to files. The report should return only the file path and a short summary.

## Model and Effort Selection

Use actual available models only. When the environment exposes effort settings, choose the lowest setting that can reliably satisfy the task.

Suggested decision rule:

| Task | Starting model class | Effort |
|---|---|---|
| Simple file lookup | cheapest reliable coding model | low |
| Repetitive batch edit after pattern is proven | cheapest reliable coding model | low/medium |
| Bug fix in known file | mid-tier coding model | medium |
| Cross-file architecture decision | strongest available model | high |
| Security-sensitive routing or token handling | strongest available model | high |
| Ambiguous product judgment | strongest available model or ask user | high |
| Fresh verification | different model/context from implementer | medium |

## Escalation Rules

Escalate instead of repeatedly retrying.

- If a small model fails once, escalate directly.
- If a mid-tier model fails the same subtask twice, escalate with the complete failure trail.
- If the task fails due to missing context, gather the missing context once, then retry.
- If the task fails due to unclear user intent, ask the user instead of guessing.
- Retry the same task at most two rounds.

A failure trail must include:

- Original goal
- Files touched
- Commands run
- Error output or wrong behavior
- Why the previous attempt failed
- Current best hypothesis

## Downgrade Rules

Downgrade after the hard part is solved.

Examples:

- Strong model identifies the correct routing pattern; cheaper worker applies the same pattern to similar handlers.
- Strong model designs a doc structure; cheaper worker fills repetitive examples.
- Mid-tier model finds the config mismatch; cheaper worker updates examples and readme references.

## Verification Must Be Independent

Do not let the implementer be the only verifier.

Use one of these:

- Fresh-context agent reads changed files and checks against acceptance criteria.
- Test or smoke command runs the relevant path.
- Manual read-back confirms the exact content landed.
- High-risk judgment gets a second answer and the commander selects the best supported one.

## Stop Conditions

Stop and ask or escalate when:

- The task requires a secret, credential, or local runtime that is unavailable.
- The expected file or tool does not exist after a targeted search.
- Two attempts fail for different reasons.
- The agent cannot explain why a change is safe.
- The change might affect production routing, credentials, token usage, or GitHub write permissions.
