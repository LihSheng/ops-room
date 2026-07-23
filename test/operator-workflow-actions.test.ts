import assert from 'node:assert/strict';
import { mkdir, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  applyOperatorReviewDecision,
  handleOperatorWorkflowAction,
} from '../src/services/operator-workflow-actions.js';
import { advanceWorkflowRun } from '../src/services/workflow-advancement.js';
import {
  activateWorkflowChild,
  completeWorkflowChild,
  createOrLoadWorkflowRun,
  ensureWorkflowChild,
  readWorkflowRun,
} from '../src/services/workflow-run-store.js';

const SOURCE_SHA = 'a'.repeat(40);
const WRITABLE_OUTPUTS = ['b', 'c', 'd'];
const ACTOR = {
  actor_id: 'operator-test',
  actor_type: 'human',
  display_name: 'Operator Test',
};

async function testDirs() {
  const root = await mkdtemp(join(tmpdir(), 'ops-room-operator-workflow-'));
  const dirs = {
    root,
    workflows: join(root, 'workflows'),
    effects: join(root, 'effects'),
    workspaces: join(root, 'workspaces'),
    records: join(root, 'records'),
    audit: join(root, 'audit'),
    idempotency: join(root, 'idempotency'),
  };
  await Promise.all(Object.values(dirs).slice(1).map((dir) => mkdir(dir, { recursive: true })));
  return dirs;
}

async function createRun(dir: string, maxIterations = 3) {
  const created = await createOrLoadWorkflowRun({
    dir,
    input: {
      repository_id: 'LihSheng/ops-room',
      request_key: `OPS-012F.2-${Date.now()}-${Math.random()}`,
      source_sha: SOURCE_SHA,
    },
    policy: { max_iterations: maxIterations, max_concurrency: 1 },
  });
  return created.run;
}

async function createWorkflowAwaitingBerlinDecision(dir: string, maxIterations = 3) {
  const run = await createRun(dir, maxIterations);
  let outputIndex = 0;
  let providerCalls = 0;
  const result = await advanceWorkflowRun({
    workflowRunsDir: dir,
    workflowId: run.workflow_id,
    executeChild: async ({ workflowRunsDir, workflowId, childId }: any) => {
      providerCalls += 1;
      const activated = await activateWorkflowChild({
        dir: workflowRunsDir,
        workflowId,
        childId,
      });
      const child = activated.child;
      const outputSha = child.stage === 'review'
        ? child.input_sha
        : WRITABLE_OUTPUTS[outputIndex++].repeat(40);
      return completeWorkflowChild({
        dir: workflowRunsDir,
        workflowId,
        childId,
        outputSha,
      });
    },
  });
  assert.equal(result.action, 'needs_human');
  assert.equal(result.run.last_error, 'workflow_review_decision_missing');
  const stored = await readWorkflowRun({ dir, workflowId: run.workflow_id });
  const review = stored.children.find((child: any) => child.stage === 'review');
  return { run: stored, review, providerCalls };
}

test('operator approval reactivates a missing-decision workflow and completes without provider execution', async () => {
  const dirs = await testDirs();
  const awaiting = await createWorkflowAwaitingBerlinDecision(dirs.workflows);

  const result = await applyOperatorReviewDecision({
    workflowRunsDir: dirs.workflows,
    workflowId: awaiting.run.workflow_id,
    childId: awaiting.review.child_id,
    expectedAttempt: awaiting.review.attempt,
    decision: 'approved',
  });

  assert.equal(result.provider_invoked, false);
  assert.equal(result.run.state, 'completed');
  assert.equal(result.child.review_decision, 'approved');
  assert.equal(result.next_child, null);

  const stored = await readWorkflowRun({
    dir: dirs.workflows,
    workflowId: awaiting.run.workflow_id,
  });
  assert.equal(stored.state, 'completed');
  assert.equal(stored.children.length, 4);
  assert.equal(stored.children.find((child: any) => child.stage === 'review').review_decision, 'approved');
});

