import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { listWorkflowEffects } from '../src/services/workflow-effect-store.js';
import {
  createReviewAwareWorkflowStageRunner,
  decodeReviewEffectResultCode,
  parseReviewProviderResult,
} from '../src/services/workflow-review-stage-runner.js';

const SHA = 'd'.repeat(40);
const WORKFLOW_ID = 'workflow:LihSheng-ops-room:1234567890abcdef12345678';

async function effectDir() {
  return mkdtemp(join(tmpdir(), 'ops-room-review-stage-runner-'));
}

function input(stage = 'review') {
  return {
    run: {
      workflow_id: WORKFLOW_ID,
      repository_id: 'LihSheng/ops-room',
      source_sha: 'a'.repeat(40),
      state: 'active',
      current_iteration: 1,
      policy: { max_iterations: 3, max_concurrency: 1 },
    },
    child: {
      child_id: `${WORKFLOW_ID}:1:${stage}`,
      stage,
      owner_agent: stage === 'review' ? 'berlin' : 'professor',
      iteration: 1,
      attempt: 0,
      state: 'active',
      depends_on: null,
      input_sha: stage === 'review' ? SHA : 'a'.repeat(40),
    },
    workspace_path: '/internal/workspace/path',
    workspace: {
      workspace_id: `task-${stage}-1234567890abcdef`,
      mode: stage === 'review' ? 'detached' : 'branch',
      repository_id: 'LihSheng/ops-room',
      branch: stage === 'review' ? null : 'agent/professor/feature-123-i1',
      resolved_sha: stage === 'review' ? SHA : 'a'.repeat(40),
      state: 'active',
    },
  };
}

test('review provider output requires bounded approval or changes-requested evidence', () => {
  assert.deepEqual(
    parseReviewProviderResult({ outcome: 'completed', output_sha: SHA, review_decision: 'approved' }),
    { outcome: 'completed', output_sha: SHA, review_evidence: { decision: 'approved', reason: null } },
  );
  assert.deepEqual(
    parseReviewProviderResult({
      outcome: 'completed',
      output_sha: SHA,
      review_decision: 'changes_requested',
      review_reason: 'tests_missing',
    }),
    {
      outcome: 'completed',
      output_sha: SHA,
      review_evidence: { decision: 'changes_requested', reason: 'tests_missing' },
    },
  );
  assert.throws(
    () => parseReviewProviderResult({ outcome: 'completed', output_sha: SHA }),
    /workflow_review_decision_invalid/,
  );
});

test('Berlin decision is durably replayed without a second provider invocation', async () => {
  const effectsDir = await effectDir();
  let calls = 0;
  const runner = createReviewAwareWorkflowStageRunner({
    effectsDir,
    providerAdapters: {
      berlin: async () => {
        calls += 1;
        return {
          outcome: 'completed',
          output_sha: SHA,
          review_decision: 'changes_requested',
          review_reason: 'integration_tests_failed',
        };
      },
    },
    resolveStageInstruction: async () => 'Review the exact integration SHA.',
  });

  const first = await runner(input());
  const replay = await runner(input());
  const effects = await listWorkflowEffects({ dir: effectsDir });

  assert.deepEqual(first.review_evidence, {
    decision: 'changes_requested',
    reason: 'integration_tests_failed',
  });
  assert.deepEqual(replay, first);
  assert.equal(calls, 1);
  assert.equal(effects.length, 1);
  assert.equal(effects[0].state, 'completed');
  assert.equal(effects[0].result_code, 'review.changes_requested:integration_tests_failed');
  assert.deepEqual(decodeReviewEffectResultCode(effects[0].result_code), first.review_evidence);
});

test('non-review stages retain the existing OPS-010F fenced runner', async () => {
  const effectsDir = await effectDir();
  let calls = 0;
  const runner = createReviewAwareWorkflowStageRunner({
    effectsDir,
    providerAdapters: {
      professor: async () => {
        calls += 1;
        return { outcome: 'completed', output_sha: SHA };
      },
    },
    resolveStageInstruction: async () => 'Implement the change.',
  });

  const result = await runner(input('implementation'));
  const effects = await listWorkflowEffects({ dir: effectsDir });

  assert.equal(result.outcome, 'completed');
  assert.equal(calls, 1);
  assert.equal(effects[0].result_code, 'ok');
});
