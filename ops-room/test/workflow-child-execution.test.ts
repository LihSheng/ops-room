import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { executeWorkflowChild } from '../src/services/workflow-child-execution.js';

const INPUT_SHA = 'a'.repeat(40);
const OUTPUT_SHA = 'b'.repeat(40);
const WORKFLOW_ID = 'workflow:LihSheng-ops-room:1234567890abcdef12345678';
const CHILD_ID = `${WORKFLOW_ID}:1:implementation`;

function child(overrides: any = {}) {
  return {
    child_id: CHILD_ID,
    stage: 'implementation',
    owner_agent: 'professor',
    iteration: 1,
    attempt: 0,
    state: 'pending',
    depends_on: null,
    input_sha: INPUT_SHA,
    output_sha: null,
    created_at: '2026-07-20T00:00:00.000Z',
    updated_at: '2026-07-20T00:00:00.000Z',
    started_at: null,
    completed_at: null,
    last_error: null,
    workspace: {
      workspace_id: 'task-professor-1234567890abcdef',
      mode: 'branch',
      repository_id: 'LihSheng/ops-room',
      branch: 'agent/professor/feature-123-i1',
      resolved_sha: INPUT_SHA,
      state: 'active',
      held_for_investigation: false,
      cleanup_requested: false,
    },
    history: [],
    ...overrides,
  };
}

function run(childValue = child(), overrides: any = {}) {
  return {
    schema: 'ops-room.workflow-run.v1',
    version: 1,
    workflow_id: WORKFLOW_ID,
    workflow_type: 'feature-development',
    repository_id: 'LihSheng/ops-room',
    request_key: 'OPS-010E',
    source_sha: INPUT_SHA,
    state: 'active',
    policy: { max_iterations: 3, max_concurrency: 1 },
    current_iteration: 1,
    children: [childValue],
    created_at: '2026-07-20T00:00:00.000Z',
    updated_at: '2026-07-20T00:00:00.000Z',
    history: [],
    ...overrides,
  };
}

function binding(childValue = child()) {
  return {
    workspace_path: '/internal/workspace/path',
    workspace: childValue.workspace,
    record: {
      version: 1,
      workspace_id: childValue.workspace.workspace_id,
      task_id: childValue.child_id,
      owner_agent: childValue.owner_agent,
      repository_id: 'LihSheng/ops-room',
      mode: childValue.workspace.mode,
      branch: childValue.workspace.branch,
      requested_sha: INPUT_SHA,
      resolved_sha: INPUT_SHA,
      relative_path: 'professor/task-professor-1234567890abcdef',
      state: 'active',
    },
  };
}

async function lockDir() {
  return mkdtemp(join(tmpdir(), 'ops-room-workflow-execution-'));
}

function baseInput(overrides: any = {}) {
  return {
    workflowRunsDir: '/workflow-runs',
    workflowId: WORKFLOW_ID,
    childId: CHILD_ID,
    cacheRoot: '/cache',
    workspaceRoot: '/workspaces',
    recordRoot: '/records',
    lockRoot: '/workspace-locks',
    remote: 'https://example.invalid/repo.git',
    executionLockDir: null,
    ...overrides,
  };
}

test('explicit writable child execution persists completion before cleanup request', async () => {
  const pendingChild = child();
  const activeChild = child({ state: 'active', started_at: '2026-07-20T00:01:00.000Z' });
  const completedChild = child({
    state: 'completed',
    output_sha: OUTPUT_SHA,
    completed_at: '2026-07-20T00:02:00.000Z',
  });
  const calls: string[] = [];

  const result = await executeWorkflowChild(baseInput({
    executionLockDir: await lockDir(),
    readRun: async () => run(pendingChild),
    ensureChildWorkspace: async () => binding(pendingChild),
    activateChild: async () => {
      calls.push('activate');
      return { run: run(activeChild), child: activeChild };
    },
    runStage: async (input: any) => {
      calls.push('runner');
      assert.equal(input.workspace_path, '/internal/workspace/path');
      assert.equal(input.child.owner_agent, 'professor');
      assert.equal(Object.hasOwn(input.child, 'history'), false);
      assert.equal(Object.hasOwn(input.run, 'request_key'), false);
      return { outcome: 'completed', output_sha: OUTPUT_SHA, raw_output: 'must not persist' };
    },
    inspectWorkspaceHead: async () => {
      calls.push('inspect');
      return OUTPUT_SHA;
    },
    completeChild: async ({ outputSha }: any) => {
      calls.push(`complete:${outputSha}`);
      return { run: run(completedChild), child: completedChild };
    },
    applyWorkspaceOutcome: async ({ outcome }: any) => {
      calls.push(`policy:${outcome}`);
      return { action: 'cleanup', workspace: { ...pendingChild.workspace, state: 'cleanup_requested' } };
    },
  }));

  assert.deepEqual(calls, [
    'activate',
    'runner',
    'inspect',
    `complete:${OUTPUT_SHA}`,
    'policy:completed',
  ]);
  assert.equal(result.child.state, 'completed');
  assert.equal(result.child.output_sha, OUTPUT_SHA);
  assert.equal(result.workspace_action, 'cleanup');
  assert.equal(Object.hasOwn(result, 'workspace_path'), false);
});