test('changes requested creates one deterministic next iteration without dispatching it', async () => {
  const dirs = await testDirs();
  const awaiting = await createWorkflowAwaitingBerlinDecision(dirs.workflows, 3);

  const result = await applyOperatorReviewDecision({
    workflowRunsDir: dirs.workflows,
    workflowId: awaiting.run.workflow_id,
    childId: awaiting.review.child_id,
    expectedAttempt: awaiting.review.attempt,
    decision: 'changes_requested',
  });

  assert.equal(result.provider_invoked, false);
  assert.equal(result.run.state, 'active');
  assert.equal(result.run.current_iteration, 2);
  assert.equal(result.child.review_decision, 'changes_requested');
  assert.equal(result.next_child.stage, 'implementation');
  assert.equal(result.next_child.iteration, 2);
  assert.equal(result.next_child.state, 'pending');
  assert.equal(result.next_child.input_sha, awaiting.review.output_sha);

  const repeated = await applyOperatorReviewDecision({
    workflowRunsDir: dirs.workflows,
    workflowId: awaiting.run.workflow_id,
    childId: awaiting.review.child_id,
    expectedAttempt: awaiting.review.attempt,
    decision: 'changes_requested',
  });
  assert.equal(repeated.idempotent, true);
  assert.equal(repeated.next_child.child_id, result.next_child.child_id);

  const stored = await readWorkflowRun({
    dir: dirs.workflows,
    workflowId: awaiting.run.workflow_id,
  });
  assert.equal(stored.children.length, 5);
  assert.equal(stored.children.filter((child: any) => child.iteration === 2).length, 1);
});

test('changes requested at the iteration limit escalates without invoking a provider', async () => {
  const dirs = await testDirs();
  const awaiting = await createWorkflowAwaitingBerlinDecision(dirs.workflows, 1);

  const result = await applyOperatorReviewDecision({
    workflowRunsDir: dirs.workflows,
    workflowId: awaiting.run.workflow_id,
    childId: awaiting.review.child_id,
    expectedAttempt: awaiting.review.attempt,
    decision: 'changes_requested',
  });

  assert.equal(result.provider_invoked, false);
  assert.equal(result.run.state, 'needs_human');
  assert.equal(result.run.last_error, 'workflow_iteration_limit_exceeded');
  assert.equal(result.next_child, null);
});

test('workflow retry request is audited and idempotent while delegating exact target evidence once', async () => {
  const dirs = await testDirs();
  const run = await createRun(dirs.workflows);
  const ensured = await ensureWorkflowChild({
    dir: dirs.workflows,
    workflowId: run.workflow_id,
    iteration: 1,
    stage: 'implementation',
    inputSha: SOURCE_SHA,
  });
  let calls = 0;
  const retryChild = async (input: any) => {
    calls += 1;
    assert.equal(input.workflowId, run.workflow_id);
    assert.equal(input.childId, ensured.child.child_id);
    assert.equal(input.expectedAttempt, 0);
    assert.equal(input.effectsDir, dirs.effects);
    assert.equal(input.workspaceRoot, dirs.workspaces);
    assert.equal(input.recordRoot, dirs.records);
    return {
      run: { ...ensured.run, state: 'active' },
      child: { ...ensured.child, state: 'pending', attempt: 1 },
      idempotent: false,
      previous_effect: { effect_id: 'effect-1' },
    };
  };

  const request = {
    action: 'retry',
    workflowId: run.workflow_id,
    childId: ensured.child.child_id,
    body: {
      reason: 'Retry after reviewing terminal effect evidence',
      expected_attempt: 0,
      idempotency_key: 'ops-012f-retry-0001',
    },
    actor: ACTOR,
    workflowRunsDir: dirs.workflows,
    effectsDir: dirs.effects,
    workspaceRoot: dirs.workspaces,
    recordRoot: dirs.records,
    auditDir: dirs.audit,
    idempotencyDir: dirs.idempotency,
    retryChild,
  };

  const first = await handleOperatorWorkflowAction(request);
  assert.equal(first.status, 202);
  assert.equal(first.body.operation, 'workflow.child.retry');
  assert.equal(first.body.provider_invoked, false);
  assert.equal(first.body.idempotent_replay, false);
  assert.ok(first.body.audit_event_id);

  const replay = await handleOperatorWorkflowAction(request);
  assert.equal(replay.status, 202);
  assert.equal(replay.body.idempotent_replay, true);
  assert.equal(calls, 1);
});

test('workflow action validation rejects an invalid expected attempt before recovery', async () => {
  const dirs = await testDirs();
  const result = await handleOperatorWorkflowAction({
    action: 'resume',
    workflowId: 'workflow-valid',
    childId: 'child-valid',
    body: {
      reason: 'Resume only after verification',
      expected_attempt: -1,
      idempotency_key: 'ops-012f-resume-0001',
    },
    actor: ACTOR,
    workflowRunsDir: dirs.workflows,
    effectsDir: dirs.effects,
    workspaceRoot: dirs.workspaces,
    recordRoot: dirs.records,
    auditDir: dirs.audit,
    idempotencyDir: dirs.idempotency,
  });

  assert.equal(result.status, 400);
  assert.equal(result.body.error_code, 'invalid_request');
  assert.ok(result.body.audit_event_id);
});
