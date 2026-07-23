import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const API_FILE = new URL('../dashboard/src/api/chat-sessions.ts', import.meta.url);
const PAGE_FILE = new URL('../dashboard/src/pages/ChatSessionsPage.tsx', import.meta.url);
const INTERVENTIONS_FILE = new URL('../dashboard/src/pages/InterventionsPage.tsx', import.meta.url);
const CHAT_INTERVENTIONS_FILE = new URL('../dashboard/src/components/ChatInterventionPanel.tsx', import.meta.url);

test('Needs Human exposes a first-class Chat Sessions workspace', async () => {
  const source = await readFile(INTERVENTIONS_FILE, 'utf-8');
  assert.match(source, /ChatSessionsPage/);
  assert.match(source, /ChatInterventionPanel/);
  assert.match(source, /view.*chat/);
  assert.match(source, /Chat Sessions/);
  assert.match(source, /Governed task, workflow, effect, workspace, and chat evidence/);
});

test('chat session page separates transcript-free index from exact detail reads', async () => {
  const source = await readFile(PAGE_FILE, 'utf-8');
  assert.match(source, /Transcript-free lifecycle evidence/);
  assert.match(source, /chatSessionsApi\.list/);
  assert.match(source, /chatSessionsApi\.detail/);
  assert.match(source, /selectedSessionId/);
  assert.match(source, /Message and response text is requested only after selecting one exact durable session/);
  assert.match(source, /Agent Detail/);
  assert.match(source, /Mission Room/);
  assert.match(source, /uncertain provider turn was not replayed automatically/);
  assert.doesNotMatch(source, /localStorage|sessionStorage|dangerouslySetInnerHTML/);
});

test('typed chat client uses authenticated index and exact direct or Mission detail routes', async () => {
  const source = await readFile(API_FILE, 'utf-8');
  assert.match(source, /\/api\/operator\/chat-sessions/);
  assert.match(source, /\/api\/operator\/chat-sessions\/\$\{encodeURIComponent\(session\.session_id\)\}/);
  assert.match(source, /\/api\/operator\/mission-chat-sessions\/\$\{encodeURIComponent\(session\.session_id\)\}/);
  assert.match(source, /credentials: 'same-origin'/);
  assert.match(source, /attention/);
  assert.doesNotMatch(source, /idempotency_key|content_hash|response_digest|provider payload/i);
});

test('chat Needs Human cards remain transcript-free and block automatic replay', async () => {
  const source = await readFile(CHAT_INTERVENTIONS_FILE, 'utf-8');
  assert.match(source, /attention: true/);
  assert.match(source, /Automatic replay remains blocked/);
  assert.match(source, /Inspect exact session/);
  assert.match(source, /attention_code/);
  assert.match(source, /latest_turn\?\.target_agent_id/);
  assert.doesNotMatch(source, /human_message\.content|agent_message\.content|turns\.map/);
});
