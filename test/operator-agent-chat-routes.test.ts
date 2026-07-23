import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  matchAgentChatCloseRoute,
  matchAgentChatMessageRoute,
  matchAgentChatSessionRoute,
  matchAgentChatSessionsRoute,
} from '../src/routes/operator-agent-chat.js';

const ROUTE_FILE = new URL('../src/routes/operator-agent-chat.ts', import.meta.url);

test('agent chat routes decode exact agent and session targets', () => {
  assert.deepEqual(
    matchAgentChatSessionsRoute('/api/operator/agents/professor/chat-sessions'),
    { agentId: 'professor' },
  );
  assert.deepEqual(
    matchAgentChatSessionRoute('/api/operator/chat-sessions/chat%3Aabc%3A123'),
    { sessionId: 'chat:abc:123' },
  );
  assert.deepEqual(
    matchAgentChatMessageRoute('/api/operator/chat-sessions/chat%3Aabc%3A123/messages'),
    { sessionId: 'chat:abc:123' },
  );
  assert.deepEqual(
    matchAgentChatCloseRoute('/api/operator/chat-sessions/chat%3Aabc%3A123/close'),
    { sessionId: 'chat:abc:123' },
  );
});

test('malformed encoding and extra path segments fail closed', () => {
  assert.equal(matchAgentChatSessionsRoute('/api/operator/agents/%E0%A4%A/chat-sessions'), null);
  assert.equal(matchAgentChatSessionRoute('/api/operator/chat-sessions/%E0%A4%A'), null);
  assert.equal(matchAgentChatMessageRoute('/api/operator/chat-sessions/chat%3A1/messages/extra'), null);
  assert.equal(matchAgentChatCloseRoute('/api/operator/chat-sessions/chat%3A1/messages'), null);
});

test('session lists are bounded summaries while detail returns the transcript', async () => {
  const source = await readFile(ROUTE_FILE, 'utf-8');
  assert.match(source, /function serializeAgentChatSessionSummary/);
  assert.match(source, /return \{ \.\.\.session, turns: \[\] \}/);
  assert.match(source, /sessions: sessions\.map\(serializeAgentChatSessionSummary\)/);
  assert.match(source, /sendJSON\(res, 200, \{ session: serializeAgentChatSession\(session\) \}\)/);
});
