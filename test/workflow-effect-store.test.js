import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { claimWorkflowEffect, completeWorkflowEffect, listWorkflowEffects, readWorkflowEffect, reconcileInterruptedWorkflowEffects, } from '../src/services/workflow-effect-store.js';
const WORKFLOW_ID = 'workflow:LihSheng-ops-room:1234567890abcdef12345678';
const CHILD_ID = `${WORKFLOW_ID}:1:implementation`;
const OUTPUT_SHA = 'b'.repeat(40);
async function effectDir() {
    return mkdtemp(join(tmpdir(), 'ops-room-workflow-effects-'));
}
function claimInput(dir, overrides = {}) {
    return {
        dir,
        workflowId: WORKFLOW_ID,
        childId: CHILD_ID,
        effectType: 'provider.professor.implementation',
        idempotencyKey: 'attempt:0',
        payload: {
            stage: 'implementation',
            input_sha: 'a'.repeat(40),
            nested: { beta: 2, alpha: 1 },
        },
        ...overrides,
    };
}
test('effect identity is deterministic and an existing claim never re-executes', async () => {
    const dir = await effectDir();
    const first = await claimWorkflowEffect(claimInput(dir));
    const replay = await claimWorkflowEffect(claimInput(dir, {
        payload: {
            nested: { alpha: 1, beta: 2 },
            input_sha: 'a'.repeat(40),
            stage: 'implementation',
        },
    }));
    assert.equal(first.created, true);
    assert.equal(first.execute, true);
    assert.equal(replay.created, false);
    assert.equal(replay.execute, false);
    assert.equal(replay.effect.effect_id, first.effect.effect_id);
    assert.equal(Object.hasOwn(first.effect, 'payload'), false);
});
test('concurrent claims elect exactly one external executor', async () => {
    const dir = await effectDir();
    const claims = await Promise.all(Array.from({ length: 8 }, () => claimWorkflowEffect(claimInput(dir))));
    assert.equal(claims.filter((claim) => claim.created).length, 1);
    assert.equal(claims.filter((claim) => claim.execute).length, 1);
    assert.equal(new Set(claims.map((claim) => claim.effect.effect_id)).size, 1);
});
test('same identity with a conflicting payload fails closed', async () => {
    const dir = await effectDir();
    await claimWorkflowEffect(claimInput(dir));
    await assert.rejects(claimWorkflowEffect(claimInput(dir, {
        payload: { stage: 'implementation', input_sha: 'c'.repeat(40) },
    })), /workflow_effect_payload_conflict/);
});
test('terminal evidence is idempotent and immutable', async () => {
    const dir = await effectDir();
    const claim = await claimWorkflowEffect(claimInput(dir));
    const first = await completeWorkflowEffect({
        dir,
        effectId: claim.effect.effect_id,
        state: 'completed',
        resultCode: 'ok',
        outputSha: OUTPUT_SHA,
    });
    const replay = await completeWorkflowEffect({
        dir,
        effectId: claim.effect.effect_id,
        state: 'completed',
        resultCode: 'ok',
        outputSha: OUTPUT_SHA,
    });
    assert.equal(first.updated, true);
    assert.equal(replay.updated, false);
    assert.equal(replay.effect.output_sha, OUTPUT_SHA);
    await assert.rejects(completeWorkflowEffect({
        dir,
        effectId: claim.effect.effect_id,
        state: 'completed',
        resultCode: 'ok',
        outputSha: 'd'.repeat(40),
    }), /workflow_effect_terminal_conflict/);
});
test('startup reconciliation converts uncertain claimed effects to needs-human', async () => {
    const dir = await effectDir();
    const interrupted = await claimWorkflowEffect(claimInput(dir));
    const completed = await claimWorkflowEffect(claimInput(dir, {
        childId: `${WORKFLOW_ID}:1:test`,
        effectType: 'provider.tokyo.test',
    }));
    await completeWorkflowEffect({
        dir,
        effectId: completed.effect.effect_id,
        state: 'completed',
        resultCode: 'ok',
        outputSha: OUTPUT_SHA,
    });
    const recovered = await reconcileInterruptedWorkflowEffects({ dir });
    const interruptedAfter = await readWorkflowEffect({ dir, effectId: interrupted.effect.effect_id });
    const completedAfter = await readWorkflowEffect({ dir, effectId: completed.effect.effect_id });
    assert.equal(recovered.recovered_effects, 1);
    assert.equal(interruptedAfter.state, 'needs_human');
    assert.equal(interruptedAfter.result_code, 'workflow_effect_interrupted');
    assert.equal(completedAfter.state, 'completed');
});
test('effect listing is bounded and filterable without exposing payloads', async () => {
    const dir = await effectDir();
    await claimWorkflowEffect(claimInput(dir));
    await claimWorkflowEffect(claimInput(dir, {
        childId: `${WORKFLOW_ID}:1:test`,
        effectType: 'provider.tokyo.test',
    }));
    const childEffects = await listWorkflowEffects({ dir, childId: CHILD_ID, limit: 50 });
    assert.equal(childEffects.length, 1);
    assert.equal(childEffects[0].child_id, CHILD_ID);
    assert.equal(Object.hasOwn(childEffects[0], 'payload'), false);
});
//# sourceMappingURL=workflow-effect-store.test.js.map