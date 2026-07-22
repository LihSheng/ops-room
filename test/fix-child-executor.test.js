import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createOrClaimTask, readTask } from '../src/services/review-task-store.js';
import { executeFixChildTask } from '../src/workflows/fix-child-executor.js';
const SHA = 'a'.repeat(40);
test('fix child executor binds one workspace, records pushed SHA, then applies cleanup policy', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ops-room-fix-executor-'));
    const { task } = await createOrClaimTask({
        dir,
        kind: 'fix',
        parentTaskId: 'review:parent',
        input: { repository: 'LihSheng-LinkUp', pr: 5, reviewedSha: SHA, agent: 'berlin', mode: 'auto-fix' },
    });
    let workerWorkspace = null;
    let outcomeTask = null;
    const result = await executeFixChildTask({
        dir,
        id: task.id,
        instanceId: 'test',
        ensureWorkspace: async ({ task: value }) => ({
            reused: false,
            workspace_path: '/workspaces/berlin/task-1',
            record: {
                workspace_id: 'task-1',
                task_id: value.id,
                owner_agent: value.agent,
                repository_id: value.repository,
                mode: 'branch',
                branch: 'agent/berlin/fix-5',
                resolved_sha: SHA,
                relative_path: 'berlin/task-1',
                state: 'active',
            },
        }),
        runWorker: async ({ workspace }) => {
            workerWorkspace = workspace;
            return { outcome: 'FIX_PUSHED', new_sha: 'b'.repeat(40) };
        },
        applyOutcome: async ({ task: value }) => {
            outcomeTask = value;
            return { action: 'cleanup' };
        },
    });
    assert.equal(result.state, 'FIX_PUSHED');
    assert.equal(workerWorkspace.record.workspace_id, 'task-1');
    assert.equal(outcomeTask.state, 'FIX_PUSHED');
    const completed = await readTask({ dir, id: task.id });
    assert.equal(completed.state, 'FIX_PUSHED');
    assert.equal(completed.workspace_id, 'task-1');
    assert.equal(completed.result.new_sha, 'b'.repeat(40));
});
//# sourceMappingURL=fix-child-executor.test.js.map