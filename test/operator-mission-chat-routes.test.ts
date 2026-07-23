import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  matchMissionChatCloseRoute,
  matchMissionChatMessageRoute,
  matchMissionChatSessionRoute,
  matchMissionParticipantChatRoute,
} from '../src/routes/operator-mission-chat.js';

const ROUTE_FILE = new URL('../src/routes/operator-mission-chat.ts', import.meta.url);

test('Mission participant chat routes decode exact Mission and session targets', () => {
  assert.deepEqual(
    matchMissionParticipantChatRoute('/api/operator/missions/mission%3Aabc%3A123/participant-chat'),
    { missionId: 'mission:abc:123' },
  );
  assert.deepEqual(
    matchMissionChatSessionRoute('/api/operator/mission-chat-sessions/mission-chat%3Aabc'),
    { sessionId: 'mission-chat:abc' },
  );
  assert.deepEqual(
    matchMissionChatMessageRoute('/api/operator/mission-chat-sessions/mission-chat%3Aabc/messages'),
    { sessionId: 'mission-chat:abc' },
  );
  assert.deepEqual(
    matchMissionChatCloseRoute('/api/operator/mission-chat-sessions/mission-chat%3Aabc/close'),
    { sessionId: 'mission-chat:abc' },
  );
});

test('malformed encoding and extra path segments fail closed', () => {
  assert.equal(matchMissionParticipantChatRoute('/api/operator/missions/%E0%A4%A/participant-chat'), null);
  assert.equal(matchMissionChatSessionRoute('/api/operator/mission-chat-sessions/%E0%A4%A'), null);
  assert.equal(matchMissionChatMessageRoute('/api/operator/mission-chat-sessions/mission-chat%3A1/messages/extra'), null);
  assert.equal(matchMissionChatCloseRoute('/api/operator/mission-chat-sessions/mission-chat%3A1/messages'), null);
});

test('Mission routes require agent.chat and keep terminal transcripts readable', async () => {
  const source = await readFile(ROUTE_FILE, 'utf-8');
  assert.match(source, /permission: 'agent\.chat'/);
  assert.match(source, /req\.method === 'GET' \? false : undefined/);
  assert.match(source, /can_mutate: missionAllowsChatMutation\(mission\)/);
  assert.match(source, /session: session \? serializeMissionChatSession\(session\) : null/);
  assert.match(source, /handleCreateMissionChatSession/);
  assert.match(source, /handleAppendMissionChatMessage/);
  assert.match(source, /handleCloseMissionChatSession/);
});
