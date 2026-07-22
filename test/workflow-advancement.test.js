import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { advanceWorkflowRun } from '../src/services/workflow-advancement.js';
import { activateWorkflowChild, completeWorkflowChild, createOrLoadWorkflowRun, readWorkflowRun, } from '../src/services/workflow-run-store.js';
const SOURCE_SHA = 'a'.repeat(40);
const OUTPUT_DIGITS = ['b', 'c', 'd', 'e', 'f', '1', '2', '3', '4', '5'];
async function workflowDir() {
    return mkdtemp(join(tmpdir(), 'ops-room-workflow-advancement-'));
}
async function createRun(dir, maxIterations = 3) {
    const created = await createOrLoadWorkflowRun({
        dir,
        input: {
            repository_id: 'LihSheng/ops-room',
            request_key: `OPS-010G-${maxIterations}-${Date.now()}-${Math.random()}`,
            source_sha: SOURCE_SHA,
        },
        policy: { max_iterations: maxIterations, max_concurrency: 1 },
    });
    return created.run;
}
function createExecutor(reviewDecisions, options = {}) {
    const calls = [];
    let writableOutputIndex = 0;
    let reviewIndex = 0;
    const execute = async ({ workflowRunsDir, workflowId, childId }) => {
        const activated = await activateWorkflowChild({
            dir: workflowRunsDir,
            workflowId,
            childId,
        });
        const child = activated.child;
        calls.push(child.child_id);
        const outputSha = child.stage === 'review'
            ? child.input_sha
            : OUTPUT_DIGITS[writableOutputIndex++ % OUTPUT_DIGITS.length].repeat(40);
        const completed = await completeWorkflowChild({
            dir: workflowRunsDir,
            workflowId,
            childId,
            outputSha,
        });
        if (child.stage !== 'review' || options.omitReviewDecision) {
            return { child: completed.child };
        }
        return {
            child: completed.child,
            review_evidence: reviewDecisions[reviewIndex++],
        };
    };
    return { execute, calls };
}
test('advances implementation through Berlin approval and completes once', async () => {
    const dir = await workflowDir();
    const run = await createRun(dir);
    const executor = createExecutor([{ decision: 'approved' }]);
    const result = await advanceWorkflowRun({
        workflowRunsDir: dir,
        workflowId: run.workflow_id,
        executeChild: executor.execute,
    });
    assert.equal(result.action, 'completed');
    assert.equal(result.run.state, 'completed');
    assert.equal(executor.calls.length, 4);
    const stored = await readWorkflowRun({ dir, workflowId: run.workflow_id });
    assert.equal(stored.children.length, 4);
    assert.deepEqual(stored.children.map((child) => child.stage), [
        'implementation',
        'test',
        'integration',
        'review',
    ]);
    assert.ok(stored.children.every((child) => child.state === 'completed'));
    assert.equal(stored.children[1].input_sha, stored.children[0].output_sha);
    assert.equal(stored.children[2].input_sha, stored.children[1].output_sha);
    assert.equal(stored.children[3].input_sha, stored.children[2].output_sha);
    assert.equal(stored.children[3].output_sha, stored.children[3].input_sha);
    assert.equal(stored.children[3].review_decision, 'approved');
    const repeated = await advanceWorkflowRun({
        workflowRunsDir: dir,
        workflowId: run.workflow_id,
        executeChild: executor.execute,
    });
    assert.equal(repeated.action, 'terminal');
    assert.equal(executor.calls.length, 4);
});
test('creates exactly one next iteration after changes requested', async () => {
    const dir = await workflowDir();
    const run = await createRun(dir, 3);
    const executor = createExecutor([
        { decision: 'changes_requested', reason: 'review_changes_requested' },
        { decision: 'approved' },
    ]);
    const result = await advanceWorkflowRun({
        workflowRunsDir: dir,
        workflowId: run.workflow_id,
        executeChild: executor.execute,
    });
    assert.equal(result.action, 'completed');
    assert.equal(executor.calls.length, 8);
    const stored = await readWorkflowRun({ dir, workflowId: run.workflow_id });
    assert.equal(stored.current_iteration, 2);
    assert.equal(stored.children.length, 8);
    const firstReview = stored.children.find((child) => child.iteration === 1 && child.stage === 'review');
    const secondImplementation = stored.children.find((child) => child.iteration === 2 && child.stage === 'implementation');
    const secondReview = stored.children.find((child) => child.iteration === 2 && child.stage === 'review');
    assert.equal(firstReview.review_decision, 'changes_requested');
    assert.equal(secondImplementation.input_sha, firstReview.output_sha);
    assert.equal(secondReview.review_decision, 'approved');
});
test('escalates when changes are requested at the iteration limit', async () => {
    const dir = await workflowDir();
    const run = await createRun(dir, 1);
    const executor = createExecutor([{ decision: 'changes_requested' }]);
    const result = await advanceWorkflowRun({
        workflowRunsDir: dir,
        workflowId: run.workflow_id,
        executeChild: executor.execute,
    });
    assert.equal(result.action, 'needs_human');
    assert.equal(result.run.state, 'needs_human');
    assert.equal(result.run.last_error, 'workflow_iteration_limit_exceeded');
    assert.equal(executor.calls.length, 4);
});
test('does not replay Berlin when durable review decision evidence is missing', async () => {
    const dir = await workflowDir();
    const run = await createRun(dir, 2);
    const executor = createExecutor([], { omitReviewDecision: true });
    const result = await advanceWorkflowRun({
        workflowRunsDir: dir,
        workflowId: run.workflow_id,
        executeChild: executor.execute,
    });
    assert.equal(result.action, 'needs_human');
    assert.equal(result.run.last_error, 'workflow_review_decision_missing');
    assert.equal(executor.calls.length, 4);
    const repeated = await advanceWorkflowRun({
        workflowRunsDir: dir,
        workflowId: run.workflow_id,
        executeChild: executor.execute,
    });
    assert.equal(repeated.action, 'terminal');
    assert.equal(executor.calls.length, 4);
});
test('serializes concurrent advancement and executes each stage once', async () => {
    const dir = await workflowDir();
    const run = await createRun(dir);
    const executor = createExecutor([{ decision: 'approved' }]);
    const [first, second] = await Promise.all([
        advanceWorkflowRun({
            workflowRunsDir: dir,
            workflowId: run.workflow_id,
            executeChild: executor.execute,
        }),
        advanceWorkflowRun({
            workflowRunsDir: dir,
            workflowId: run.workflow_id,
            executeChild: executor.execute,
        }),
    ]);
    assert.deepEqual(new Set([first.action, second.action]), new Set(['completed', 'terminal']));
    assert.equal(executor.calls.length, 4);
    assert.equal(new Set(executor.calls).size, 4);
});
//# sourceMappingURL=workflow-advancement.test.js.map