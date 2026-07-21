# OPS-010F — Provider Stage Runners and Durable Effect Fencing

Status: **Implementation in progress — PR #49**

Issue: #47

## Goal

Connect the existing OPS-010E explicit child executor to the approved Professor, Tokyo, and Berlin provider runtimes without weakening exact-SHA, workspace ownership, restart, or credential-separation guarantees.

OPS-010F is an internal execution boundary. It does not automatically advance a workflow or expose a browser/HTTP mutation control.

## Stage authority

| Stage | Authorized agent | Workspace mode | Provider backend |
|---|---|---|---|
| `implementation` | Professor | writable branch | Profile-selected, currently `opencode` |
| `test` | Tokyo | writable branch | Profile-selected, currently `opencode` |
| `integration` | Professor | writable branch | Profile-selected, currently `opencode` |
| `review` | Berlin | detached exact SHA | Profile-selected, currently `opencode` |

A stage/owner/workspace-mode mismatch fails before provider invocation.

## Durable effect identity

Every provider invocation is one durable external effect identified by:

- workflow ID;
- child ID;
- provider/stage effect type;
- child attempt idempotency key.

The effect record stores a canonical payload hash rather than the raw prompt or provider output. The payload hash includes bounded workflow/stage identity, immutable input SHA, workspace ID, and prompt hash.

Effect states:

```text
claimed → completed
       ↘ failed
       ↘ needs_human
```

Only the process that creates the claim with exclusive file creation may invoke the provider. Existing claims never return execution authority.

## Restart behavior

Startup creates and validates the workflow-effect directory before HTTP readiness.

A record left in `claimed` is uncertain: the previous process may have invoked the provider before interruption. Startup therefore transitions it to `needs_human` with `workflow_effect_interrupted`. It never replays the provider automatically.

Completed or terminal effects retain immutable bounded evidence. Repeating the same effect identity returns the recorded outcome without invoking the provider again. A different payload for the same identity fails closed.

## Provider process boundary

The concrete profile-backed adapter:

1. resolves the canonical agent profile;
2. requires the profile to be enabled;
3. verifies the workflow repository is allowed by the profile;
4. verifies the child owner matches the selected adapter;
5. supports only an explicitly implemented backend (`opencode` in this slice);
6. invokes `opencode run -` with a fixed argument array and `shell: false`;
7. sends the bounded prompt through stdin;
8. exposes only an explicit provider environment allowlist;
9. excludes GitHub, webhook, dashboard, operator, Node injection, and unrelated host credentials;
10. validates that the workspace origin is credential-free HTTPS and rejects SSH, embedded user information, query credentials, and fragments;
11. disables system/global Git configuration, credential prompting, and Git Credential Manager interaction;
12. assigns a disposable HOME, XDG directories, and empty `GH_CONFIG_DIR` for each provider invocation;
13. bounds stdout and discards raw stderr;
14. aborts the provider on cancellation or timeout and waits for subprocess closure before recording terminal workflow evidence;
15. escalates shutdown from SIGTERM to SIGKILL and reports `workflow_provider_termination_failed` when the adapter does not settle within the bounded termination grace period.

The disposable provider home is removed after the provider exits. The provider does not receive the host HOME or USERPROFILE and cannot read host `gh`, Git credential, SSH, or provider-session files through normal home-directory discovery.

Provider output must be exactly one bounded JSON object:

```json
{"outcome":"completed","output_sha":"<exact 40-character SHA>"}
```

or:

```json
{"outcome":"needs_human","reason":"<bounded_reason_code>"}
```

The output SHA is validated without truncation or normalization beyond trimming and lowercasing. A longer or shorter value is rejected.

Raw provider errors, stderr, prompts, environment values, credentials, and host paths are never persisted in workflow-effect records.

## Existing authority retained

OPS-010F composes with `executeWorkflowChild` rather than replacing it.

OPS-010E remains authoritative for:

- durable child activation before execution;
- workspace binding and ownership validation;
- writable workspace HEAD verification;
- detached review output-SHA equality;
- terminal child deduplication;
- cleanup request after success;
- investigation hold after failure.

OPS-009 remains authoritative for workspace allocation, branch ownership, capacity, filesystem safety, and cleanup lifecycle.

## Health and persistence

The default durable effect path is:

```text
OPS_ROOM_WORKFLOW_EFFECTS_DIR
```

or, when unset:

```text
<data>/ops-room/workflow-effects
```

`/api/health` reports `workflow_effect_store` as a required readable/writable dependency. The server is not ready when this store is unavailable.

## Test coverage

The implementation includes focused tests for:

- deterministic claims and canonical payload hashing;
- concurrent duplicate claims;
- conflicting payload rejection;
- terminal immutability;
- interrupted-effect startup reconciliation;
- stage/agent authorization;
- duplicate provider suppression;
- exact 40-character output-SHA validation without truncation;
- malformed output and redaction;
- timeout and cancellation;
- subprocess-shutdown acknowledgement before terminal effect persistence;
- explicit termination-grace failure;
- profile and repository authorization;
- credential-bearing, SSH, query, and fragment remote rejection;
- subprocess environment allowlisting;
- disposable HOME and isolated Git/`gh` configuration;
- Node injection variable exclusion;
- shell-free stdin execution;
- bounded stdout and discarded stderr;
- composition with OPS-010E;
- health readiness.

## Non-goals

OPS-010F does not add:

- automatic implementation → test → integration → review advancement;
- automatic iteration creation;
- Berlin approval/changes-requested workflow semantics;
- automatic Git push, pull-request creation, review posting, merge, or deployment;
- an HTTP workflow mutation endpoint;
- browser workflow controls;
- automatic retry of uncertain provider effects;
- a general workflow engine.

These orchestration concerns belong to OPS-010G or a later explicitly approved slice.

## Deployment validation after merge

After OPS-010F is merged, deploy one immutable release to the VPS and validate:

1. workflow-effect store readiness;
2. authorized Professor, Tokyo, and Berlin provider execution;
3. rejection of a stage/agent mismatch;
4. duplicate invocation suppression;
5. timeout and cancellation behavior;
6. provider-process shutdown before terminal workflow evidence is written;
7. restart with a deliberately interrupted claimed effect;
8. rejection of credential-bearing or SSH workspace origins;
9. provider operation with a disposable home and only the configured provider API credential;
10. inability to use host `gh`, Git credential helpers, SSH keys, or persisted user configuration;
11. absence of raw provider output, secrets, or host paths in durable records and APIs;
12. preservation of OPS-010E exact-SHA and workspace lifecycle guarantees.

Do not begin OPS-010G production orchestration until this focused validation passes.
