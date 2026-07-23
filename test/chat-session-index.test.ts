import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  appendAgentChatTurn,
  closeAgentChatSession,
  createOrLoadAgentChatSession,
} from '../src/services/agent-chat-store.js';
import { buildChatSessionIndex } from '../src/services/chat-session-index.js';
import {
  appendMissionChatTurn,
  createOrLoadMissionChatSession,
} from '../src/services/mission-chat-store.js';

const ACTOR = {
  actor_id: 'operator-index-test',
  actor_type: 'human_operator',
  actor_display_name: 'Operator Index Test',
};

const MISSION = {
  mission_id: 'mission:index-test',
  title: 'Unified chat index test',
  objective: 'Verify bounded cross-session evidence.',
  state: 'active',
  participants: [
    { agent_id: 'professor', roles: ['implementation', 'integration'] },
    { agent_id: 'tokyo', roles: ['test'] },
    { agent_id: 'berlin', roles: ['review'] },
  ],
};

async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'ops-room-chat-index-'));
  return {
    root,
    directDir: join(root, 'direct'),
    missionDir: join(root, 'mission'),
  };
}

test('unified index merges direct and Mission summaries without transcript duplication', async () => {
  const target = await setup();
  const direct = await createOrLoadAgentChatSession({
    dir: target.directDir,
    agentId: 'professor',
    actor: ACTOR,
    idempotencyKey: 'direct-index-create-0001',
    title: 'Professor direct evidence',
  });
  await appendAgentChatTurn({
    dir: target.directDir,
    sessionId: direct.session.session_id,
    actor: ACTOR,
    content: 'Private direct message text',
    idempotencyKey: 'direct-index-message-0001',
    invokeProvider: async () => ({ text: 'Private direct response text', provider: 'test', model: 'test-model' }),
  });

  const mission = await createOrLoadMissionChatSession({
    dir: target.missionDir,
    mission: MISSION,
    actor: ACTOR,
    idempotencyKey: 'mission-index-create-0001',
  });
  await appendMissionChatTurn({
    dir: target.missionDir,
    mission: MISSION,
    sessionId: mission.session.session_id,
    targetAgentId: 'tokyo',
    actor: ACTOR,
    content: 'Private Mission message text',
    idempotencyKey: 'mission-index-message-0001',
    invokeProvider: async () => { throw new Error('mission_chat_provider_interrupted'); },
  });

  const result = await buildChatSessionIndex({
    directDir: target.directDir,
    missionDir: target.missionDir,
    now: () => '2026-07-23T14:50:00.000Z',
  });

  assert.equal(result.count, 2);
  assert.equal(result.total_matching, 2);
  assert.equal(result.attention_count, 1);
  assert.deepEqual(result.sessions.map((session) => session.session_type).sort(), ['direct', 'mission']);
  const missionSummary = result.sessions.find((session) => session.session_type === 'mission');
  assert.equal(missionSummary?.state, 'needs_human');
  assert.equal(missionSummary?.latest_turn?.target_agent_id, 'tokyo');
  assert.equal(missionSummary?.attention_code, 'mission_chat_provider_interrupted');
  assert.match(missionSummary?.links.session_index || '', /^\/interventions\?view=chat&session=/);

  const publicJson = JSON.stringify(result);
  assert.doesNotMatch(publicJson, /Private direct message text/);
  assert.doesNotMatch(publicJson, /Private direct response text/);
  assert.doesNotMatch(publicJson, /Private Mission message text/);
  assert.doesNotMatch(publicJson, /idempotency_key|content_hash|response_digest|provider_pending.*content/i);
});

test('attention filtering excludes closed historical sessions', async () => {
  const target = await setup();
  const direct = await createOrLoadAgentChatSession({
    dir: target.directDir,
    agentId: 'berlin',
    actor: ACTOR,
    idempotencyKey: 'direct-index-create-0002',
    title: 'Closed history',
  });
  await closeAgentChatSession({
    dir: target.directDir,
    sessionId: direct.session.session_id,
    actor: ACTOR,
    reason: 'Historical acceptance complete',
    idempotencyKey: 'direct-index-close-0001',
  });

  const result = await buildChatSessionIndex({
    directDir: target.directDir,
    missionDir: target.missionDir,
    filters: { attentionOnly: true },
  });

  assert.equal(result.count, 0);
  assert.equal(result.attention_count, 0);

  const history = await buildChatSessionIndex({
    directDir: target.directDir,
    missionDir: target.missionDir,
    filters: { state: 'closed' },
  });
  assert.equal(history.count, 1);
  assert.equal(history.sessions[0].state, 'closed');
  assert.equal(history.sessions[0].attention_required, false);
});

test('index filters by exact ownership and degrades sources independently', async () => {
  const target = await setup();
  const mission = await createOrLoadMissionChatSession({
    dir: target.missionDir,
    mission: MISSION,
    actor: ACTOR,
    idempotencyKey: 'mission-index-create-0002',
  });
  assert.ok(mission.session.session_id);

  const directPath = join(target.root, 'direct-not-a-directory');
  await writeFile(directPath, 'not a directory', 'utf-8');
  const result = await buildChatSessionIndex({
    directDir: directPath,
    missionDir: target.missionDir,
    filters: { sessionType: 'mission', missionId: MISSION.mission_id, agentId: 'tokyo' },
  });

  assert.equal(result.sources.direct_sessions, 'unavailable');
  assert.equal(result.sources.mission_sessions, 'available');
  assert.equal(result.count, 1);
  assert.equal(result.sessions[0].mission_id, MISSION.mission_id);
  assert.equal(result.sessions[0].participant_ids.includes('tokyo'), true);
});
