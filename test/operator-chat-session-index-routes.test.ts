import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { matchChatSessionIndexRoute } from '../src/routes/operator-chat-sessions.js';

const ROUTE_FILE = new URL('../src/routes/operator-chat-sessions.ts', import.meta.url);
const WEBHOOK_FILE = new URL('../src/server/webhook.ts', import.meta.url);

test('unified chat index route matches only the exact collection path', () => {
  assert.deepEqual(matchChatSessionIndexRoute('/api/operator/chat-sessions'), {});
  assert.equal(matchChatSessionIndexRoute('/api/operator/chat-sessions/'), null);
  assert.equal(matchChatSessionIndexRoute('/api/operator/chat-sessions/example'), null);
  assert.equal(matchChatSessionIndexRoute('/api/chat-sessions'), null);
});

test('unified chat index is read-only, agent.chat authorized, and CSRF-free only for GET', async () => {
  const source = await readFile(ROUTE_FILE, 'utf-8');
  assert.match(source, /method: 'GET'/);
  assert.match(source, /permission: 'agent\.chat'/);
  assert.match(source, /requireCsrf: false/);
  assert.match(source, /buildChatSessionIndex/);
  assert.match(source, /SESSION_TYPES/);
  assert.match(source, /SESSION_STATES/);
  assert.doesNotMatch(source, /parseBody|POST|PUT|PATCH|DELETE/);
});

test('server entrypoint registers the index before HTTP composition', async () => {
  const source = await readFile(WEBHOOK_FILE, 'utf-8');
  const route = source.indexOf("await import('../routes/operator-chat-sessions.js')");
  const http = source.indexOf("await import('./http.js')");
  assert.ok(route >= 0);
  assert.ok(http > route);
});
