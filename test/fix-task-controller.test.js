import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createFixChildTask } from '../src/workflows/fix-task-controller.js';
test('change-requested parent creates one idempotent SHA-bound fix child', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ops-room-fix-child-'));
    const input = { dir, repository: 'LihSheng/LinkUp', pr: 40, reviewedSha: 'a'.repeat(40), parentTaskId: 'review:LihSheng-LinkUp:40:test:professor:review', agent: 'professor', policy: { allow_auto_fix: true, fix_agent: 'berlin' }, reviewResult: { verdict: 'REQUEST_CHANGES', findings: [] } };
    const first = await createFixChildTask(input);
    const duplicate = await createFixChildTask(input);
    assert.equal(first.created, true);
    assert.equal(first.task.kind, 'fix');
    assert.equal(first.task.parent_task_id, input.parentTaskId);
    assert.equal(first.task.reviewed_sha, input.reviewedSha);
    assert.equal(first.task.agent, 'berlin');
    assert.deepEqual(first.task.review_result, input.reviewResult);
    assert.equal(duplicate.created, false);
    assert.equal(duplicate.task.id, first.task.id);
});
//# sourceMappingURL=fix-task-controller.test.js.map