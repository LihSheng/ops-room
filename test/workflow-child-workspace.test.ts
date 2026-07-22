import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { handleWorkflowRunDetail } from '../src/routes/workflow-runs.js';
import {
  ensureWorkflowChildWorkspace,
  selectWorkflowChildWorkspacePlan,
} from '../src/services/workflow-child-workspace.js';
import {
  activateWorkflowChild,
  completeWorkflowChild,
  createOrLoadWorkflowRun,
  ensureWorkflowChild,
  readWorkflowRun,
} from '../src/services/workflow-run-store.js';

const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);
const SHA_C = 'c'.repeat(40);
const SHA_D = 'd'.repeat(40);

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'ops-room-workflow-child-workspace-'));
  const workflowRunsDir = join(root, 'workflow-runs');
  const created = await createOrLoadWorkflowRun({
    dir: workflowRunsDir,
    input: {
      repository: 'LihSheng/ops-room',
      requestKey: 'OPS-010D fixture',
      sourceSha: SHA_A,
    },
  });
  const implementation = await ensureWorkflowChild({
    dir: workflowRunsDir,
    workflowId: created.run.workflow_id,
    iteration: 1,
    stage: 'implementation',
    inputSha: SHA_A,
  });
  return {
    root,
    workflowRunsDir,
    workflowId: created.run.workflow_id,
    implementation: implementation.child,
  };
}

async function fullStageFixture() {
  const value = await fixture();
  const { workflowRunsDir, workflowId, implementation } = value;
  await activateWorkflowChild({ dir: workflowRunsDir, workflowId, childId: implementation.child_id });
  await completeWorkflowChild({ dir: workflowRunsDir, workflowId, childId: implementation.child_id, outputSha: SHA_B });

  const testChild = await ensureWorkflowChild({
    dir: workflowRunsDir,
    workflowId,
    iteration: 1,
    stage: 'test',
    inputSha: SHA_B,
  });
  await activateWorkflowChild({ dir: workflowRunsDir, workflowId, childId: testChild.child.child_id });
  await completeWorkflowChild({ dir: workflowRunsDir, workflowId, childId: testChild.child.child_id, outputSha: SHA_C });

  const integration = await ensureWorkflowChild({
    dir: workflowRunsDir,
    workflowId,
    iteration: 1,
    stage: 'integration',
    inputSha: SHA_C,
  });
  await activateWorkflowChild({ dir: workflowRunsDir, workflowId, childId: integration.child.child_id });
  await completeWorkflowChild({ dir: workflowRunsDir, workflowId, childId: integration.child.child_id, outputSha: SHA_D });

  const review = await ensureWorkflowChild({
    dir: workflowRunsDir,
    workflowId,
    iteration: 1,
    stage: 'review',
    inputSha: SHA_D,
  });
  const run = await readWorkflowRun({ dir: workflowRunsDir, workflowId });
  return {
    ...value,
    run,
    testChild: run.children.find((child) => child.child_id === testChild.child.child_id),
    integration: run.children.find((child) => child.child_id === integration.child.child_id),
    review: run.children.find((child) => child.child_id === review.child.child_id),
  };
}

function roots(root) {
  return {
    cacheRoot: join(root, 'repositories'),
    workspaceRoot: join(root, 'workspaces'),
    recordRoot: join(root, 'workspace-records'),
    lockRoot: join(root, 'workspace-locks'),
    remote: 'https://example.invalid/ops-room.git',
  };
}

function workspaceRecord({ run, child, plan, overrides = {} }) {
  return {
    workspace_id: plan.workspace_id,
    owner_agent: child.owner_agent,
    task_id: child.child_id,
    repository_id: run.repository_id,
    mode: plan.mode,
    branch: plan.branch,
    requested_sha: child.input_sha,
    resolved_sha: child.input_sha,
    relative_path: `${child.owner_agent}/${plan.workspace_id}`,
    state: 'active',
    ...overrides,
  };
}

