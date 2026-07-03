# Letter to Future Sessions

Future session, your job is not only to finish the current task. Your job is to leave Ops Room easier for the next session to operate safely.

## Three Important Things Not Explicitly Asked For

### 1. Protect the commander context

Ops Room coordinates GitHub tasks, OpenAB agents, runtime status, and dashboard behavior. Many tasks will tempt you to pull in too much context.

Keep the main context for user intent, constraints, acceptance criteria, final decisions, and verification summary. Move long investigation output into files or compact worker reports.

### 2. Preserve the boundary between committed templates and local runtime material

The repo separates committed examples from local machine state. Keep that boundary intact.

Default to editing committed source, docs, examples, and workflow files only. Do not include local runtime material in docs or PRs unless the user explicitly asks and the data is safe to share.

### 3. Treat verification as part of the product

Ops Room controls other agents. A false “done” can waste many downstream sessions.

For docs, read back files. For code, run the relevant script. For high-risk routing, use a second context or reviewer. For unavailable runtime checks, write the exact manual checklist.

## Most Likely Degradation Modes

### Degradation 1: `AGENTS.md` becomes a giant instruction dump

Prevention:

- Keep `AGENTS.md` as a routing file.
- Move details into `docs/agent-system/`.
- Condense repeated lessons instead of appending forever.

### Degradation 2: Agents invent unavailable models or tools

Prevention:

- Inspect current config and tool availability.
- Phrase model names as verified facts only after checking.
- If a model or effort level is unknown, write “unknown” and provide the inspection path.

### Degradation 3: Workers return long essays instead of usable evidence

Prevention:

- Use the delegation templates.
- Require file paths and line numbers.
- Require conclusions first.
- Put long artifacts into files and return only paths.

### Degradation 4: Verification gets skipped because docs feel safe

Prevention:

- Docs still need read-back verification.
- Instruction docs can conflict with each other and mislead future agents.
- Every instruction change needs at least one pass looking for ambiguity, path errors, and conflict.

## What To Do When Unsure

1. Inspect the smallest relevant source.
2. Mark verified facts separately from assumptions.
3. If one safe path exists, take it on a branch.
4. If multiple product directions exist, ask the user.
5. If the task affects production routing, identity, permissions, or cost, escalate or ask.
6. If the result cannot be verified, say exactly what remains unverified.

## Unfinished Work

This initial operating system covers instruction routing, delegation, judgment, maintenance, and handoff. Future sessions should improve it with real lessons from actual Ops Room failures, especially around:

- GitHub identity behavior
- Pull request review routing
- OpenAB task payload shaping
- Token budgets for agent prompts
- Runtime smoke checks that can run safely in CI

Do not add speculative rules. Add lessons only after a concrete failure or repeated friction.
