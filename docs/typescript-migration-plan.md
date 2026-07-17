# Plan: Convert Ops Room to TypeScript

**Generated**: 2026-07-17
**Estimated Complexity**: High

## Overview

Convert the Ops Room backend, scripts, and tests from JavaScript ES modules (`.mjs`) to TypeScript while keeping the existing React dashboard, HTTP behavior, GitHub workflows, task state, and deployment contract stable.

Recommendation: use TypeScript 7 for the CLI compiler/type-checker after a short compatibility spike. Emit Node JavaScript beside its `.ts` source and run the emitted `.js` files in production; do not depend on Node 20 executing `.ts` files directly. TypeScript 7 currently has no stable programmatic API, so avoid adding tooling that imports the compiler API during this migration.

> Implementation note (2026-07-17): the initial cutover uses TypeScript 7 `noCheck` emit mode for the legacy Node code. This keeps the conversion behavior-preserving while API-boundary types are introduced incrementally. The dashboard remains strict. Remove `noCheck` only once the backend/test type-hardening work is complete.

> Removal gate: enable semantic checking only after the GitHub/webhook, filesystem JSON, process, and AI-response boundaries have runtime guards and named types; then require a clean backend `tsc --noEmit` run in CI before removing `noCheck`.

> Container note: `scripts/github-app-token.ts` is the source of truth. Its small emitted ESM runtime file, `scripts/github-app-token.js`, is version-controlled because the agent containers mount `/scripts` and execute plain Node without a TypeScript runtime.

## Current Baseline

- Backend/workflows/services/routes: `ops-room/src/**/*.mjs`.
- Tests and operational scripts: `ops-room/test/**/*.test.mjs`, `ops-room/scripts/**/*.mjs`.
- Dashboard: already TypeScript/TSX under `ops-room/dashboard/`, with strict checking in `dashboard/tsconfig.json`.
- Package entrypoints and systemd still execute source `.js` files (`ops-room/package.json`, `ops-room/deploy/openab-ops-room.service`).
- Existing validation: `npm test`, `npm run build:dashboard`, `npm run smoke:instances`, release build/verify scripts.

## Prerequisites and Decisions

- Confirm the active enhancement agent will not concurrently rename or heavily restructure the same backend files; sequence migration after the enhancement’s behavior stabilizes.
- Pin and test one TypeScript 7 release in `ops-room/package.json`/`package-lock.json`; do not use an unpinned nightly.
- Keep Node engine at `>=20.19.0` unless deployment constraints change.
- Preserve ESM (`"type": "module"`) and use explicit `.js` import extensions in emitted/runtime imports.
- Decide whether generated `dist/` is deployment-only and ignored by Git; do not commit generated output unless the release process requires it.

## Sprint 1: Compiler and Runtime Foundation

**Goal**: Establish a repeatable TypeScript build without changing application behavior.

**Demo/Validation**:

- `npm run typecheck` passes for the dashboard and a small converted backend slice.
- `npm run build` emits runnable server artifacts.
- Existing dashboard build remains green.

### Task 1.1: Add root TypeScript configuration

- **Location**: `ops-room/tsconfig.json`, `ops-room/tsconfig.build.json`, `ops-room/tsconfig.test.json`.
- **Description**: Define strict shared options, ESM/Node resolution, `rootDir`, separate output directories, source maps, declaration policy, and exclusions for `dist`, runtime data, secrets, and generated workspaces.
- **Dependencies**: None.
- **Acceptance Criteria**:
  - Backend config supports strict checking and declaration-free production output.
  - Test config includes converted tests without mixing test output into server output.
  - Dashboard config either extends shared settings or remains independently strict.
- **Validation**: Run `npx tsc -p tsconfig.build.json --noEmit` on the initial pilot files.

### Task 1.2: Add build/dev/typecheck commands

