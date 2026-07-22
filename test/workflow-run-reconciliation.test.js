import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { activateWorkflowChild, completeWorkflowChild, createOrLoadWorkflowRun, ensureWorkflowChild, readWorkflowRun, } from '../src/services/workflow-run-store.js';
import { reconcileInterruptedWorkflowRuns, WORKFLOW_INTERRUPTION_ERROR, } from '../src/services/workflow-run-reconciliation.js';
const SOURCE_SHA = 'a'.repeat(40);
const OUTPUT_SHA = 'b'.repeat(40);
async function fixture() {
    const dir = await mkdtemp(join(tmpdir(), 'ops-room-workflow-reconcile-'));
    const created = await createOrLoadWorkflowRun({
        dir,
        input: {
            repository: 'LihSheng/ops-room',
            requestKey: 'OPS-010B fixture',
            sourceSha: SOURCE_SHA,
        },
    });
    return { dir, workflowId: created.run.workflow_id };
}
test('startup reconciliation moves interrupted active children to needs_human', async () => {
    const { dir, workflowId } = await fixture();
    try {
        const childResult = await ensureWorkflowChild({
            dir,
            workflowId,
            iteration: 1,
            stage: 'implementation',
            inputSha: SOURCE_SHA,
        });
        await activateWorkflowChild({ dir, workflowId, childId: childResult.child.child_id });
        const result = await reconcileInterruptedWorkflowRuns({
            dir,
            now: () => '2026-07-20T05:40:00.000Z',
        });
        const recovered = await readWorkflowRun({ dir, workflowId });
        const child = recovered.children[0];
        assert.equal(result.recovered_workflows, 1);
        assert.equal(result.recovered_children, 1);
        assert.equal(recovered.state, 'needs_human');
        assert.equal(child.state, 'needs_human');
        assert.equal(child.last_error, WORKFLOW_INTERRUPTION_ERROR);
        assert.equal(child.started_at !== null, true);
        assert.equal(recovered.history.at(-1).event, 'workflow_restart_reconciled');
    }
    finally {
        await rm(dir, { recursive: true, force: true });
    }
});
test('restart reconciliation is idempotent and does not duplicate history', async () => {
    const { dir, workflowId } = await fixture();
    try {
        const childResult = await ensureWorkflowChild({
            dir,
            workflowId,
            iteration: 1,
            stage: 'implementation',
            inputSha: SOURCE_SHA,
        });
        await activateWorkflowChild({ dir, workflowId, childId: childResult.child.child_id });
        const first = await reconcileInterruptedWorkflowRuns({ dir });
        const afterFirst = await readWorkflowRun({ dir, workflowId });
        const second = await reconcileInterruptedWorkflowRuns({ dir });
        const afterSecond = await readWorkflowRun({ dir, workflowId });
        assert.equal(first.recovered_workflows, 1);
        assert.equal(second.recovered_workflows, 0);
        assert.equal(afterSecond.history.length, afterFirst.history.length);
        assert.equal(afterSecond.children[0].history.length, afterFirst.children[0].history.length);
    }
    finally {
        await rm(dir, { recursive: true, force: true });
    }
});
test('completed children and immutable output SHAs remain unchanged', async () => {
    const { dir, workflowId } = await fixture();
    try {
        const childResult = await ensureWorkflowChild({
            dir,
            workflowId,
            iteration: 1,
            stage: 'implementation',
            inputSha: SOURCE_SHA,
        });
        await activateWorkflowChild({ dir, workflowId, childId: childResult.child.child_id });
        await completeWorkflowChild({
            dir,
            workflowId,
            childId: childResult.child.child_id,
            outputSha: OUTPUT_SHA,
        });
        const before = await readWorkflowRun({ dir, workflowId });
        const result = await reconcileInterruptedWorkflowRuns({ dir });
        const after = await readWorkflowRun({ dir, workflowId });
        assert.equal(result.recovered_workflows, 0);
        assert.deepEqual(after, before);
        assert.equal(after.children[0].output_sha, OUTPUT_SHA);
    }
    finally {
        await rm(dir, { recursive: true, force: true });
    }
});
test('corrupt workflow records are reported but never repaired silently', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ops-room-workflow-corrupt-'));
    try {
        await writeFile(join(dir, 'workflow-corrupt.json'), '{ private raw broken json', 'utf8');
        const result = await reconcileInterruptedWorkflowRuns({ dir });
        assert.equal(result.scanned, 1);
        assert.deepEqual(result.recovered, []);
        assert.deepEqual(result.unavailable, ['workflow-corrupt']);
    }
    finally {
        await rm(dir, { recursive: true, force: true });
    }
});
//# sourceMappingURL=workflow-run-reconciliation.test.js.map