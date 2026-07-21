import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { listWorkflowEffects } from '../src/services/workflow-effect-store.js';
import { createWorkflowStageRunner } from '../src/services/workflow-stage-runner.js';

const INPUT_SHA = 'a'.repeat(40);
const OUTPUT_SHA = 'b'.repeat(40);
const WORKFLOW_ID = 'workflow:LihSheng-ops-room:1234567890abcdef12345678';

async function effectDir() {
  return mkdtemp(join(tmpdir(), 'ops-room-stage-runner-'));
}

function run() {
  return {
    workflow_id: WORKFLOW_ID,
    workflow_type: 'feature-development',
    repository_id: 'LihSheng/ops-room',
    source_sha: INPUT_SHA,
    state: 'active',
    current_iteration: 1,
    policy: { max_iterations: 3, max_concurrency: 1 },
  };
}

function child(stage: string, ownerAgent: string, overrides: any = {}) {
  return {
    child_id: `${WORKFLOW_ID}:1:${stage}`,
    stage,
    owner_agent: ownerAgent,
    iteration: 1,
    attempt: 0,
    state: 'active',
    depends_on: null,
    input_sha: INPUT_SHA,
    ...overrides,
  };
}

function workspace(stage: string) {
  return {
    workspace_id: `task-${stage}-1234567890abcdef`,
    mode: stage === 'review' ? 'detached' : 'branch',
    repository_id: 'LihSheng/ops-room',
    branch: stage === 'review' ? null : `agent/${stage}/feature-123-i1`,
    resolved_sha: INPUT_SHA,
    state: 'active',
  };
}

function runnerInput(stage: string, ownerAgent: string, overrides: any = {}) {
  return {
    run: run(),
    child: child(stage, ownerAgent),
    workspace_path: '/internal/workspace/path',
    workspace: workspace(stage),
    ...overrides,
  };
}

test('each workflow stage invokes only its authorized provider adapter', async () => {
  const cases = [
    ['implementation', 'professor'],
    ['test', 'tokyo'],
    ['integration', 'professor'],
    ['review', 'berlin'],
  ];

  for (const [stage, expectedOwner] of cases) {
    const effectsDir = await effectDir();
    const calls: string[] = [];
    const providerAdapters = {
      professor: async () => { calls.push('professor'); return { outcome: 'completed', output_sha: OUTPUT_SHA }; },
      tokyo: async () => { calls.push('tokyo'); return { outcome: 'completed', output_sha: OUTPUT_SHA }; },
      berlin: async () => { calls.push('berlin'); return { outcome: 'completed', output_sha: OUTPUT_SHA }; },
    };
    const execute = createWorkflowStageRunner({
      effectsDir,
      providerAdapters,
      resolveStageInstruction: async () => `Complete ${stage}`,
    });

    const result = await execute(runnerInput(stage, expectedOwner));
    assert.deepEqual(calls, [expectedOwner]);
    assert.equal(result.outcome, 'completed');
    assert.equal(result.output_sha, OUTPUT_SHA);
  }
});

test('stage ownership mismatch fails before any provider invocation', async () => {
  const effectsDir = await effectDir();
  let calls = 0;
  const execute = createWorkflowStageRunner({
    effectsDir,
    providerAdapters: {
      professor: async () => { calls += 1; return { outcome: 'completed', output_sha: OUTPUT_SHA }; },
      tokyo: async () => { calls += 1; return { outcome: 'completed', output_sha: OUTPUT_SHA }; },
      berlin: async () => { calls += 1; return { outcome: 'completed', output_sha: OUTPUT_SHA }; },
    },
    resolveStageInstruction: async () => 'Implement the requested change',
  });

  await assert.rejects(
    execute(runnerInput('test', 'professor')),
    /workflow_provider_stage_owner_mismatch/,
  );
  assert.equal(calls, 0);
  assert.equal((await listWorkflowEffects({ dir: effectsDir })).length, 0);
});

