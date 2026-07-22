import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { claimWorkflowEffect, completeWorkflowEffect, } from '../src/services/workflow-effect-store.js';
import { reconcileProviderBackedWorkflowRuns, resumePendingWorkflowAfterInvestigation, retryWorkflowChildAfterInvestigation, } from '../src/services/workflow-provider-recovery.js';
import { readWorkflowRun, validateWorkflowRun, } from '../src/services/workflow-run-store.js';
import { readWorkspaceRecord, writeWorkspaceRecord, } from '../src/services/workspace-store.js';
const INPUT_SHA = 'a'.repeat(40);
const OUTPUT_SHA = 'b'.repeat(40);
const WORKFLOW_ID = 'workflow:LihSheng-ops-room:recovery12345678901234';
const CHILD_ID = `${WORKFLOW_ID}:1:implementation`;
function workflowFilename(workflowId) {
    return `workflow-${createHash('sha256').update(workflowId).digest('hex')}.json`;
}
async function roots() {
    const root = await mkdtemp(join(tmpdir(), 'ops-room-provider-recovery-'));
    return {
        root,
        workflowRunsDir: join(root, 'workflow-runs'),
        effectsDir: join(root, 'effects'),
        workspaceRoot: join(root, 'workspace-root'),
        recordRoot: join(root, 'workspace-records'),
    };
}
function workspaceBinding(state = 'active') {
    return {
        workspace_id: 'task-professor-recovery123456',
        mode: 'branch',
        repository_id: 'LihSheng/ops-room',
        branch: 'agent/professor/feature-recovery-i1',
        resolved_sha: INPUT_SHA,
        state,
        held_for_investigation: state === 'held_for_investigation',
        cleanup_requested: state === 'cleanup_requested',
    };
}
function child(overrides = {}) {
    return {
        child_id: CHILD_ID,
        stage: 'implementation',
        owner_agent: 'professor',
        iteration: 1,
        attempt: 0,
        state: 'needs_human',
        depends_on: null,
        input_sha: INPUT_SHA,
        output_sha: null,
        created_at: '2026-07-21T00:00:00.000Z',
        updated_at: '2026-07-21T00:01:00.000Z',
        started_at: '2026-07-21T00:00:30.000Z',
        completed_at: null,
        last_error: 'workflow_child_interrupted',
        workspace: workspaceBinding(),
        history: [],
        ...overrides,
    };
}
function run(childValue = child(), overrides = {}) {
    return validateWorkflowRun({
        schema: 'ops-room.workflow-run.v1',
        version: 1,
        workflow_id: WORKFLOW_ID,
        workflow_type: 'feature-development',
        repository_id: 'LihSheng/ops-room',
        request_key: 'OPS-010G-recovery',
        source_sha: INPUT_SHA,
        state: 'needs_human',
        policy: { max_iterations: 3, max_concurrency: 1 },
        current_iteration: 1,
        children: [childValue],
        created_at: '2026-07-21T00:00:00.000Z',
        updated_at: '2026-07-21T00:01:00.000Z',
        completed_at: null,
        last_error: childValue.last_error || 'workflow_advancement_failed',
        history: [],
        ...overrides,
    });
}
async function writeRun(workflowRunsDir, record) {
    await import('node:fs/promises').then(({ mkdir }) => mkdir(workflowRunsDir, { recursive: true }));
    await writeFile(join(workflowRunsDir, workflowFilename(record.workflow_id)), `${JSON.stringify(validateWorkflowRun(record), null, 2)}\n`, 'utf8');
}
async function writeWorkspace({ recordRoot, state = 'active' }) {
    return writeWorkspaceRecord({
        dir: recordRoot,
        record: {
            version: 1,
            workspace_id: workspaceBinding().workspace_id,
            owner_agent: 'professor',
            task_id: CHILD_ID,
            repository_id: 'LihSheng/ops-room',
            mode: 'branch',
            branch: workspaceBinding().branch,
            requested_sha: INPUT_SHA,
            resolved_sha: INPUT_SHA,
            relative_path: `professor/${workspaceBinding().workspace_id}`,
            state,
            hold_reason: state === 'held_for_investigation' ? 'workflow_provider_timeout' : null,
            last_error: null,
            created_at: '2026-07-21T00:00:00.000Z',
            updated_at: '2026-07-21T00:00:00.000Z',
        },
        now: () => '2026-07-21T00:00:00.000Z',
    });
}
async function writeEffect({ effectsDir, state, resultCode, outputSha = null }) {
    const claim = await claimWorkflowEffect({
        dir: effectsDir,
        workflowId: WORKFLOW_ID,
        childId: CHILD_ID,
        effectType: 'provider.professor.implementation',
        idempotencyKey: 'attempt:0',
        payload: {
            repository_id: 'LihSheng/ops-room',
            child_id: CHILD_ID,
            stage: 'implementation',
            owner_agent: 'professor',
            iteration: 1,
            attempt: 0,
            input_sha: INPUT_SHA,
            workspace_id: workspaceBinding().workspace_id,
            prompt_hash: 'c'.repeat(64),
        },
        now: () => '2026-07-21T00:00:30.000Z',
    });
    return completeWorkflowEffect({
        dir: effectsDir,
        effectId: claim.effect.effect_id,
        state,
        resultCode,
        outputSha,
        now: () => '2026-07-21T00:01:00.000Z',
    });
}
test('startup recovers an interrupted child from one exact completed effect and requests cleanup', async () => {
    const paths = await roots();
    await writeRun(paths.workflowRunsDir, run());
    await writeWorkspace(paths);
    await writeEffect({
        effectsDir: paths.effectsDir,
        state: 'completed',
        resultCode: 'ok',
        outputSha: OUTPUT_SHA,
    });
    const result = await reconcileProviderBackedWorkflowRuns({
        ...paths,
        inspectWorkspaceHead: async () => OUTPUT_SHA,
        reconcileReviewDecision: async () => ({ reconciled: false }),
        now: (() => {
            let tick = 0;
            return () => `2026-07-21T00:02:0${tick++}.000Z`;
        })(),
    });
    const recovered = await readWorkflowRun({ dir: paths.workflowRunsDir, workflowId: WORKFLOW_ID });
    const workspace = await readWorkspaceRecord({
        dir: paths.recordRoot,
        workspaceId: workspaceBinding().workspace_id,
    });
    assert.equal(result.recovered_children, 1);
    assert.equal(result.cleanup_reconciled, 1);
    assert.equal(recovered.state, 'active');
    assert.equal(recovered.children[0].state, 'completed');
    assert.equal(recovered.children[0].output_sha, OUTPUT_SHA);
    assert.equal(recovered.children[0].recovery_cleanup_pending, false);
    assert.match(String(recovered.children[0].recovered_effect_id), /^effect:/);
    assert.equal(workspace.state, 'cleanup_requested');
});
test('cleanup reconciliation remains restart-safe after a crash following durable child recovery', async () => {
    const paths = await roots();
    await writeRun(paths.workflowRunsDir, run());
    await writeWorkspace(paths);
    await writeEffect({
        effectsDir: paths.effectsDir,
        state: 'completed',
        resultCode: 'ok',
        outputSha: OUTPUT_SHA,
    });
    let cleanupCalls = 0;
    const first = await reconcileProviderBackedWorkflowRuns({
        ...paths,
        inspectWorkspaceHead: async () => OUTPUT_SHA,
        requestCleanup: async () => {
            cleanupCalls += 1;
            throw new Error('simulated_cleanup_interruption');
        },
        reconcileReviewDecision: async () => ({ reconciled: false }),
        now: () => '2026-07-21T00:02:00.000Z',
    });
    const interrupted = await readWorkflowRun({ dir: paths.workflowRunsDir, workflowId: WORKFLOW_ID });
    assert.equal(first.unavailable.length, 1);
    assert.equal(cleanupCalls, 1);
    assert.equal(interrupted.state, 'needs_human');
    assert.equal(interrupted.last_error, 'workflow_recovery_cleanup_pending');
    assert.equal(interrupted.children[0].state, 'completed');
    assert.equal(interrupted.children[0].recovery_cleanup_pending, true);
    const second = await reconcileProviderBackedWorkflowRuns({
        ...paths,
        inspectWorkspaceHead: async () => { throw new Error('head_should_not_be_reinspected'); },
        reconcileReviewDecision: async () => ({ reconciled: false }),
        now: () => '2026-07-21T00:03:00.000Z',
    });
    const finalized = await readWorkflowRun({ dir: paths.workflowRunsDir, workflowId: WORKFLOW_ID });
    const workspace = await readWorkspaceRecord({
        dir: paths.recordRoot,
        workspaceId: workspaceBinding().workspace_id,
    });
    assert.equal(second.cleanup_reconciled, 1);
    assert.equal(finalized.state, 'active');
    assert.equal(finalized.children[0].recovery_cleanup_pending, false);
    assert.equal(workspace.state, 'cleanup_requested');
});
test('explicit retry increments the attempt only after terminal timeout evidence and unchanged workspace HEAD', async () => {
    const paths = await roots();
    const retryChild = child({
        last_error: 'workflow_provider_timeout',
        workspace: workspaceBinding('held_for_investigation'),
    });
    await writeRun(paths.workflowRunsDir, run(retryChild, { last_error: 'workflow_provider_timeout' }));
    await writeWorkspace({ ...paths, state: 'held_for_investigation' });
    await writeEffect({
        effectsDir: paths.effectsDir,
        state: 'needs_human',
        resultCode: 'workflow_provider_timeout',
    });
    const first = await retryWorkflowChildAfterInvestigation({
        ...paths,
        workflowId: WORKFLOW_ID,
        childId: CHILD_ID,
        expectedAttempt: 0,
        inspectWorkspaceHead: async () => INPUT_SHA,
        now: () => '2026-07-21T00:04:00.000Z',
    });
    const workspace = await readWorkspaceRecord({
        dir: paths.recordRoot,
        workspaceId: workspaceBinding().workspace_id,
    });
    assert.equal(first.idempotent, false);
    assert.equal(first.run.state, 'active');
    assert.equal(first.child.state, 'pending');
    assert.equal(first.child.attempt, 1);
    assert.equal(workspace.state, 'active');
    assert.equal(workspace.hold_reason, null);
    const replay = await retryWorkflowChildAfterInvestigation({
        ...paths,
        workflowId: WORKFLOW_ID,
        childId: CHILD_ID,
        expectedAttempt: 0,
        inspectWorkspaceHead: async () => { throw new Error('idempotent_retry_must_not_reinspect'); },
    });
    assert.equal(replay.idempotent, true);
    assert.equal(replay.child.attempt, 1);
});
test('retry fails closed when provider may have changed the workspace', async () => {
    const paths = await roots();
    const retryChild = child({
        last_error: 'workflow_provider_output_invalid',
        workspace: workspaceBinding('held_for_investigation'),
    });
    await writeRun(paths.workflowRunsDir, run(retryChild, { last_error: 'workflow_provider_output_invalid' }));
    await writeWorkspace({ ...paths, state: 'held_for_investigation' });
    await writeEffect({
        effectsDir: paths.effectsDir,
        state: 'needs_human',
        resultCode: 'workflow_provider_output_invalid',
    });
    await assert.rejects(retryWorkflowChildAfterInvestigation({
        ...paths,
        workflowId: WORKFLOW_ID,
        childId: CHILD_ID,
        expectedAttempt: 0,
        inspectWorkspaceHead: async () => OUTPUT_SHA,
    }), /workflow_retry_workspace_head_changed/);
    const unchanged = await readWorkflowRun({ dir: paths.workflowRunsDir, workflowId: WORKFLOW_ID });
    assert.equal(unchanged.state, 'needs_human');
    assert.equal(unchanged.children[0].attempt, 0);
});
test('a completed provider effect is recovered rather than retried', async () => {
    const paths = await roots();
    await writeRun(paths.workflowRunsDir, run());
    await writeWorkspace(paths);
    await writeEffect({
        effectsDir: paths.effectsDir,
        state: 'completed',
        resultCode: 'ok',
        outputSha: OUTPUT_SHA,
    });
    await assert.rejects(retryWorkflowChildAfterInvestigation({
        ...paths,
        workflowId: WORKFLOW_ID,
        childId: CHILD_ID,
        expectedAttempt: 0,
        inspectWorkspaceHead: async () => INPUT_SHA,
    }), /workflow_retry_completed_effect_forbidden/);
});
test('an interrupted uncertain effect may be retried explicitly only after reconciliation and a clean HEAD check', async () => {
    const paths = await roots();
    await writeRun(paths.workflowRunsDir, run());
    await writeWorkspace({ ...paths, state: 'held_for_investigation' });
    await writeEffect({
        effectsDir: paths.effectsDir,
        state: 'needs_human',
        resultCode: 'workflow_effect_interrupted',
    });
    const retried = await retryWorkflowChildAfterInvestigation({
        ...paths,
        workflowId: WORKFLOW_ID,
        childId: CHILD_ID,
        expectedAttempt: 0,
        inspectWorkspaceHead: async () => INPUT_SHA,
    });
    assert.equal(retried.child.state, 'pending');
    assert.equal(retried.child.attempt, 1);
});
test('a pending child blocked before provider invocation resumes without incrementing its attempt', async () => {
    const paths = await roots();
    const pending = child({
        state: 'pending',
        started_at: null,
        last_error: null,
        workspace: null,
    });
    await writeRun(paths.workflowRunsDir, run(pending, {
        state: 'needs_human',
        last_error: 'workspace_allocation_failed',
    }));
    const resumed = await resumePendingWorkflowAfterInvestigation({
        ...paths,
        workflowId: WORKFLOW_ID,
        childId: CHILD_ID,
        expectedAttempt: 0,
    });
    assert.equal(resumed.run.state, 'active');
    assert.equal(resumed.child.state, 'pending');
    assert.equal(resumed.child.attempt, 0);
    const raw = await readFile(join(paths.workflowRunsDir, workflowFilename(WORKFLOW_ID)), 'utf8');
    assert.equal(raw.includes('workspace_allocation_failed'), false);
});
test('pending failure resume refuses to bypass an existing provider effect', async () => {
    const paths = await roots();
    const pending = child({
        state: 'pending',
        started_at: null,
        last_error: null,
        workspace: null,
    });
    await writeRun(paths.workflowRunsDir, run(pending, {
        state: 'needs_human',
        last_error: 'workspace_allocation_failed',
    }));
    await writeEffect({
        effectsDir: paths.effectsDir,
        state: 'needs_human',
        resultCode: 'workflow_provider_failed',
    });
    await assert.rejects(resumePendingWorkflowAfterInvestigation({
        ...paths,
        workflowId: WORKFLOW_ID,
        childId: CHILD_ID,
        expectedAttempt: 0,
    }), /workflow_resume_provider_effect_exists/);
});
//# sourceMappingURL=workflow-provider-recovery.test.js.map