- **Location**: `ops-room/package.json`, `ops-room/package-lock.json`.
- **Description**: Add `typecheck`, `build:server`, `build:test`, `dev:server`, and compiled-test commands. Add a TS runtime helper only if needed for development; production must run emitted JavaScript.
- **Dependencies**: Task 1.1.
- **Acceptance Criteria**:
  - `npm run build` builds dashboard and server.
  - `npm test` remains the single documented test entrypoint.
  - Existing `start`, `poll`, `claim`, smoke, and release commands have an explicit migration target.
- **Validation**: Execute every changed script from `ops-room/`.

### Task 1.3: Type one low-risk vertical slice

- **Location**: `ops-room/src/services/runtime-paths.ts`, one simple route/service, and its imports.
- **Description**: Convert a small dependency chain first to prove extension rules, Node built-ins, environment typing, and emitted module paths.
- **Dependencies**: Tasks 1.1–1.2.
- **Acceptance Criteria**:
  - No `any` added except documented boundary cases.
  - Emitted JavaScript runs under Node 20.
  - Existing behavior and import graph remain unchanged.
- **Validation**: Unit test the slice and run a health endpoint smoke path.

## Sprint 2: Backend Conversion by Dependency Layers

**Goal**: Convert all runtime source without a behavior rewrite.

**Demo/Validation**:

- Server, poller, and claim CLI run from `dist`.
- `npm test` passes after each layer.
- `npm run smoke:instances` passes with the normal local prerequisites.

### Task 2.1: Convert pure configuration and utility modules

- **Location**: `ops-room/src/lib/*.js`, `ops-room/src/services/runtime-paths.js`, `ops-room/src/services/agent-definitions.js`.
- **Description**: Rename to `.ts`, add literal unions/types for agent IDs, labels, paths, task metadata, and environment values; replace implicit `any` at boundaries with `unknown` plus guards.
- **Dependencies**: Sprint 1.
- **Validation**: Existing unit tests plus focused typecheck.

### Task 2.2: Convert persistence and integration services

- **Location**: `ops-room/src/services/*.js`.
- **Description**: Type filesystem JSON records, task/review state, process lifecycle, logs, GitHub responses, and OpenAB instance data. Keep runtime validation at JSON/API boundaries.
- **Dependencies**: Task 2.1.
- **Acceptance Criteria**: No unsafe casts for untrusted GitHub, filesystem, or AI payloads without a named validator/helper.
- **Validation**: Existing service/workflow tests; add tests for malformed payloads where current coverage is absent.

### Task 2.3: Convert workflows and routes

- **Location**: `ops-room/src/workflows/*.js`, `ops-room/src/routes/*.js`.
- **Description**: Convert in dependency order, preserving async cancellation, effect-ledger idempotency, review/fix loop transitions, response status codes, and secret redaction.
- **Dependencies**: Task 2.2.
- **Validation**: Full test suite, health/webhook route tests, and a manual dry-run checklist for GitHub write operations.

### Task 2.4: Convert server entrypoints and CLI scripts

- **Location**: `ops-room/src/server/*.js`, `ops-room/scripts/*.js`.
- **Description**: Convert webhook, poller, claim, bootstrap, smoke, debug, cleanup, and release scripts. Make each script’s CLI argument and exit-code contract explicit.
- **Dependencies**: Task 2.3.
- **Validation**: `npm run build:server`, `npm run bootstrap`, `npm run smoke:instances`, release build/verify, and `node dist/server/...` checks.

## Sprint 3: Tests and Tooling

**Goal**: Make TypeScript the default development and verification language.

**Demo/Validation**:

- No production/test `.js` source remains except intentionally external/generated fixtures.
- Typecheck catches a seeded type error.
- Full tests run from compiled output.

### Task 3.1: Convert tests incrementally

- **Location**: `ops-room/test/**/*.test.js` → `.ts`.
- **Description**: Convert test files in groups matching the backend layers. Type Node test APIs and shared fixtures; preserve test names and assertions.
- **Dependencies**: Corresponding Sprint 2 modules.
- **Validation**: Run each group, then `npm test` against all compiled tests.

### Task 3.2: Remove JavaScript escape hatches