test('completed provider effects replay recorded evidence without running twice', async () => {
  const effectsDir = await effectDir();
  let calls = 0;
  const execute = createWorkflowStageRunner({
    effectsDir,
    providerAdapters: {
      professor: async () => {
        calls += 1;
        return JSON.stringify({ outcome: 'completed', output_sha: OUTPUT_SHA });
      },
    },
    resolveStageInstruction: async () => 'Implement the requested change',
  });
  const input = runnerInput('implementation', 'professor');

  const first = await execute(input);
  const replay = await execute(input);

  assert.equal(first.outcome, 'completed');
  assert.equal(replay.outcome, 'completed');
  assert.equal(replay.output_sha, OUTPUT_SHA);
  assert.equal(calls, 1);
});

test('malformed provider output is bounded and raw output is never persisted', async () => {
  const effectsDir = await effectDir();
  const execute = createWorkflowStageRunner({
    effectsDir,
    providerAdapters: {
      professor: async () => 'token=super-secret-value and not JSON',
    },
    resolveStageInstruction: async () => 'Implement the requested change',
  });

  const result = await execute(runnerInput('implementation', 'professor'));
  const effects = await listWorkflowEffects({ dir: effectsDir });

  assert.deepEqual(result, { outcome: 'needs_human', reason: 'workflow_provider_output_invalid' });
  assert.equal(effects.length, 1);
  assert.equal(effects[0].state, 'needs_human');
  assert.equal(effects[0].result_code, 'workflow_provider_output_invalid');
  assert.equal(JSON.stringify(effects).includes('super-secret-value'), false);
});

test('unsafe provider exceptions are reduced to a bounded reason code', async () => {
  const effectsDir = await effectDir();
  const execute = createWorkflowStageRunner({
    effectsDir,
    providerAdapters: {
      professor: async () => { throw new Error('provider failed with token super-secret-value'); },
    },
    resolveStageInstruction: async () => 'Implement the requested change',
  });

  const result = await execute(runnerInput('implementation', 'professor'));
  const effects = await listWorkflowEffects({ dir: effectsDir });

  assert.deepEqual(result, { outcome: 'needs_human', reason: 'workflow_provider_failed' });
  assert.equal(effects[0].result_code, 'workflow_provider_failed');
  assert.equal(JSON.stringify(effects).includes('super-secret-value'), false);
});

test('pre-cancelled provider execution records a safe cancellation outcome', async () => {
  const effectsDir = await effectDir();
  const controller = new AbortController();
  controller.abort();
  let calls = 0;
  const execute = createWorkflowStageRunner({
    effectsDir,
    signal: controller.signal,
    providerAdapters: {
      professor: async () => { calls += 1; return { outcome: 'completed', output_sha: OUTPUT_SHA }; },
    },
    resolveStageInstruction: async () => 'Implement the requested change',
  });

  const result = await execute(runnerInput('implementation', 'professor'));
  const effects = await listWorkflowEffects({ dir: effectsDir });

  assert.deepEqual(result, { outcome: 'needs_human', reason: 'workflow_provider_cancelled' });
  assert.equal(effects[0].result_code, 'workflow_provider_cancelled');
  assert.equal(calls, 0);
});

test('provider timeout aborts the adapter and records bounded needs-human evidence', async () => {
  const effectsDir = await effectDir();
  let providerSignal: AbortSignal | null = null;
  const execute = createWorkflowStageRunner({
    effectsDir,
    providerTimeoutMs: 1_000,
    providerAdapters: {
      professor: async ({ signal }: any) => {
        providerSignal = signal;
        return new Promise(() => {});
      },
    },
    resolveStageInstruction: async () => 'Implement the requested change',
  });

  const result = await execute(runnerInput('implementation', 'professor'));
  const effects = await listWorkflowEffects({ dir: effectsDir });

  assert.deepEqual(result, { outcome: 'needs_human', reason: 'workflow_provider_timeout' });
  assert.equal(providerSignal?.aborted, true);
  assert.equal(effects[0].state, 'needs_human');
  assert.equal(effects[0].result_code, 'workflow_provider_timeout');
});
