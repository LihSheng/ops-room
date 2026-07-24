import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';

const root = process.cwd();

async function source(path: string) {
  return readFile(join(root, path), 'utf-8');
}

test('dashboard activity client consumes the durable server-owned activity contract', async () => {
  const api = await source('dashboard/src/api/activity-events.ts');
  assert.match(api, /\/api\/activity-events/);
  assert.match(api, /severity/);
  assert.match(api, /category/);
  assert.match(api, /mission_id/);
  assert.match(api, /attention/);
  assert.doesNotMatch(api, /\/api\/tasks/);
});

test('dashboard notification client uses authenticated H.2 read and mutation routes', async () => {
  const api = await source('dashboard/src/api/operator-notifications.ts');
  assert.match(api, /\/api\/operator\/notifications/);
  assert.match(api, /\/read/);
  assert.match(api, /\/acknowledge/);
  assert.match(api, /X-Ops-Room-CSRF/);
  assert.match(api, /idempotency_key/);
  assert.match(api, /credentials: 'same-origin'/);
  assert.doesNotMatch(api, /provider[_-]output/i);
  assert.doesNotMatch(api, /chat[_-]transcript/i);
});

test('Activity route is durable and exposes the governed notification workspace', async () => {
  const page = await source('dashboard/src/operational-pages.tsx');
  const activitySection = page.slice(page.indexOf('export function ActivityPage'), page.indexOf('function backendSummary'));
  assert.match(page, /Durable Mission activity/);
  assert.match(page, /activityEventsApi\.list/);
  assert.match(page, /operatorNotificationsApi\.list/);
  assert.match(page, /operatorNotificationsApi\.markRead/);
  assert.match(page, /operatorNotificationsApi\.acknowledge/);
  assert.match(page, /Human session required/);
  assert.match(page, /No matching durable activity/);
  assert.match(page, /no placeholder events are created/i);
  assert.match(activitySection, /Activity and notifications/);
  assert.match(activitySection, /view.*notifications/);
  assert.doesNotMatch(activitySection, /useOperationalData/);
  assert.doesNotMatch(activitySection, /opsApi\.tasks/);
});

test('notification drill-in preserves exact durable links and governed state actions', async () => {
  const page = await source('dashboard/src/operational-pages.tsx');
  assert.match(page, /notification_id/);
  assert.match(page, /activity_id/);
  assert.match(page, /Acknowledgement reason/);
  assert.match(page, /acknowledgement and audit evidence were recorded/i);
  assert.match(page, /Mission:/);
  assert.match(page, /Stage:/);
  assert.match(page, /Agent:/);
  assert.match(page, /Workflow:/);
  assert.match(page, /Needs Human/);
  assert.doesNotMatch(page, /fetch\([^)]*provider/i);
  assert.doesNotMatch(page, /\/api\/operator\/workflows\/[^'"`]+\/(retry|approve|resolve)/);
});

test('global header badge reads unread state and routes to the notification inbox', async () => {
  const badge = await source('dashboard/src/components/NotificationHeaderBadge.tsx');
  const main = await source('dashboard/src/main.tsx');
  assert.match(badge, /state: 'unread'/);
  assert.match(badge, /summary\.unread/);
  assert.match(badge, /\/activity\?view=notifications/);
  assert.match(badge, /createPortal/);
  assert.match(badge, /query\.isError/);
  assert.match(main, /NotificationHeaderBadge/);
});
