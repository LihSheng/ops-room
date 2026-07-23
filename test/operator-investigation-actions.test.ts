import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile as execFileCallback } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';

import {
  guardOperatorWorkflowRetryResolution,
  handleOperatorInvestigationAction,
} from '../src/services/operator-investigation-actions.js';
import {
  claimWorkflowEffect,
  completeWorkflowEffect,
  readWorkflowEffect,
} from '../src/services/workflow-effect-store.js';
import {
  createOrLoadWorkflowRun,
  ensureWorkflowChild,
  readWorkflowRun,
  validateWorkflowRun,
} from '../src/services/workflow-run-store.js';
import { writeAtomic } from '../src/services/review-task-store.js';
import { readWorkspaceRecord, writeWorkspaceRecord } from '../src/services/workspace-store.js';
import { matchOperatorInvestigationRoute } from '../src/routes/operator-investigations.js';

const execFile = promisify(execFileCallback);

function workflowPath(dir: string, workflowId: string) {
  return join(dir, `workflow-${createHash('sha256').update(workflowId).digest('hex')}.json`);
}

async function gitWorkspace(path: string) {
  await mkdir(path, { recursive: true });
  await execFile('git', ['init'], { cwd: path });
  await execFile('git', ['config', 'user.email', 'ops-room@example.invalid'], { cwd: path });
  await execFile('git', ['config', 'user.name', 'Ops Room Test'], { cwd: path });
  await writeFile(join(path, 'README.md'), '# investigation\n', 'utf8');
  await execFile('git', ['add', 'README.md'], { cwd: path });
  await execFile('git', ['commit', '-m', 'test'], { cwd: path });
  const result = await execFile('git', ['rev-parse', 'HEAD'], { cwd: path });
  return String(result.stdout).trim().toLowerCase();
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'ops-room-investigation-'));
  const workflowRunsDir = join(root, 'runs');
  const effectsDir = join(root, 'effects');
  const workspaceRoot = join(root, 'workspaces');
  const recordRoot = join(root, 'workspace-records');
  const auditDir = join(root, 'audit');
  const idempotencyDir = join(root, 'idempotency');
  const workspaceId = 'workspace-f3';
  const workspacePath = join(workspaceRoot, 'professor', workspaceId);
  const sha = await gitWorkspace(workspacePath);
  const created = await createOrLoadWorkflowRun({
    dir: workflowRunsDir,
    input: {
      repository_id: 'LihSheng/ops-room',
      request_key: `f3-${Math.random()}`,
      source_sha: sha,
    },
  });
  const ensured = await ensureWorkflowChild({
    dir: workflowRunsDir,
    workflowId: created.run.workflow_id,
    iteration: 1,
    stage: 'implementation',
    inputSha: sha,
  });
  await writeWorkspaceRecord({
    dir: recordRoot,
    record: {
      workspace_id: workspaceId,
      owner_agent: 'professor',
      task_id: ensured.child.child_id,
      repository_id: 'LihSheng/ops-room',
      mode: 'branch',
      branch: 'agent/professor/f3-test',
      requested_sha: sha,
      resolved_sha: sha,
      relative_path: join('professor', workspaceId),
      state: 'active',
      hold_reason: null,
      last_error: null,
    },
  });
  const child = {
    ...ensured.child,
    state: 'needs_human',
    last_error: 'workflow_provider_timeout',
    workspace: {
      workspace_id: workspaceId,
      mode: 'branch',
      branch: 'agent/professor/f3-test',
      resolved_sha: sha,
    },
  };
  const run = validateWorkflowRun({
    ...ensured.run,
    state: 'needs_human',
    last_error: 'workflow_child_interrupted',
    children: [child],
  });
  await writeAtomic(workflowPath(workflowRunsDir, run.workflow_id), run);
  const claim = await claimWorkflowEffect({
    dir: effectsDir,
    workflowId: run.workflow_id,
    childId: child.child_id,
    effectType: 'provider.professor.implementation',
    idempotencyKey: 'attempt:0',
    payload: { input_sha: sha },
  });
  await completeWorkflowEffect({
    dir: effectsDir,
    effectId: claim.effect.effect_id,
    state: 'needs_human',
    resultCode: 'workflow_provider_timeout',
  });
  return {
    root,
    workflowRunsDir,
    effectsDir,
    workspaceRoot,
    recordRoot,
    auditDir,
    idempotencyDir,
    workflowId: run.workflow_id,
    childId: child.child_id,
    effectId: claim.effect.effect_id,
    workspaceId,
    sha,
  };
}

