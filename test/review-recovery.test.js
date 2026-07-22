import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { claimTask, createOrClaimTask, recoverStaleTask, readTask, transitionTask } from '../src/services/review-task-store.js';
test('stale running task becomes recoverable only within retry budget', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ops-room-recover-'));
    const { task } = await createOrClaimTask({
        dir,
        input: { repository: 'LihSheng/LinkUp', pr: 40, headSha: 'a'.repeat(40), agent: 'professor', mode: 'review' },
    });
    await claimTask({ dir, id: task.id, instanceId: 'old', leaseId: 'old-lease' });
    await transitionTask({ dir, id: task.id, to: 'CLAIMED', reason: 'test', patch: { attempt: 1 } });
    await transitionTask({ dir, id: task.id, to: 'RUNNING', reason: 'test' });
    const recovered = await recoverStaleTask({ dir, id: task.id, now: '2030-01-01T00:31:00.000Z', staleMinutes: 30, retryLimit: 2 });
    assert.equal(recovered.recovered, true);
    assert.equal(recovered.retry_allowed, true);
    assert.equal(recovered.re_dispatched, true);
    assert.equal(recovered.attempt, 2);
    assert.equal((await readTask({ dir, id: task.id })).state, 'QUEUED');
    assert.equal((await readTask({ dir, id: task.id })).attempt, 2);
});
//# sourceMappingURL=review-recovery.test.js.map