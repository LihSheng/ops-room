import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { matchActivityEventsRoute } from '../src/routes/activity-events.js';

const ROUTE_FILE = new URL('../src/routes/activity-events.ts', import.meta.url);
const SERVER_FILE = new URL('../src/server/webhook.ts', import.meta.url);

test('activity-event route matches only the exact read path', () => {
  assert.deepEqual(matchActivityEventsRoute('/api/activity-events'), {});
  assert.equal(matchActivityEventsRoute('/api/activity-events/secret'), null);
  assert.equal(matchActivityEventsRoute('/api/operator/activity-events'), null);
});

test('activity-event route is dashboard-read authenticated and mutation-free', async () => {
  const source = await readFile(ROUTE_FILE, 'utf8');
  assert.match(source, /authorizeDashboardReadRequest/);
  assert.match(source, /method: 'GET'/);
  assert.match(source, /handleActivityEventIndex/);
  assert.doesNotMatch(source, /method: 'POST'|parseBody|idempotency|provider/i);
});

test('server startup registers activity events before composing HTTP routes', async () => {
  const source = await readFile(SERVER_FILE, 'utf8');
  assert.match(source, /import\('\.\.\/routes\/activity-events\.js'\)/);
  assert.ok(source.indexOf("activity-events.js") < source.indexOf("./http.js"));
});
