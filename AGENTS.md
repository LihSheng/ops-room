# Agent Instructions

This repository uses a Codex-oriented agent operating system. Keep this file short. Put long rules, rubrics, and templates under `docs/agent-system/`.

## First Read Order

Before starting non-trivial work, read these files in order:

1. `docs/agent-system/quick-diagnosis.md`
2. `docs/agent-system/model-orchestration.md`
3. `docs/agent-system/judgment-rubric.md`
4. The relevant section of `docs/agent-system/delegation-templates.md`
5. `docs/agent-system/maintenance-protocol.md` if changing agent instructions

## Repo Reality Check

Ops Room is the control surface for OpenAB-backed agents. It receives GitHub webhooks, polls for tasks, routes work to agents, and exposes a read-only dashboard. Runtime state belongs under `data/`; private credentials belong under `secrets/`; safe templates belong under `config/`.

Never commit real `.env` values, private keys, generated workspaces, task logs, runtime state, or agent home directories.

## Working Rules

- Start by identifying the smallest useful change that satisfies the task.
- Prefer scoped file reads over broad repo scans.
- Do not edit unrelated files.
- Before modifying an existing instruction file, create a backup or keep the change in a branch/PR.
- For code changes, run the relevant script when available. For this repo, inspect `ops-room/package.json` before assuming test commands exist.
- For dashboard or server changes, prefer at least one smoke path such as `npm run smoke:instances` when applicable.
- Completion requires evidence: changed files, verification result, and remaining risks.

## Agent Delegation Rule

The main agent should act as commander. Delegate large reading, repository scans, web research, repetitive edits, and independent verification to worker agents when the environment supports it.

Every delegated task must include:

1. Goal and motivation
2. Acceptance criteria
3. Required report format

Worker agents should report conclusions plus file paths and line numbers. Long outputs should be written to files, then reported by path.

## Completion Contract

A task is not done until the final response or PR description includes:

- What changed
- Why it changed
- How it was verified
- What was not verified
- Next recommended step, if any

If a requirement is ambiguous, risky, or cannot be verified from the repo, mark it explicitly instead of guessing.
