import assert from 'node:assert/strict';
import test from 'node:test';

import {
  matchAgentChatCloseRoute,
  matchAgentChatMessageRoute,
  matchAgentChatSessionRoute,
  matchAgentChatSessionsRoute,
} from '../src/routes/operator-agent-chat.js';

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
