import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { advanceWorkflowRunWithProviders, reconcileReviewDecisionFromEffects, } from '../src/services/workflow-provider-advancement.js';
import { createReviewAwareWorkflowStageRunner } from '../src/services/workflow-review-stage-runner.js';
import { activateWorkflowChild, completeWorkflowChild, createOrLoadWorkflowRun, ensureWorkflowChild, readWorkflowRun, } from '../src/services/workflow-run-store.js';
const SOURCE_SHA = 'a'.repeat(40);
const IMPLEMENTATION_SHA = 'b'.repeat(40);
const TEST_SHA = 'c'.repeat(40);
const INTEGRATION_SHA = 'd'.repeat(40);
async function roots() {
    const root = await mkdtemp(join(tmpdir(), 'ops-room-provider-advancement-'));
    return {
        workflowRunsDir: join(root, 'workflow-runs'),
        effectsDir: join(root, 'effects'),
    };
}
async function createRun(workflowRunsDir, requestKey) {
    return createOrLoadWorkflowRun({
        dir: workflowRunsDir,
        input: {
            repository_id: 'LihSheng/ops-room',
            request_key: requestKey,
            source_sha: SOURCE_SHA,
        },
        policy: { max_iterations: 3, max_concurrency: 1 },
    });
}
function outputForStage(stage, inputSha) {
    if (stage === 'implementation')
        return IMPLEMENTATION_SHA;
    if (stage === 'test')
        return TEST_SHA;
    if (stage === 'integration')
        return INTEGRATION_SHA;
    return inputSha;
}
function workspaceFor(child) {
    return {
        workspace_id: `task-${child.owner_agent}-${child.iteration}-${child.stage}`,
        mode: child.stage === 'review' ? 'detached' : 'branch',
        repository_id: 'LihSheng/ops-room',
        branch: child.stage === 'review' ? null : `agent/${child.owner_agent}/feature-i${child.iteration}`,
        resolved_sha: child.input_sha,
        state: 'active',
    };
}
test('provider-backed coordinator advances all stages and resolves Berlin evidence from the effect store', async () => {
    const { workflowRunsDir, effectsDir } = await roots();
    const created = await createRun(workflowRunsDir, 'OPS-010G-provider-composition');
    const calls = { implementation: 0, test: 0, integration: 0, review: 0 };
    const providerAdapters = {
        professor: async ({ child }) => {
            calls[child.stage] += 1;
            return { outcome: 'completed', output_sha: outputForStage(child.stage, child.input_sha) };
        },
        tokyo: async ({ child }) => {
            calls[child.stage] += 1;
            return { outcome: 'completed', output_sha: TEST_SHA };
        },
        berlin: async ({ child }) => {
            calls.review += 1;
            return { outcome: 'completed', output_sha: child.input_sha, review_decision: 'approved' };
        },
    };
    const executeWorkflowChildFn = async ({ workflowRunsDir: dir, workflowId, childId, runStage }) => {
        const activated = await activateWorkflowChild({ dir, workflowId, childId });
        const result = await runStage({
            run: activated.run,
            child: activated.child,
            workspace_path: '/internal/workspace/path',
            workspace: workspaceFor(activated.child),
        });
        assert.equal(result.outcome, 'completed');
        await completeWorkflowChild({
            dir,
            workflowId,
            childId,
            outputSha: result.output_sha,
        });
        return {};
    };
    const result = await advanceWorkflowRunWithProviders({
        workflowRunsDir,
        workflowId: created.run.workflow_id,
        effectsDir,
        providerAdapters,
        resolveStageInstruction: async ({ child }) => `Complete ${child.stage}.`,
        executeWorkflowChildFn,
    });
    const run = await readWorkflowRun({ dir: workflowRunsDir, workflowId: created.run.workflow_id });
    const review = run.children.find((child) => child.stage === 'review');
    assert.equal(result.run.state, 'completed');
    assert.equal(run.state, 'completed');
    assert.equal(review.review_decision, 'approved');
    assert.deepEqual(calls, { implementation: 1, test: 1, integration: 1, review: 1 });
    await advanceWorkflowRunWithProviders({
        workflowRunsDir,
        workflowId: created.run.workflow_id,
        effectsDir,
        providerAdapters,
        resolveStageInstruction: async ({ child }) => `Complete ${child.stage}.`,
        executeWorkflowChildFn,
    });
    assert.deepEqual(calls, { implementation: 1, test: 1, integration: 1, review: 1 });
});
test('restart reconciliation restores a completed Berlin decision from durable effect evidence', async () => {
    const { workflowRunsDir, effectsDir } = await roots();
    const created = await createRun(workflowRunsDir, 'OPS-010G-review-restart');
    const workflowId = created.run.workflow_id;
    const stages = [
        ['implementation', SOURCE_SHA, IMPLEMENTATION_SHA],
        ['test', IMPLEMENTATION_SHA, TEST_SHA],
        ['integration', TEST_SHA, INTEGRATION_SHA],
    ];
    for (const [stage, inputSha, outputSha] of stages) {
        const ensured = await ensureWorkflowChild({
            dir: workflowRunsDir,
            workflowId,
            iteration: 1,
            stage,
            inputSha,
        });
        await activateWorkflowChild({ dir: workflowRunsDir, workflowId, childId: ensured.child.child_id });
        await completeWorkflowChild({ dir: workflowRunsDir, workflowId, childId: ensured.child.child_id, outputSha });
    }
    const ensuredReview = await ensureWorkflowChild({
        dir: workflowRunsDir,
        workflowId,
        iteration: 1,
        stage: 'review',
        inputSha: INTEGRATION_SHA,
    });
    const activatedReview = await activateWorkflowChild({
        dir: workflowRunsDir,
        workflowId,
        childId: ensuredReview.child.child_id,
    });
    let berlinCalls = 0;
    const reviewRunner = createReviewAwareWorkflowStageRunner({
        effectsDir,
        providerAdapters: {
            berlin: async () => {
                berlinCalls += 1;
                return { outcome: 'completed', output_sha: INTEGRATION_SHA, review_decision: 'approved' };
            },
        },
        resolveStageInstruction: async () => 'Review the integration SHA.',
    });
    const reviewResult = await reviewRunner({
        run: activatedReview.run,
        child: activatedReview.child,
        workspace_path: '/internal/review-workspace',
        workspace: workspaceFor(activatedReview.child),
    });
    await completeWorkflowChild({
        dir: workflowRunsDir,
        workflowId,
        childId: activatedReview.child.child_id,
        outputSha: reviewResult.output_sha,
    });
    const before = await readWorkflowRun({ dir: workflowRunsDir, workflowId });
    assert.equal(before.children.find((child) => child.stage === 'review').review_decision, undefined);
    const recovery = await reconcileReviewDecisionFromEffects({
        workflowRunsDir,
        workflowId,
        effectsDir,
    });
    assert.equal(recovery.reconciled, true);
    const result = await advanceWorkflowRunWithProviders({
        workflowRunsDir,
        workflowId,
        effectsDir,
        providerAdapters: {
            berlin: async () => { throw new Error('review_must_not_replay'); },
        },
        resolveStageInstruction: async () => 'Review the integration SHA.',
        executeWorkflowChildFn: async () => { throw new Error('child_must_not_execute'); },
    });
    const after = await readWorkflowRun({ dir: workflowRunsDir, workflowId });
    assert.equal(result.run.state, 'completed');
    assert.equal(after.children.find((child) => child.stage === 'review').review_decision, 'approved');
    assert.equal(berlinCalls, 1);
});
//# sourceMappingURL=workflow-provider-advancement.test.js.map