test('review children require immutable output SHA and do not use a workspace-head inspector', async () => {
  const reviewId = `${WORKFLOW_ID}:1:review`;
  const pending = child({
    child_id: reviewId,
    stage: 'review',
    owner_agent: 'berlin',
    input_sha: OUTPUT_SHA,
    workspace: {
      workspace_id: 'task-berlin-1234567890abcdef',
      mode: 'detached',
      repository_id: 'LihSheng/ops-room',
      branch: null,
      resolved_sha: OUTPUT_SHA,
      state: 'active',
      held_for_investigation: false,
      cleanup_requested: false,
    },
  });
  const active = { ...pending, state: 'active' };
  const terminal = { ...active, state: 'needs_human', last_error: 'workflow_review_output_sha_mismatch' };
  let inspected = false;

  const result = await executeWorkflowChild(baseInput({
    childId: reviewId,
    executionLockDir: await lockDir(),
    readRun: async () => run(pending),
    ensureChildWorkspace: async () => binding(pending),
    activateChild: async () => ({ run: run(active), child: active }),
    runStage: async () => ({ outcome: 'completed', output_sha: INPUT_SHA }),
    inspectWorkspaceHead: async () => { inspected = true; return INPUT_SHA; },
    markNeedsHuman: async ({ reason }: any) => {
      assert.equal(reason, 'workflow_review_output_sha_mismatch');
      return { run: run(terminal, { state: 'needs_human' }), child: terminal };
    },
    applyWorkspaceOutcome: async () => ({ action: 'hold', workspace: { ...pending.workspace, state: 'held_for_investigation' } }),
  }));

  assert.equal(inspected, false);
  assert.equal(result.child.state, 'needs_human');
  assert.equal(result.child.last_error, 'workflow_review_output_sha_mismatch');
  assert.equal(result.workspace_action, 'hold');
});

test('runner needs-human outcome is bounded and holds the workspace', async () => {
  const pending = child();
  const active = child({ state: 'active' });
  const terminal = child({ state: 'needs_human', last_error: 'verification_failed' });

  const result = await executeWorkflowChild(baseInput({
    executionLockDir: await lockDir(),
    readRun: async () => run(pending),
    ensureChildWorkspace: async () => binding(pending),
    activateChild: async () => ({ run: run(active), child: active }),
    runStage: async () => ({ outcome: 'needs_human', reason: 'verification_failed' }),
    markNeedsHuman: async ({ reason }: any) => {
      assert.equal(reason, 'verification_failed');
      return { run: run(terminal, { state: 'needs_human' }), child: terminal };
    },
    applyWorkspaceOutcome: async ({ outcome, reason }: any) => {
      assert.equal(outcome, 'needs_human');
      assert.equal(reason, 'verification_failed');
      return { action: 'hold', workspace: { ...pending.workspace, state: 'held_for_investigation' } };
    },
  }));

  assert.equal(result.child.state, 'needs_human');
  assert.equal(result.workspace_action, 'hold');
});

test('unsafe runner errors are not persisted verbatim', async () => {
  const pending = child();
  const active = child({ state: 'active' });
  const terminal = child({ state: 'needs_human', last_error: 'workflow_child_runner_failed' });
  let storedReason = null;

  await executeWorkflowChild(baseInput({
    executionLockDir: await lockDir(),
    readRun: async () => run(pending),
    ensureChildWorkspace: async () => binding(pending),
    activateChild: async () => ({ run: run(active), child: active }),
    runStage: async () => { throw new Error('provider failed with token super-secret-value'); },
    markNeedsHuman: async ({ reason }: any) => {
      storedReason = reason;
      return { run: run(terminal, { state: 'needs_human' }), child: terminal };
    },
    applyWorkspaceOutcome: async () => ({ action: 'hold', workspace: pending.workspace }),
  }));

  assert.equal(storedReason, 'workflow_child_runner_failed');
});