- **Location**: `ops-room/tsconfig*.json`, source files, package scripts.
- **Description**: Keep `allowJs: false`; remove temporary `// @ts-ignore`, broad `any`, compatibility shims, and obsolete `.js` imports. Add a small lint/static-check policy only if it does not require the TypeScript 7 compiler API.
- **Dependencies**: Task 3.1.
- **Validation**: `npm run typecheck`; repository scan for `.js` and temporary suppressions.

### Task 3.3: Update documentation and deployment references

- **Location**: `ops-room/README.md`, root `README.md`, `ops-room/deploy/openab-ops-room.service`, relevant docs under `docs/`.
- **Description**: Document source/build layout, commands, `dist` entrypoints, systemd working directory, release artifact contents, and rollback procedure.
- **Dependencies**: Tasks 2.4 and 3.1.
- **Validation**: Read back docs; run release verification against a clean build artifact.

## Sprint 4: Cutover and Cleanup

**Goal**: Make compiled TypeScript output the only supported runtime path.

**Demo/Validation**:

- Fresh install/build/start works using documented commands.
- Health endpoint, dashboard, webhook route, poller, claim CLI, smoke path, and release artifact all work.

### Task 4.1: Switch deployment and package entrypoints

- **Location**: `ops-room/package.json`, service file, Docker/release files if applicable.
- **Description**: Point `main`, `start`, `server`, `poll`, `claim`, and systemd to emitted `.js` files under `dist`; ensure `prepare`/release builds run before startup.
- **Dependencies**: Sprint 3 complete.
- **Validation**: Clean checkout install, build, service dry-run/read-back, and local start.

### Task 4.2: Delete converted `.js` source and temporary compatibility code

- **Location**: Only files proven converted and unused.
- **Description**: Remove old source after import scans, tests, smoke checks, and release verification pass. Preserve intentional fixture examples and document any remaining `.js` files.
- **Dependencies**: Task 4.1.
- **Validation**: `rg --files ops-room -g '*.js'`; classify every remaining match; full verification suite.

## Testing Strategy

- Baseline before conversion: `npm test`, `npm run build:dashboard`, `npm run smoke:instances` where prerequisites exist.
- Per module layer: strict typecheck plus the nearest existing tests.
- Per sprint: compiled build, full tests, route/health smoke path, and release artifact verification.
- Add runtime schema guards for GitHub webhooks, AI responses, task JSON, and agent config; TypeScript types alone do not validate runtime data.
- Run a clean-install check on Node `20.19+` before cutover.

## TypeScript 7 Recommendation

Use TypeScript 7 as the target compiler, but keep the migration conservative:

1. Pin a tested 7.x version and record it in the lockfile.
2. Use `tsc` for typechecking/building; do not import TypeScript internals.
3. Check Vite, editor, and any future lint/type-aware tooling for TS7 compatibility.
4. If a tool requires the compiler API, keep that tool on the TypeScript 6 compatibility package until TS7 exposes its stable API.
5. Keep a fallback branch or lockfile change ready to return temporarily to TS6 if a production dependency blocks the cutover.

## Potential Risks & Gotchas

- ESM import extensions: source `.ts` imports must emit valid `.js` imports; verify Node execution, not only `tsc` success.
- Runtime data is untyped: GitHub, AI, JSON, and environment inputs need validation.
- Type widening can alter behavior in agent names, labels, task states, and review outcomes; use literal unions and regression tests.
- Node 20 deployment cannot be assumed to execute `.ts` directly; compiled output avoids environment-specific behavior.
- Systemd, Docker, release scripts, and docs may still point at `.js` entrypoints.
- Concurrent enhancement work can create rename conflicts; migrate stable modules after behavior changes land.
- TS7 ecosystem gaps may affect editor plugins or compiler-API consumers even if `tsc` works.

## Rollback Plan

- Keep each sprint in reviewable commits.
- Before deleting `.js`, verify the corresponding `.ts`/emitted `.js` path and retain the previous commit/branch.
- Roll back deployment pointers to the previous `.js` entrypoints if compiled startup, smoke checks, or release verification fails.
- Revert only the TypeScript version/tooling commit if TS7 compatibility—not application code—is the blocker.