test('stage plans preserve canonical branch and exact-SHA boundaries', async () => {
  const value = await fullStageFixture();
  try {
    const implementation = value.run.children.find((child) => child.stage === 'implementation');
    const implementationPlan = selectWorkflowChildWorkspacePlan({ run: value.run, child: implementation });
    const testPlan = selectWorkflowChildWorkspacePlan({ run: value.run, child: value.testChild });
    const integrationPlan = selectWorkflowChildWorkspacePlan({ run: value.run, child: value.integration });
    const reviewPlan = selectWorkflowChildWorkspacePlan({ run: value.run, child: value.review });

    assert.equal(implementationPlan.mode, 'branch');
    assert.equal(implementationPlan.revision, SHA_A);
    assert.equal(testPlan.mode, 'branch');
    assert.equal(testPlan.revision, SHA_B);
    assert.notEqual(testPlan.branch, implementationPlan.branch);
    assert.equal(integrationPlan.branch, implementationPlan.branch);
    assert.equal(integrationPlan.revision, SHA_C);
    assert.equal(reviewPlan.mode, 'detached');
    assert.equal(reviewPlan.branch, null);
    assert.equal(reviewPlan.revision, SHA_D);
    assert.match(reviewPlan.workspace_id, /^task-berlin-/);
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

test('binding persists bounded workspace metadata and is idempotently reusable', async () => {
  const value = await fixture();
  try {
    const initialRun = await readWorkflowRun({ dir: value.workflowRunsDir, workflowId: value.workflowId });
    const initialChild = initialRun.children[0];
    const plan = selectWorkflowChildWorkspacePlan({ run: initialRun, child: initialChild });
    const record = workspaceRecord({ run: initialRun, child: initialChild, plan });
    const calls = [];

    const first = await ensureWorkflowChildWorkspace({
      workflowRunsDir: value.workflowRunsDir,
      workflowId: value.workflowId,
      childId: initialChild.child_id,
      ...roots(value.root),
      ensureWorkspace: async ({ task }) => {
        calls.push(task);
        return {
          record,
          workspace_path: join(value.root, 'workspaces', record.relative_path),
          reused: false,
        };
      },
      now: () => '2026-07-20T06:30:00.000Z',
    });

    assert.equal(first.created, true);
    assert.equal(first.workspace_reused, false);
    assert.equal(first.workspace.workspace_id, plan.workspace_id);
    assert.equal(Object.hasOwn(first.workspace, 'relative_path'), false);

    const second = await ensureWorkflowChildWorkspace({
      workflowRunsDir: value.workflowRunsDir,
      workflowId: value.workflowId,
      childId: initialChild.child_id,
      ...roots(value.root),
      ensureWorkspace: async ({ task }) => {
        calls.push(task);
        assert.equal(task.workspace_id, plan.workspace_id);
        return {
          record,
          workspace_path: join(value.root, 'workspaces', record.relative_path),
          reused: true,
        };
      },
    });

    assert.equal(second.created, false);
    assert.equal(second.workspace_reused, true);
    assert.equal(calls.length, 2);

    const stored = await readWorkflowRun({ dir: value.workflowRunsDir, workflowId: value.workflowId });
    assert.deepEqual(stored.children[0].workspace, first.workspace);
    assert.equal(stored.history.filter((event) => event.event === 'workflow_child_workspace_bound').length, 1);
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

test('allocation crash recovery reuses the deterministic existing workspace', async () => {
  const value = await fixture();
  try {
    const run = await readWorkflowRun({ dir: value.workflowRunsDir, workflowId: value.workflowId });
    const child = run.children[0];
    const plan = selectWorkflowChildWorkspacePlan({ run, child });
    const record = workspaceRecord({ run, child, plan });
    let calls = 0;

    const result = await ensureWorkflowChildWorkspace({
      workflowRunsDir: value.workflowRunsDir,
      workflowId: value.workflowId,
      childId: child.child_id,
      ...roots(value.root),
      ensureWorkspace: async ({ task }) => {
        calls += 1;
        if (calls === 1) {
          assert.equal(task.workspace_id, undefined);
          throw new Error('workspace_id_conflict');
        }
        assert.equal(task.workspace_id, plan.workspace_id);
        return {
          record,
          workspace_path: join(value.root, 'workspaces', record.relative_path),
          reused: true,
        };
      },
    });

    assert.equal(calls, 2);
    assert.equal(result.workspace_reused, true);
    assert.equal(result.workspace.workspace_id, plan.workspace_id);
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

test('workspace ownership, branch, and SHA mismatches fail closed', async () => {
  const value = await fixture();
  try {
    const run = await readWorkflowRun({ dir: value.workflowRunsDir, workflowId: value.workflowId });
    const child = run.children[0];
    const plan = selectWorkflowChildWorkspacePlan({ run, child });

    for (const [overrides, expected] of [
      [{ owner_agent: 'tokyo' }, /workflow_child_workspace_owner_mismatch/],
      [{ branch: 'agent/professor/wrong' }, /workflow_child_workspace_branch_mismatch/],
      [{ resolved_sha: SHA_B }, /workflow_child_workspace_resolved_sha_mismatch/],
    ]) {
      await assert.rejects(
        ensureWorkflowChildWorkspace({
          workflowRunsDir: value.workflowRunsDir,
          workflowId: value.workflowId,
          childId: child.child_id,
          ...roots(value.root),
          ensureWorkspace: async () => ({
            record: workspaceRecord({ run, child, plan, overrides }),
            workspace_path: join(value.root, 'unused'),
            reused: false,
          }),
        }),
        expected,
      );
    }
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

test('a completed unbound child cannot allocate a workspace retrospectively', async () => {
  const value = await fixture();
  try {
    await activateWorkflowChild({
      dir: value.workflowRunsDir,
      workflowId: value.workflowId,
      childId: value.implementation.child_id,
    });
    await completeWorkflowChild({
      dir: value.workflowRunsDir,
      workflowId: value.workflowId,
      childId: value.implementation.child_id,
      outputSha: SHA_B,
    });
    let calls = 0;

    await assert.rejects(
      ensureWorkflowChildWorkspace({
        workflowRunsDir: value.workflowRunsDir,
        workflowId: value.workflowId,
        childId: value.implementation.child_id,
        ...roots(value.root),
        ensureWorkspace: async () => { calls += 1; return null; },
      }),
      /workflow_child_workspace_not_bindable:completed/,
    );
    assert.equal(calls, 0);
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

test('workflow read output exposes only bounded workspace metadata', async () => {
  const value = await fixture();
  try {
    const run = await readWorkflowRun({ dir: value.workflowRunsDir, workflowId: value.workflowId });
    const child = run.children[0];
    const plan = selectWorkflowChildWorkspacePlan({ run, child });
    const record = workspaceRecord({ run, child, plan });

    await ensureWorkflowChildWorkspace({
      workflowRunsDir: value.workflowRunsDir,
      workflowId: value.workflowId,
      childId: child.child_id,
      ...roots(value.root),
      ensureWorkspace: async () => ({
        record: {
          ...record,
          cache_path: '/secret/cache',
          remote: 'https://token@example.invalid/repo.git',
          credentials: { token: 'secret' },
        },
        workspace_path: '/secret/workspace',
        reused: false,
      }),
    });

    const stored = await readWorkflowRun({ dir: value.workflowRunsDir, workflowId: value.workflowId });
    const result = await handleWorkflowRunDetail(value.workflowId, {
      workflowRunsDir: value.workflowRunsDir,
      readRun: async () => stored,
    });
    const workspace = result.body.workflow.children[0].workspace;

    assert.equal(workspace.workspace_id, plan.workspace_id);
    assert.equal(workspace.resolved_sha, SHA_A);
    assert.equal(Object.hasOwn(workspace, 'relative_path'), false);
    assert.equal(Object.hasOwn(workspace, 'cache_path'), false);
    assert.equal(Object.hasOwn(workspace, 'remote'), false);
    assert.equal(Object.hasOwn(workspace, 'credentials'), false);
    assert.equal(JSON.stringify(result.body).includes('/secret/'), false);
    assert.equal(JSON.stringify(result.body).includes('token@example'), false);
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});
