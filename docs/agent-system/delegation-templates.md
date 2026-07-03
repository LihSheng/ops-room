# Delegation Prompt Templates

Copy these templates when assigning work to worker agents. Replace every placeholder before sending. Keep reports compact and evidence-based.

## Universal Report Format

Require this format unless the task needs something more specific.

```text
Conclusion:
Files inspected:
Relevant files and lines:
Changes made, if any:
Commands run and results:
Risks or unknowns:
Recommended next step:
```

## 1. Search Template

```text
Task type: Search

Goal:
Find [specific files/functions/configs] related to [feature/bug/workflow].

Motivation:
We need to understand [why this matters] before editing. Avoid broad conclusions without file evidence.

Scope:
- Include: [paths/modules]
- Exclude: data/, secrets/, .env, generated workspaces, dependency folders, unrelated runtime logs

Constraints:
- Do not edit files.
- Do not dump full file contents.
- Prefer exact file paths and line numbers.
- Stop after finding enough evidence to identify the likely entry points.

Acceptance criteria:
- Return the top [N] relevant files.
- For each file, explain why it matters in one sentence.
- Include line numbers or function names when available.
- State what should be inspected next.

Required report format:
Conclusion:
Files inspected:
Relevant files and lines:
Likely entry point:
Risks or unknowns:
Recommended next step:
```

## 2. Implementation Template

```text
Task type: Implementation

Goal:
Implement [small behavior change] in [specific area].

Motivation:
This matters because [user problem or harness failure].

Scope:
- Allowed files: [list allowed files or directories]
- Do not edit: [forbidden files/directories]

Constraints:
- Keep the diff minimal.
- Preserve existing public behavior except [explicit change].
- Do not commit secrets, runtime data, generated workspaces, or logs.
- If the expected entry point is wrong, stop and report before broadening scope.

Acceptance criteria:
- [Behavior 1]
- [Behavior 2]
- [Error handling or edge case]
- [Docs/config updated if needed]

Verification method:
- Run [command] if available.
- If command cannot run, explain why and provide a manual verification checklist.

Required report format:
Conclusion:
Files changed:
Acceptance criteria status:
Commands run and results:
Risks or unknowns:
Recommended next step:
```

## 3. Refactoring Template

```text
Task type: Refactoring

Goal:
Refactor [specific code area] to improve [maintainability/readability/testability] without changing behavior.

Motivation:
The current code causes [specific problem: duplication, unclear routing, unsafe coupling, token waste, etc.].

Scope:
- Include: [files/functions]
- Exclude: unrelated feature changes, formatting-only churn outside touched files, runtime config changes

Constraints:
- Behavior must remain the same.
- Keep public interfaces stable unless explicitly allowed.
- Prefer small mechanical steps.
- If tests are missing, use before/after reasoning plus smoke checks.

Acceptance criteria:
- Existing behavior preserved.
- Code is simpler by [specific measure: fewer branches, clearer function, isolated helper, etc.].
- No unrelated files changed.
- Verification evidence included.

Verification method:
- Run [test/smoke command].
- If no command exists, provide read-back and manual behavior checklist.

Required report format:
Conclusion:
Files changed:
Behavior preservation evidence:
Commands run and results:
Risks or unknowns:
Recommended next step:
```

## 4. Research Template

```text
Task type: Research

Goal:
Research [specific question] so the commander can decide [decision].

Motivation:
The wrong decision would cause [risk/cost].

Scope:
- Sources to inspect: [repo files/docs/web docs/issues]
- Exclude: speculation, outdated assumptions, unrelated comparisons

Constraints:
- Separate verified facts from inference.
- Cite source paths, URLs, or commands.
- Do not make code changes.
- If current information may be outdated, verify from current source.

Acceptance criteria:
- Answer the decision question directly.
- Provide 2-3 viable options if tradeoffs exist.
- State recommendation and why.
- State unknowns that require user or runtime confirmation.

Required report format:
Conclusion:
Verified facts:
Options:
Recommendation:
Risks or unknowns:
Recommended next step:
```

## 5. Review Template

```text
Task type: Review

Goal:
Review [PR/branch/files] against [acceptance criteria].

Motivation:
We need independent verification before claiming the task is complete.

Scope:
- Review only: [files/PR/diff]
- Focus on: correctness, safety, minimality, verification, instruction conflicts
- Exclude: unrelated style preferences unless they affect maintainability

Constraints:
- Do not edit files unless explicitly asked.
- Use fresh-context judgment: do not rely on the implementer's claims.
- Prefer blocking issues over minor suggestions.

Acceptance criteria:
- Identify any blocking issues.
- Identify any instruction conflicts or ambiguous wording.
- Confirm whether the change satisfies the original task.
- Provide exact file references.

Required report format:
Verdict: PASS / PASS WITH RISKS / BLOCKED
Blocking issues:
Non-blocking suggestions:
Files and lines:
Verification performed:
Recommended next step:
```

## Template Use Rules

- Do not send a worker a vague task.
- Do not ask a worker to both implement and verify the same change unless no alternative exists.
- Do not allow workers to report long artifacts in chat; require file paths.
- After a worker returns, the commander must decide. Do not blindly accept the worker report.
