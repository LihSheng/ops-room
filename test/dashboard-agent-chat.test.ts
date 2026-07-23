import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const PAGE_FILE = new URL('../dashboard/src/pages/AgentDetailPage.tsx', import.meta.url);
const PANEL_FILE = new URL('../dashboard/src/components/AgentChatPanel.tsx', import.meta.url);
const API_FILE = new URL('../dashboard/src/api/agent-chat.ts', import.meta.url);

test('Agent Detail hosts a first-class governed direct chat panel', async () => {
  const page = await readFile(PAGE_FILE, 'utf-8');
  assert.match(page, /import \{ AgentChatPanel \}/);
  assert.match(page, /<AgentChatPanel agentId=\{profile\.id\} displayName=\{profile\.display_name\} \/>/);
  assert.match(page, /<AgentOperationalSummary/);
});

test('chat panel separates role gating, durable evidence, and conversation-only authority', async () => {
  const panel = await readFile(PANEL_FILE, 'utf-8');
  assert.match(panel, /roles\.includes\('operator'\) \|\| roles\.includes\('administrator'\)/);
  assert.match(panel, /agent\.chat/);
  assert.match(panel, /Conversation-only authority/);
  assert.match(panel, /cannot read files, run tools, mutate repositories, change workflow state/);
  assert.match(panel, /Only final responses are stored/);
  assert.match(panel, /The interrupted or failed turn was not replayed automatically/);
  assert.match(panel, /same message request key is retained/i);
  assert.match(panel, /same session request key is retained/i);
  assert.match(panel, /same close request key is retained/i);
  assert.match(panel, /\['agent-chat-sessions', agentId\]/);
  assert.match(panel, /\['agent-chat-session', sessionId\]/);
  assert.match(panel, /\['agent-fleet'\]/);
  assert.match(panel, /\['interventions'\]/);
  assert.doesNotMatch(panel, /dangerouslySetInnerHTML|localStorage|sessionStorage/);
});

test('typed client binds exact encoded routes, CSRF, and idempotency fields', async () => {
  const api = await readFile(API_FILE, 'utf-8');
  assert.match(api, /\/api\/operator\/agents\/\$\{encodeURIComponent\(agentId\)\}\/chat-sessions/);
  assert.match(api, /\/api\/operator\/chat-sessions\/\$\{encodeURIComponent\(sessionId\)\}\/messages/);
  assert.match(api, /\/api\/operator\/chat-sessions\/\$\{encodeURIComponent\(sessionId\)\}\/close/);
  assert.match(api, /'X-Ops-Room-CSRF': csrfToken/);
  assert.match(api, /idempotency_key: idempotencyKey/);
  assert.match(api, /credentials: 'same-origin'/);
  assert.match(api, /browser-agent-chat:/);
});

test('direct chat source does not expose server-owned internals', async () => {
  const source = `${await readFile(PANEL_FILE, 'utf-8')}\n${await readFile(API_FILE, 'utf-8')}`;
  assert.doesNotMatch(source, /absolute_path|relative_path|payload_hash|response_digest|environment value|authenticated remote|raw provider/i);
});