const actor = {
  actor_id: 'human:f3-test',
  actor_display_name: 'F3 Test',
  roles: ['operator'],
};

test('needs-human effect blocks retry until explicit resolution', async () => {
  const value = await fixture();
  try {
    const blocked = await guardOperatorWorkflowRetryResolution({
      workflowRunsDir: value.workflowRunsDir,
      effectsDir: value.effectsDir,
      workflowId: value.workflowId,
      childId: value.childId,
      expectedAttempt: 0,
      actor,
      reason: 'Retry after investigation',
      idempotencyKey: 'retry-guard-f3',
      auditDir: value.auditDir,
    });
    assert.equal(blocked?.status, 409);
    assert.equal(blocked?.body.error_code, 'workflow_retry_effect_resolution_required');

    const resolved = await handleOperatorInvestigationAction({
      action: 'effect.resolve',
      workflowId: value.workflowId,
      childId: value.childId,
      effectId: value.effectId,
      body: {
        resolution: 'safe_to_retry',
        expected_attempt: 0,
        reason: 'Workspace restored to the exact input SHA and no completed effect was observed',
        idempotency_key: 'resolve-safe-to-retry-f3',
      },
      actor,
      workflowRunsDir: value.workflowRunsDir,
      effectsDir: value.effectsDir,
      workspaceRoot: value.workspaceRoot,
      recordRoot: value.recordRoot,
      auditDir: value.auditDir,
      idempotencyDir: value.idempotencyDir,
    });
    assert.equal(resolved.status, 200);
    assert.equal(resolved.body.effect.state, 'failed');
    assert.equal(resolved.body.effect.result_code, 'operator.safe_to_retry');
    assert.equal(resolved.body.provider_invoked, false);
    assert.equal(resolved.body.uncertain_effect_replayed, false);

    const effect = await readWorkflowEffect({ dir: value.effectsDir, effectId: value.effectId });
    assert.equal(effect.state, 'failed');
    assert.equal(effect.resolution.decision, 'safe_to_retry');

    const allowed = await guardOperatorWorkflowRetryResolution({
      workflowRunsDir: value.workflowRunsDir,
      effectsDir: value.effectsDir,
      workflowId: value.workflowId,
      childId: value.childId,
      expectedAttempt: 0,
      actor,
      reason: 'Retry after resolution',
      idempotencyKey: 'retry-guard-after-f3',
      auditDir: value.auditDir,
    });
    assert.equal(allowed, null);
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

test('completed resolution verifies exact workspace HEAD and preserves provider fencing', async () => {
  const value = await fixture();
  try {
    const result = await handleOperatorInvestigationAction({
      action: 'effect.resolve',
      workflowId: value.workflowId,
      childId: value.childId,
      effectId: value.effectId,
      body: {
        resolution: 'completed',
        output_sha: value.sha,
        result_code: 'ok',
        expected_attempt: 0,
        reason: 'Verified the completed local commit and exact workspace HEAD',
        idempotency_key: 'resolve-completed-f3',
      },
      actor,
      workflowRunsDir: value.workflowRunsDir,
      effectsDir: value.effectsDir,
      workspaceRoot: value.workspaceRoot,
      recordRoot: value.recordRoot,
      auditDir: value.auditDir,
      idempotencyDir: value.idempotencyDir,
    });
    assert.equal(result.status, 200);
    assert.equal(result.body.effect.state, 'completed');
    assert.equal(result.body.effect.output_sha, value.sha);
    assert.equal(result.body.provider_invoked, false);
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

test('workspace hold and verified release are exact and cleanup remains request-only', async () => {
  const value = await fixture();
  try {
    const hold = await handleOperatorInvestigationAction({
      action: 'workspace.hold',
      workflowId: value.workflowId,
      childId: value.childId,
      workspaceId: value.workspaceId,
      body: {
        expected_state: 'active',
        expected_attempt: 0,
        reason: 'Preserve workspace evidence while the provider outcome is investigated',
        idempotency_key: 'workspace-hold-f3',
      },
      actor,
      workflowRunsDir: value.workflowRunsDir,
      effectsDir: value.effectsDir,
      workspaceRoot: value.workspaceRoot,
      recordRoot: value.recordRoot,
      auditDir: value.auditDir,
      idempotencyDir: value.idempotencyDir,
    });
    assert.equal(hold.status, 200);
    assert.equal(hold.body.workspace.state, 'held_for_investigation');

    const release = await handleOperatorInvestigationAction({
      action: 'workspace.release',
      workflowId: value.workflowId,
      childId: value.childId,
      workspaceId: value.workspaceId,
      body: {
        expected_state: 'held_for_investigation',
        expected_head_sha: value.sha,
        expected_attempt: 0,
        reason: 'Exact input SHA verified; release the investigation hold',
        idempotency_key: 'workspace-release-f3',
      },
      actor,
      workflowRunsDir: value.workflowRunsDir,
      effectsDir: value.effectsDir,
      workspaceRoot: value.workspaceRoot,
      recordRoot: value.recordRoot,
      auditDir: value.auditDir,
      idempotencyDir: value.idempotencyDir,
    });
    assert.equal(release.status, 200);
    assert.equal(release.body.workspace.state, 'active');

    const run = await readWorkflowRun({ dir: value.workflowRunsDir, workflowId: value.workflowId });
    const completedChild = {
      ...run.children[0],
      state: 'completed',
      output_sha: value.sha,
      completed_at: new Date().toISOString(),
      last_error: null,
    };
    await writeAtomic(workflowPath(value.workflowRunsDir, value.workflowId), validateWorkflowRun({
      ...run,
      state: 'completed',
      completed_at: new Date().toISOString(),
      last_error: null,
      children: [completedChild],
    }));
    await handleOperatorInvestigationAction({
      action: 'effect.resolve',
      workflowId: value.workflowId,
      childId: value.childId,
      effectId: value.effectId,
      body: {
        resolution: 'safe_to_retry',
        expected_attempt: 0,
        reason: 'Resolve effect before terminal workspace cleanup',
        idempotency_key: 'resolve-before-cleanup-f3',
      },
      actor,
      workflowRunsDir: value.workflowRunsDir,
      effectsDir: value.effectsDir,
      workspaceRoot: value.workspaceRoot,
      recordRoot: value.recordRoot,
      auditDir: value.auditDir,
      idempotencyDir: value.idempotencyDir,
    });

    const cleanup = await handleOperatorInvestigationAction({
      action: 'workspace.cleanup',
      workflowId: value.workflowId,
      childId: value.childId,
      workspaceId: value.workspaceId,
      body: {
        expected_state: 'active',
        expected_attempt: 0,
        reason: 'Terminal child evidence retained; request workspace cleanup',
        idempotency_key: 'workspace-cleanup-f3',
      },
      actor,
      workflowRunsDir: value.workflowRunsDir,
      effectsDir: value.effectsDir,
      workspaceRoot: value.workspaceRoot,
      recordRoot: value.recordRoot,
      auditDir: value.auditDir,
      idempotencyDir: value.idempotencyDir,
    });
    assert.equal(cleanup.status, 200);
    assert.equal(cleanup.body.workspace.state, 'cleanup_requested');
    assert.equal(cleanup.body.cleanup_executed, false);
    assert.equal((await readWorkspaceRecord({ dir: value.recordRoot, workspaceId: value.workspaceId })).state, 'cleanup_requested');
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

test('investigation routes decode exact targets and reject malformed encoding', () => {
  const effectPath = '/api/operator/workflows/workflow%3Arepo%3A1/children/workflow%3Arepo%3A1%3A1%3Aimplementation/effects/effect%3A123/resolve';
  assert.deepEqual(matchOperatorInvestigationRoute(effectPath), {
    workflowId: 'workflow:repo:1',
    childId: 'workflow:repo:1:1:implementation',
    effectId: 'effect:123',
    workspaceId: '',
    action: 'effect.resolve',
  });
  assert.equal(matchOperatorInvestigationRoute('/api/operator/workflows/%E0%A4%A/children/x/effects/y/resolve'), null);
});
