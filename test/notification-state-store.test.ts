import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  acknowledgeOperatorNotification,
  markOperatorNotificationRead,
  notificationStateFor,
  readOperatorNotificationState,
} from '../src/services/notification-state-store.js';

const NOTIFICATION_ID = `notification:${'a'.repeat(40)}`;
const ACTIVITY_ID = 'mission-a:activity:event-a';

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'ops-room-notifications-'));
  return { root, dir: join(root, 'states') };
}

test('notification state is isolated per operator and unread by default', async (t) => {
  const { root, dir } = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  const alpha = await readOperatorNotificationState({ dir, actorId: 'operator-alpha' });
  const beta = await readOperatorNotificationState({ dir, actorId: 'operator-beta' });
  assert.equal(notificationStateFor(alpha, NOTIFICATION_ID).state, 'unread');
  assert.equal(notificationStateFor(beta, NOTIFICATION_ID).state, 'unread');
  assert.notEqual(alpha.actor_id, beta.actor_id);
});

test('mark read persists across a restart-style re-read', async (t) => {
  const { root, dir } = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  const result = await markOperatorNotificationRead({
    dir,
    actorId: 'operator-alpha',
    notificationId: NOTIFICATION_ID,
    activityId: ACTIVITY_ID,
    now: () => '2026-07-23T23:40:00.000Z',
  });
  assert.equal(result.idempotent, false);
  assert.equal(notificationStateFor(result.record, NOTIFICATION_ID).state, 'read');
  const reloaded = await readOperatorNotificationState({ dir, actorId: 'operator-alpha' });
  assert.deepEqual(notificationStateFor(reloaded, NOTIFICATION_ID), {
    state: 'read',
    read_at: '2026-07-23T23:40:00.000Z',
    acknowledged_at: null,
    acknowledgement_reason: null,
  });
});

test('acknowledgement implies read and cannot be downgraded', async (t) => {
  const { root, dir } = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  const acknowledged = await acknowledgeOperatorNotification({
    dir,
    actorId: 'operator-alpha',
    notificationId: NOTIFICATION_ID,
    activityId: ACTIVITY_ID,
    reason: 'Investigating the failed stage',
    now: () => '2026-07-23T23:41:00.000Z',
  });
  assert.equal(notificationStateFor(acknowledged.record, NOTIFICATION_ID).state, 'acknowledged');
  const readAfterAcknowledgement = await markOperatorNotificationRead({
    dir,
    actorId: 'operator-alpha',
    notificationId: NOTIFICATION_ID,
    activityId: ACTIVITY_ID,
    now: () => '2026-07-23T23:42:00.000Z',
  });
  assert.equal(readAfterAcknowledgement.idempotent, true);
  assert.deepEqual(notificationStateFor(readAfterAcknowledgement.record, NOTIFICATION_ID), {
    state: 'acknowledged',
    read_at: '2026-07-23T23:41:00.000Z',
    acknowledged_at: '2026-07-23T23:41:00.000Z',
    acknowledgement_reason: 'Investigating the failed stage',
  });
});

test('concurrent read and acknowledge updates serialize to acknowledged', async (t) => {
  const { root, dir } = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  await Promise.all([
    markOperatorNotificationRead({
      dir,
      actorId: 'operator-alpha',
      notificationId: NOTIFICATION_ID,
      activityId: ACTIVITY_ID,
      now: () => '2026-07-23T23:43:00.000Z',
    }),
    acknowledgeOperatorNotification({
      dir,
      actorId: 'operator-alpha',
      notificationId: NOTIFICATION_ID,
      activityId: ACTIVITY_ID,
      reason: 'Accepted ownership',
      now: () => '2026-07-23T23:44:00.000Z',
    }),
  ]);
  const reloaded = await readOperatorNotificationState({ dir, actorId: 'operator-alpha' });
  assert.equal(notificationStateFor(reloaded, NOTIFICATION_ID).state, 'acknowledged');
});

test('a notification ID cannot be rebound to another durable activity', async (t) => {
  const { root, dir } = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  await markOperatorNotificationRead({
    dir,
    actorId: 'operator-alpha',
    notificationId: NOTIFICATION_ID,
    activityId: ACTIVITY_ID,
    now: () => '2026-07-23T23:45:00.000Z',
  });
  await assert.rejects(
    acknowledgeOperatorNotification({
      dir,
      actorId: 'operator-alpha',
      notificationId: NOTIFICATION_ID,
      activityId: 'mission-b:activity:event-b',
      reason: 'Conflict',
      now: () => '2026-07-23T23:46:00.000Z',
    }),
    /notification_state_activity_conflict/,
  );
});
