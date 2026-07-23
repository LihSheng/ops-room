import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  matchNotificationActionRoute,
  matchNotificationDetailRoute,
  matchNotificationListRoute,
} from '../src/routes/operator-notifications.js';

const ROUTE_FILE = new URL('../src/routes/operator-notifications.ts', import.meta.url);
const STARTUP_FILE = new URL('../src/server/webhook.ts', import.meta.url);
const RUNTIME_FILE = new URL('../src/services/runtime-paths.ts', import.meta.url);

test('notification routes match only exact list, detail, and action paths', () => {
  const id = `notification:${'a'.repeat(40)}`;
  assert.deepEqual(matchNotificationListRoute('/api/operator/notifications'), {});
  assert.equal(matchNotificationListRoute('/api/operator/notifications/'), null);
  assert.deepEqual(matchNotificationDetailRoute(`/api/operator/notifications/${id}`), { notificationId: id });
  assert.equal(matchNotificationDetailRoute(`/api/operator/notifications/${id}/read`), null);
  assert.deepEqual(matchNotificationActionRoute(`/api/operator/notifications/${id}/read`), { notificationId: id, action: 'read' });
  assert.deepEqual(matchNotificationActionRoute(`/api/operator/notifications/${id}/acknowledge`), { notificationId: id, action: 'acknowledge' });
  assert.equal(matchNotificationActionRoute(`/api/operator/notifications/${id}/delete`), null);
});

test('notification reads and mutations use dashboard.read with CSRF only for POST', async () => {
  const source = await readFile(ROUTE_FILE, 'utf8');
  assert.match(source, /permission: 'dashboard\.read'/);
  assert.match(source, /const notificationListRoute:[\s\S]*method: 'GET'[\s\S]*authorize\(req, false\)/);
  assert.match(source, /const notificationDetailRoute:[\s\S]*method: 'GET'[\s\S]*authorize\(req, false\)/);
  assert.match(source, /const notificationActionRoute:[\s\S]*method: 'POST'[\s\S]*authorize\(req, true\)/);
  assert.match(source, /requireStepUp: false/);
  assert.doesNotMatch(source, /permission: 'policy\.manage'|permission: 'agent\.chat'/);
});

test('notification routes expose no delete, provider, workflow, or external-delivery mutation', async () => {
  const source = await readFile(ROUTE_FILE, 'utf8');
  assert.doesNotMatch(source, /method: 'DELETE'|invokeProvider|transitionTask|resolveAmbiguousEffect|sendEmail|Slack|Discord|GitHub comment/);
  assert.match(source, /handleMarkNotificationRead/);
  assert.match(source, /handleAcknowledgeNotification/);
});

test('notification routes are registered before server composition with a dedicated runtime path', async () => {
  const [startup, runtime] = await Promise.all([
    readFile(STARTUP_FILE, 'utf8'),
    readFile(RUNTIME_FILE, 'utf8'),
  ]);
  assert.match(startup, /await import\('\.\.\/routes\/operator-notifications\.js'\);[\s\S]*await import\('\.\/http\.js'\);/);
  assert.match(runtime, /OPERATOR_NOTIFICATION_STATE_DIR/);
  assert.match(runtime, /OPS_ROOM_OPERATOR_NOTIFICATION_STATE_DIR/);
});
