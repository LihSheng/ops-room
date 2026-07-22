import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { claimEffect, completeEffect, resolveAmbiguousEffect, reclaimEffect } from '../src/services/review-effect-ledger.js';
/** Seed a fake task file so assertCurrentLease can find it. */
async function seedTask(dir, taskId, lease) {
    const digest = createHash('sha256').update(taskId).digest('hex');
    await writeFile(join(dir, `task-${digest}.json`), JSON.stringify({
        id: taskId,
        state: 'FIXING',
        lease: lease ? { lease_id: lease.lease_id, lease_epoch: lease.lease_epoch } : null,
        attempt: 1,
    }, null, 2));
}
test('effect ledger deduplicates a GitHub effect after completion', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ops-room-effects-'));
    const input = { dir, taskId: 'review:test:1:sha:agent:review', kind: 'github_review', fingerprint: 'sha:REQUEST_CHANGES' };
    const first = await claimEffect(input);
    assert.equal(first.claimed, true);
    assert.equal(first.state, 'CLAIMED');
    await completeEffect({ ...input, effectId: first.effect.id, result: { review_id: 123 } });
    const duplicate = await claimEffect(input);
    assert.equal(duplicate.claimed, false);
    assert.equal(duplicate.state, 'COMPLETED');
    assert.equal(duplicate.effect.state, 'COMPLETED');
});
test('claimEffect returns CLAIMED state for uncompleted existing effects', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ops-room-effects-'));
    const input = { dir, taskId: 'review:test:2:sha:agent:review', kind: 'github_review', fingerprint: 'sha:CLAIMED-test' };
    const first = await claimEffect(input);
    assert.equal(first.claimed, true);
    assert.equal(first.state, 'CLAIMED');
    // Second attempt on the same uncompleted effect returns CLAIMED, not COMPLETED
    const second = await claimEffect(input);
    assert.equal(second.claimed, false);
    assert.equal(second.state, 'CLAIMED', 'uncompleted effect should report state as CLAIMED');
    // After completion, duplicate returns COMPLETED
    await completeEffect({ dir, effectId: first.effect.id, result: { event: 'APPROVE' } });
    const third = await claimEffect(input);
    assert.equal(third.claimed, false);
    assert.equal(third.state, 'COMPLETED');
});
test('ABANDONED effects allow re-claim after operator resolution', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ops-room-effects-'));
    const input = { dir, taskId: 'review:test:3:sha:agent:review', kind: 'github_commit_status', fingerprint: 'sha:ABANDONED-test' };
    const first = await claimEffect(input);
    assert.equal(first.claimed, true);
    // Abandon the effect
    await resolveAmbiguousEffect({ dir, effectId: first.effect.id, resolution: 'abandon' });
    // A new claim attempt gets ABANDONED state — caller can then retry with a new fingerprint
    const afterAbandon = await claimEffect(input);
    assert.equal(afterAbandon.claimed, false);
    assert.equal(afterAbandon.state, 'ABANDONED');
});
test('reclaimEffect atomically transitions ABANDONED to CLAIMED', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ops-room-effects-'));
    const input = { dir, taskId: 'review:test:4:sha:agent:review', kind: 'github_review', fingerprint: 'sha:reclaim-test' };
    const first = await claimEffect(input);
    assert.equal(first.claimed, true);
    // Abandon, then atomically reclaim
    await resolveAmbiguousEffect({ dir, effectId: first.effect.id, resolution: 'abandon' });
    const reclaimed = await reclaimEffect({ dir, effectId: first.effect.id });
    assert.equal(reclaimed.reclaimed, true);
    assert.equal(reclaimed.effect.state, 'CLAIMED');
    // Cannot reclaim a non-ABANDONED effect (already CLAIMED from first reclaim)
    const secondAttempt = await reclaimEffect({ dir, effectId: first.effect.id });
    assert.equal(secondAttempt.reclaimed, false);
    assert.ok(secondAttempt.reason.includes('not_abandoned'), 'should reject non-ABANDONED reclaim');
});
test('fenced: stale worker rejected from new effect when task has different lease', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ops-room-effects-'));
    const taskId = 'review:test:5:sha:agent:fenced';
    const leaseA = { lease_id: 'lease-a', lease_epoch: 1 };
    const leaseB = { lease_id: 'lease-b', lease_epoch: 2 };
    await seedTask(dir, taskId, leaseB); // task is owned by B
    // Worker A tries to create a brand-new effect
    await assert.rejects(() => claimEffect({ dir, taskId, kind: 'github_review', fingerprint: 'sha:fenced-new', leaseId: leaseA.lease_id, leaseEpoch: leaseA.lease_epoch }), /Stale lease/, 'Stale worker A should be rejected when task is owned by B');
});
test('fenced: stale worker rejected when task has no current lease (retry window)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ops-room-effects-'));
    const taskId = 'review:test:6:sha:agent:null-lease';
    const leaseA = { lease_id: 'lease-a', lease_epoch: 1 };
    await seedTask(dir, taskId, null); // task retried, lease: null
    await assert.rejects(() => claimEffect({ dir, taskId, kind: 'github_review', fingerprint: 'sha:null-lease-new', leaseId: leaseA.lease_id, leaseEpoch: leaseA.lease_epoch }), /no current lease/, 'Stale worker should be rejected when task has no current lease');
});
test('fenced: stale worker cannot complete effect after task lease changed', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ops-room-effects-'));
    const taskId = 'review:test:7:sha:agent:complete-fence';
    const leaseA = { lease_id: 'lease-a', lease_epoch: 1 };
    const leaseB = { lease_id: 'lease-b', lease_epoch: 2 };
    // Seed with lease A so worker A can initially create
    await seedTask(dir, taskId, leaseA);
    const effect = await claimEffect({ dir, taskId, kind: 'github_review', fingerprint: 'sha:complete-fence', leaseId: leaseA.lease_id, leaseEpoch: leaseA.lease_epoch });
    assert.equal(effect.claimed, true);
    // Now task lease changes to B
    await seedTask(dir, taskId, leaseB);
    // Worker A tries to complete
    await assert.rejects(() => completeEffect({ dir, effectId: effect.effect.id, result: { event: 'APPROVE' }, leaseId: leaseA.lease_id, leaseEpoch: leaseA.lease_epoch }), /Stale lease/, 'Stale worker should be rejected from completing effect after lease changed');
});
//# sourceMappingURL=review-effect-ledger.test.js.map