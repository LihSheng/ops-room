# Externalized Judgment Rubric

This file converts judgment into rules weaker coding agents can execute. Use it before escalating, retrying, asking the user, or claiming completion.

## 1. When to upgrade the model

| Criterion | Upgrade when | Positive example | Negative example |
|---|---|---|---|
| Cross-file uncertainty | The task spans more than three unfamiliar areas and the agent cannot name the entry point. | A GitHub webhook issue may involve workflow YAML, server routing, task claiming, and agent config. Upgrade before editing. | A button label is clearly in one UI file. Do not upgrade just because the repo is unfamiliar. |
| Repeated failure | The same subtask failed once on a small model or twice on a mid-tier model. | The agent twice changes PR labels but still gets GitHub 403. Escalate with logs and attempted fixes. | The first attempt failed because of a typo and the fix is obvious. Correct once before escalating. |
| Security or credentials | The change touches tokens, secrets, auth, webhook signatures, permissions, or production routing. | Changing GitHub App token generation or webhook secret validation requires stronger review. | Updating a README sentence about local URLs does not require upgrade. |
| Ambiguous architecture | There are multiple valid designs with long-term tradeoffs. | Deciding whether Ops Room owns agent state in DB or config files needs higher-level judgment. | Renaming an internal helper after the design is settled does not. |
| Unknown tool/model availability | The agent is about to reference a model, effort level, MCP tool, or runtime that has not been verified. | Inspect available configs/tools first; upgrade if still unclear. | Guessing that `opencode-professor` exists because it was mentioned before. |

## 2. When a task is truly complete

A task is complete only when all applicable checks pass.

| Criterion | Done means | Positive example | Negative example |
|---|---|---|---|
| Scope satisfied | The requested behavior or document exists in the intended path. | `AGENTS.md` routes to `docs/agent-system/*` and the linked files exist. | The agent wrote a long answer in chat but did not create files. |
| Verification evidence | The agent read back changed docs or ran relevant code checks. | After creating docs, it fetches each file and confirms contents. | The agent says “created successfully” only because a write API returned a commit SHA. |
| No unrelated edits | The diff is limited to files needed for the task. | Agent-system docs only, no runtime server changes. | A docs task also reformats server code. |
| Risks named | Unverified or environment-dependent parts are explicit. | “I could not run the live OpenAB runtime; docs rely on repo-visible scripts.” | “Everything works” without running anything. |
| User-ready output | The final answer explains what changed and how to use it. | PR summary lists files, purpose, verification, and next step. | Final answer only says “done.” |

## 3. When to stop and ask the user

Ask only when continuing would likely produce the wrong outcome.

| Criterion | Ask when | Positive example | Negative example |
|---|---|---|---|
| Product direction conflict | Two choices imply different product behavior or data ownership. | Ask whether Ops Room should remain config-file based or introduce database-backed state. | Ask whether to fix an obvious typo. |
| Permission or identity ambiguity | The task depends on which actor should perform GitHub actions. | Ask whether comments should appear as the GitHub App, PAT user, or OpenAB agent. | Ask whether to use a branch before making a PR; branch + PR is the safe default. |
| Destructive operation | The next step deletes files, closes PRs, removes labels, or rewrites history. | Ask before deleting existing config or force-pushing. | Creating new docs on a feature branch does not need a question. |
| Missing secret/runtime | The task requires unavailable secrets, local services, or credentials. | Ask for runtime access or provide a dry-run checklist. | Ask for credentials to update docs. |

## 4. Signals the current direction is wrong

Switch strategy instead of retrying when these appear.

| Signal | What it means | Positive example | Negative example |
|---|---|---|---|
| Same error after unrelated fixes | The root cause is probably misunderstood. | GitHub 403 persists after YAML permission edits; investigate event type and token identity. | Syntax error changes line number after fixing a missing quote; continue debugging. |
| Large diff for small task | The agent is over-editing. | A docs prompt changes server runtime files; revert and narrow scope. | A refactor intentionally touches several files listed in acceptance criteria. |
| Cannot state acceptance criteria | The task is under-specified or the agent lost focus. | Stop and define criteria before editing. | Criteria are clear but the agent has not written them down yet. |
| Verification unavailable | The task depends on behavior that cannot be observed. | Provide a dry-run checklist or ask for runtime access. | Docs can be verified by read-back, so do not block. |
| Context keeps expanding | The agent is reading more but not learning more. | Summarize known facts, form a hypothesis, inspect only one next file. | Reading one additional directly imported file is reasonable. |

## 5. Quality floor

Every agent output must satisfy this minimum standard.

| Check | Required evidence | Positive example | Negative example |
|---|---|---|---|
| Traceability | Link conclusion to file path, line, command, or PR diff. | “Routing starts in `ops-room/src/server/webhook.mjs` lines X-Y.” | “The routing is probably in the server.” |
| Minimality | The diff solves the stated task without unrelated cleanup. | Add agent docs only. | Rename unrelated functions while adding docs. |
| Reversibility | Changes are isolated enough to review or revert. | Feature branch with separate docs files. | Direct push to main with mixed runtime changes. |
| Safety | No secrets or runtime data exposed. | Mentions excluded paths and avoids reading them. | Copies `.env` or logs into docs. |
| Verification | Read-back or command result is included. | Fetches each created doc after commit. | Assumes file content is correct from memory. |

## Default Decision Ladder

1. Can the task be solved with scoped repo evidence? Do that.
2. Does it require runtime state or secrets? Ask or produce a dry-run checklist.
3. Did a weaker model fail? Escalate once with failure trail.
4. Did the solution pattern become clear? Downgrade for repetitive application.
5. Before final response, verify independently or mark exactly what remains unverified.