test('completed and needs-human children deduplicate without invoking the runner', async () => {
  for (const state of ['completed', 'needs_human']) {
    let calls = 0;
    const terminal = child({
      state,
      output_sha: state === 'completed' ? OUTPUT_SHA : null,
      completed_at: state === 'completed' ? '2026-07-20T00:02:00.000Z' : null,
      last_error: state === 'needs_human' ? 'verification_failed' : null,
    });
    const result = await executeWorkflowChild(baseInput({
      executionLockDir: await lockDir(),
      readRun: async () => run(terminal, { state: state === 'needs_human' ? 'needs_human' : 'active' }),
      runStage: async () => { calls += 1; return { outcome: 'completed', output_sha: OUTPUT_SHA }; },
    }));
    assert.equal(result.deduplicated, true);
    assert.equal(calls, 0);
  }
});

test('an active child is never replayed', async () => {
  const active = child({ state: 'active' });
  await assert.rejects(
    executeWorkflowChild(baseInput({
      executionLockDir: await lockDir(),
      readRun: async () => run(active),
      runStage: async () => ({ outcome: 'completed', output_sha: OUTPUT_SHA }),
    })),
    /workflow_child_execution_in_progress/,
  );
});

test('concurrent explicit attempts serialize and execute the runner once', async () => {
  const executionLockDir = await lockDir();
  let state = 'pending';
  let runnerCalls = 0;
  let releaseRunner: () => void;
  let markStarted: () => void;
  const runnerStarted = new Promise<void>((resolve) => { markStarted = resolve; });
  const runnerRelease = new Promise<void>((resolve) => { releaseRunner = resolve; });

  const currentChild = () => child({
    state,
    output_sha: state === 'completed' ? OUTPUT_SHA : null,
    completed_at: state === 'completed' ? '2026-07-20T00:02:00.000Z' : null,
  });

  const input = baseInput({
    executionLockDir,
    executionLockTimeoutMs: 2_000,
    readRun: async () => run(currentChild()),
    ensureChildWorkspace: async () => binding(currentChild()),
    activateChild: async () => {
      state = 'active';
      return { run: run(currentChild()), child: currentChild() };
    },
    runStage: async () => {
      runnerCalls += 1;
      markStarted();
      await runnerRelease;
      return { outcome: 'completed', output_sha: OUTPUT_SHA };
    },
    inspectWorkspaceHead: async () => OUTPUT_SHA,
    completeChild: async () => {
      state = 'completed';
      return { run: run(currentChild()), child: currentChild() };
    },
    applyWorkspaceOutcome: async () => ({ action: 'cleanup', workspace: currentChild().workspace }),
  });

  const first = executeWorkflowChild(input);
  await runnerStarted;
  const second = executeWorkflowChild(input);
  releaseRunner();

  const [firstResult, secondResult] = await Promise.all([first, second]);
  assert.equal(firstResult.child.state, 'completed');
  assert.equal(secondResult.deduplicated, true);
  assert.equal(runnerCalls, 1);
});

test('workspace policy failure occurs after immutable completion and does not mark needs-human', async () => {
  const pending = child();
  const active = child({ state: 'active' });
  const completed = child({ state: 'completed', output_sha: OUTPUT_SHA, completed_at: '2026-07-20T00:02:00.000Z' });
  let completionPersisted = false;
  let needsHumanCalls = 0;

  await assert.rejects(
    executeWorkflowChild(baseInput({
      executionLockDir: await lockDir(),
      readRun: async () => run(pending),
      ensureChildWorkspace: async () => binding(pending),
      activateChild: async () => ({ run: run(active), child: active }),
      runStage: async () => ({ outcome: 'completed', output_sha: OUTPUT_SHA }),
      inspectWorkspaceHead: async () => OUTPUT_SHA,
      completeChild: async () => {
        completionPersisted = true;
        return { run: run(completed), child: completed };
      },
      markNeedsHuman: async () => { needsHumanCalls += 1; throw new Error('should_not_run'); },
      applyWorkspaceOutcome: async () => { throw new Error('workspace_store_unavailable'); },
    })),
    /workspace_store_unavailable/,
  );

  assert.equal(completionPersisted, true);
  assert.equal(needsHumanCalls, 0);
});
