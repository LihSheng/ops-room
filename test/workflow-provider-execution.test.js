import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { executeWorkflowChildWithProviders } from '../src/services/workflow-provider-execution.js';
const INPUT_SHA = 'a'.repeat(40);
const OUTPUT_SHA = 'b'.repeat(40);
const WORKFLOW_ID = 'workflow:LihSheng-ops-room:1234567890abcdef12345678';
const CHILD_ID = `${WORKFLOW_ID}:1:implementation`;
async function effectDir() {
    return mkdtemp(join(tmpdir(), 'ops-room-provider-execution-'));
}
test('provider execution composes the fenced stage runner into explicit child execution', async () => {
    const effectsDir = await effectDir();
    let providerCalls = 0;
    let childExecutionCalls = 0;
    const result = await executeWorkflowChildWithProviders({
        effectsDir,
        workflowRunsDir: '/workflow-runs',
        workflowId: WORKFLOW_ID,
        childId: CHILD_ID,
        providerAdapters: {
            professor: async ({ prompt, cwd }) => {
                providerCalls += 1;
                assert.equal(cwd, '/internal/workspace/path');
                assert.match(prompt, /Stage: implementation/);
                return { outcome: 'completed', output_sha: OUTPUT_SHA };
            },
        },
        resolveStageInstruction: async () => 'Implement the requested change and run tests.',
        executeChild: async (input) => {
            childExecutionCalls += 1;
            assert.equal(typeof input.runStage, 'function');
            return input.runStage({
                run: {
                    workflow_id: WORKFLOW_ID,
                    workflow_type: 'feature-development',
                    repository_id: 'LihSheng/ops-room',
                    source_sha: INPUT_SHA,
                    state: 'active',
                    current_iteration: 1,
                    policy: { max_iterations: 3, max_concurrency: 1 },
                },
                child: {
                    child_id: CHILD_ID,
                    stage: 'implementation',
                    owner_agent: 'professor',
                    iteration: 1,
                    attempt: 0,
                    state: 'active',
                    depends_on: null,
                    input_sha: INPUT_SHA,
                },
                workspace_path: '/internal/workspace/path',
                workspace: {
                    workspace_id: 'task-professor-1234567890abcdef',
                    mode: 'branch',
                    repository_id: 'LihSheng/ops-room',
                    branch: 'agent/professor/feature-123-i1',
                    resolved_sha: INPUT_SHA,
                    state: 'active',
                },
            });
        },
    });
    assert.deepEqual(result, { outcome: 'completed', output_sha: OUTPUT_SHA });
    assert.equal(childExecutionCalls, 1);
    assert.equal(providerCalls, 1);
});
//# sourceMappingURL=workflow-provider-execution.test.js.map