import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { appendAuditEvent, listAuditEvents, readAuditEvent } from '../src/services/audit-log.js';
import { resolveOperatorIdentity } from '../src/services/operator-identity.js';

const actor = {
  actor_type: 'human_operator',
  actor_id: 'lihsheng',
  actor_display_name: 'Lih Sheng',
  auth_method: 'operator_token',
};

test('audit events persist as append-only files and support bounded filtering', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ops-room-audit-'));
  const accepted = await appendAuditEvent({
    dir,
    operation: 'task.cancel',
    actor,
    target: { type: 'review_task', id: 'task-1' },
    reason: 'Duplicate task',
    idempotencyKey: 'cancel-task-0001',
    previousState: 'RUNNING',
    resultingState: 'CANCEL_REQUESTED',
    outcome: 'accepted',
    createdAt: '2026-07-17T09:00:00.000Z',
  });
  await appendAuditEvent({
    dir,
    operation: 'task.cancel',
    actor: { ...actor, actor_id: 'another-operator' },
    target: { type: 'review_task', id: 'task-2' },
    reason: 'Not allowed',
    outcome: 'rejected',
    errorCode: 'invalid_transition',
    createdAt: '2026-07-17T10:00:00.000Z',
  });

  assert.deepEqual(await readAuditEvent({ dir, eventId: accepted.event_id }), accepted);
  const filtered = await listAuditEvents({ dir, actorId: 'lihsheng', operation: 'task.cancel', limit: 1 });
  assert.equal(filtered.length, 1);
  assert.equal(filtered[0].event_id, accepted.event_id);
  assert.equal(JSON.stringify(filtered).includes('Bearer'), false);
});

test('operator identity is explicit and rejects missing configuration', () => {
  assert.deepEqual(resolveOperatorIdentity({ actorId: 'lihsheng', displayName: 'Lih Sheng' }), actor);
  assert.throws(() => resolveOperatorIdentity({ actorId: '', displayName: '' }), /not configured/);
});
