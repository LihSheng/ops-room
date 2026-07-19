# Curated Memory Governance

This document defines the OPS-005 boundary between the Obsidian vault, Git-backed policy, and the read-only knowledge directory consumed by OpenAB agents.

The canonical architecture remains [`../ARCHITECTURE.md`](../ARCHITECTURE.md).

## What OPS-005 Provides

OPS-005 adds a validated registry of approved logical memory spaces:

```text
config/memory-spaces/<key>/<version>/manifest.json
```

Each agent profile references logical keys instead of raw vault paths. At startup, Ops Room verifies that every assignment resolves to an approved manifest and respects ownership and write policy.

The registry provides governance metadata only. It does not read Obsidian notes, search the vault, publish files, synchronize directories, or grant filesystem write access.

## Approved Publication Roots

| Kind | Relative root | Purpose |
|---|---|---|
| `project` | `20_Projects/` | Curated project knowledge |
| `shared` | `90_Shared/` | Approved cross-agent knowledge |
| `private-agent` | `90_Agents/` | Knowledge restricted to one logical agent |
| `archive` | `99_Archive/` | Read-only historical material |

Paths are relative policy identifiers. Public APIs never return the absolute host path of the Obsidian vault or runtime publication directory.

## Registry Rules

A manifest is accepted only when it satisfies all applicable rules:

- Stable lowercase key and immutable semantic version.
- Normalized relative publication path under the root required by its kind.
- No absolute paths, `..`, wildcards, empty segments, or symlinks.
- Nested publication paths explicitly identify their parent space.
- Private-agent spaces identify one valid owner agent.
- Archive spaces are read-only.
- `review-required` spaces define provenance fields and require review.
- No secret-looking fields, credentials, prompts, note contents, or environment values.

Structural failures prevent Ops Room from starting with misleading policy state.

## Agent Assignment Rules

Agent profiles declare:

```json
{
  "memory": {
    "read": ["ops-room-project"],
    "write": ["ops-room-implementation"]
  }
}
```

Startup validation enforces:

- Every logical key exists in the registry.
- An agent cannot access another agent's private space.
- A read-only space cannot appear in `memory.write`.
- Every write assignment must also appear in `memory.read`.
- Duplicate assignments are rejected.

A write assignment is future policy intent. It does not make the running agent or Ops Room process writable.

## Current Manual Publication Process

Publication remains an explicit human-operated process.

1. **Select approved source material**
   - Start from a path represented by a validated memory-space manifest.
   - Exclude secrets, credentials, private conversations, temporary files, and unrelated vault content.

2. **Review content**
   - Confirm the material is appropriate for every agent with read access.
   - For a private-agent space, confirm the intended owner.
   - Remove absolute host paths, tokens, environment values, and sensitive personal data.

3. **Prepare the curated publication directory**
   - Use a dedicated directory referenced by `OPENAB_AGENT_KNOWLEDGE_DIR`.
   - Never point this variable at the Obsidian vault root.
   - Preserve only the approved relative space layout needed by the agents.

4. **Copy or synchronize approved files**
   - Use a human-reviewed script or file operation outside the Ops Room web process.
   - Prefer a one-way Obsidian-to-publication flow.
   - Do not permit the agent runtime to synchronize changes back to the vault.

5. **Verify the result**
   - Confirm no symlinks escape the publication directory.
   - Confirm no unexpected top-level directories exist.
   - Confirm file permissions are read-only for agent containers.
   - Confirm the complete Obsidian vault is not mounted.

6. **Activate through the existing runtime configuration**
   - Mount `OPENAB_AGENT_KNOWLEDGE_DIR` read-only into the intended agents.
   - Restart or redeploy only through the approved operational process.
   - Verify agent/runtime health without exposing publication paths through public APIs.

## Recommended One-Way Sync Shape

A future operator script may implement a narrow allowlist such as:

```text
Obsidian vault
├── 20_Projects/Ops-Room/
├── 20_Projects/LinkUp/
├── 90_Shared/Ops-Room/
├── 90_Agents/<agent>/
└── 99_Archive/Ops-Room/
        │
        │ human-reviewed one-way publication
        ▼
OPENAB_AGENT_KNOWLEDGE_DIR
└── curated approved content only
```

That script must be separately reviewed. It should validate real paths, reject symlinks and traversal, use an allowlist generated from the approved manifests, stage output atomically, and preserve a rollback copy.

## Future Governed Write Contract

Automated memory writes are not part of OPS-005. A later architectural decision must introduce a separate publisher with all of the following controls:

- Authenticated and authorized actor identity.
- Audited and idempotent publication request.
- Approved target memory-space key.
- Required provenance fields:
  - `agent_id`
  - `task_id`
  - `source_refs`
  - `created_at`
- Human review for every `review-required` space.
- Content validation and secret redaction.
- Atomic publication with rollback.
- No direct write access from the dashboard or agent runtime to the Obsidian vault.
- No overwrite or deletion of reviewed notes without a separate elevated policy.

Until that decision is implemented, APIs and dashboard views remain read-only.

## Public API Boundary

The current read-only endpoints are:

```text
GET /api/memory-spaces
GET /api/memory-spaces/:key
GET /api/agents/profiles
GET /api/agents/profiles/:id
```

They may return logical keys, versions, display metadata, relative publication paths, ownership, write policy, provenance requirements, and reader/writer IDs.

They must not return:

- Obsidian note contents.
- Absolute vault or host paths.
- Runtime mount paths.
- Manifest source paths.
- Tokens, credentials, environment values, or secret references.
- Search results or vector embeddings.

## Operational Verification

After deploying a release containing memory governance:

1. Confirm `/api/health` reports `memory_registry.status = ready`.
2. Confirm the expected manifest and assignment counts.
3. Confirm `/api/memory-spaces` returns only approved keys.
4. Check one detail endpoint and each agent profile's resolved memory assignments.
5. Confirm the dashboard `/memory` and `/agents/:id` views contain governance metadata only.
6. Confirm the immutable release contains the exact approved manifest set.
7. Confirm no Obsidian vault, note contents, `.env`, secrets, or runtime data are inside the release artifact.
