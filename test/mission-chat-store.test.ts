import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  appendMissionChatTurn,
  closeMissionChatSession,
  createOrLoadMissionChatSession,
  missionChatSessionIdFor,
  readMissionChatSession,
  reconcileInterruptedMissionChatTurns,
  serializeMissionChatSession,
} from '../src/services/mission-chat-store.js';

const ACTOR = {
  actor_type: 'human_operator',
  actor_id: 'operator-test',
  actor_display_name: 'Operator Test',
};

const MISSION = {
  mission_id: 'mission:test:1234',
  title: 'Participant chat test',
  objective: 'Prove bounded Mission participant chat.',
  state: 'active',
  participants: [
    { agent_id: 'professor', roles: ['implementation', 'integration'] },
    { agent_id: 'tokyo', roles: ['test'] },
    { agent_id: 'berlin', roles: ['review'] },
  ],
};

async function chatDir() {
  const root = await mkdtemp(join(tmpdir(), 'ops-room-mission-chat-'));
  const dir = join(root, 'sessions');
  await mkdir(dir, { recursive: true });
  return dir;
}

function sessionPath(dir: string, sessionId: string) {
  return join(dir, `session-${createHash('sha256').update(sessionId).digest('hex')}.json`);
}

async function createSession(dir: string, mission = MISSION, key = 'mission-chat-create-0001') {
  return createOrLoadMissionChatSession({
    dir,
    mission,
    actor: ACTOR,
    idempotencyKey: key,
  });
}

test('one deterministic session is owned by each Mission', async () => {
  const dir = await chatDir();
  const first = await createSession(dir);
  const second = await createOrLoadMissionChatSession({
    dir,
    mission: MISSION,
    actor: { ...ACTOR, actor_id: 'another-operator' },
    idempotencyKey: 'mission-chat-create-0002',
  });

  assert.equal(first.created, true);
  assert.equal(second.created, false);
  assert.equal(second.idempotent, true);
  assert.equal(first.session.session_id, missionChatSessionIdFor(MISSION.mission_id));
  assert.equal(second.session.session_id, first.session.session_id);
  assert.deepEqual(second.session.participants, MISSION.participants);
});

test('a targeted participant turn invokes the provider once and preserves attribution', async () => {
  const dir = await chatDir();
  const created = await createSession(dir);
  let calls = 0;
  const invokeProvider = async ({ mission, participant, transcript }: any) => {
    calls += 1;
    assert.equal(mission.mission_id, MISSION.mission_id);
    assert.deepEqual(participant, { agent_id: 'tokyo', roles: ['test'] });
    assert.deepEqual(transcript, [{
      role: 'user',
      content: '[Human Operator Test] To tokyo: Which verification should be performed?',
    }]);
    return { text: 'Verify the bounded acceptance criteria.', provider: 'opencode', model: 'test-model' };
  };
  const request = {
    dir,
    mission: MISSION,
    sessionId: created.session.session_id,
    targetAgentId: 'tokyo',
    actor: ACTOR,
    content: 'Which verification should be performed?',
    idempotencyKey: 'mission-chat-message-0001',
    invokeProvider,
  };

  const first = await appendMissionChatTurn(request);
  const replay = await appendMissionChatTurn(request);

  assert.equal(first.turn.state, 'completed');
  assert.equal(first.turn.target_agent_id, 'tokyo');
  assert.deepEqual(first.turn.target_roles, ['test']);
  assert.equal(first.turn.agent_message.agent_id, 'tokyo');
  assert.equal(replay.idempotent, true);
  assert.equal(replay.provider_invoked, false);
  assert.equal(calls, 1);

  const publicSession = serializeMissionChatSession(replay.session);
  assert.equal(publicSession.turns[0].human_message.content, 'Which verification should be performed?');
  assert.equal(publicSession.turns[0].agent_message?.content, 'Verify the bounded acceptance criteria.');
  assert.equal('idempotency_key' in publicSession.turns[0], false);
  assert.equal('content_hash' in publicSession.turns[0], false);
});

test('one message identity cannot silently change participant or content', async () => {
  const dir = await chatDir();
  const created = await createSession(dir);
  await appendMissionChatTurn({
    dir,
    mission: MISSION,
    sessionId: created.session.session_id,
    targetAgentId: 'professor',
    actor: ACTOR,
    content: 'Explain the implementation boundary.',
    idempotencyKey: 'mission-chat-message-0002',
    invokeProvider: async () => ({ text: 'Keep chat non-operational.' }),
  });

  await assert.rejects(
    appendMissionChatTurn({
      dir,
      mission: MISSION,
      sessionId: created.session.session_id,
      targetAgentId: 'berlin',
      actor: ACTOR,
      content: 'Explain the implementation boundary.',
      idempotencyKey: 'mission-chat-message-0002',
      invokeProvider: async () => ({ text: 'Must not run' }),
    }),
    /mission_chat_idempotency_conflict/,
  );
});

test('agents outside the Mission participant declaration fail closed', async () => {
  const dir = await chatDir();
  const created = await createSession(dir);
  await assert.rejects(
    appendMissionChatTurn({
      dir,
      mission: MISSION,
      sessionId: created.session.session_id,
      targetAgentId: 'osaka',
      actor: ACTOR,
      content: 'This must not be accepted.',
      idempotencyKey: 'mission-chat-message-0003',
      invokeProvider: async () => ({ text: 'Must not run' }),
    }),
    /mission_chat_target_not_participant/,
  );
});

test('terminal Missions remain readable but reject creation and new turns', async () => {
  const dir = await chatDir();
  const created = await createSession(dir);
  const terminal = { ...MISSION, state: 'completed' };

  await assert.rejects(
    createSession(dir, terminal, 'mission-chat-create-0003'),
    /mission_chat_mission_terminal:completed/,
  );
  await assert.rejects(
    appendMissionChatTurn({
      dir,
      mission: terminal,
      sessionId: created.session.session_id,
      targetAgentId: 'berlin',
      actor: ACTOR,
      content: 'Can this mutate the completed Mission?',
      idempotencyKey: 'mission-chat-message-0004',
      invokeProvider: async () => ({ text: 'Must not run' }),
    }),
    /mission_chat_mission_terminal:completed/,
  );
  const stored = await readMissionChatSession({ dir, sessionId: created.session.session_id });
  assert.equal(stored.mission_id, MISSION.mission_id);
  assert.equal(stored.state, 'open');
});

test('provider failure becomes durable needs-human evidence without replay', async () => {
  const dir = await chatDir();
  const created = await createSession(dir);
  let calls = 0;
  const request = {
    dir,
    mission: MISSION,
    sessionId: created.session.session_id,
    targetAgentId: 'berlin',
    actor: ACTOR,
    content: 'Review the bounded discussion.',
    idempotencyKey: 'mission-chat-message-0005',
    invokeProvider: async () => {
      calls += 1;
      throw new Error('mission_chat_provider_timeout');
    },
  };

  const first = await appendMissionChatTurn(request);
  const replay = await appendMissionChatTurn(request);

  assert.equal(first.session.state, 'needs_human');
  assert.equal(first.turn.state, 'needs_human');
  assert.equal(first.turn.error_code, 'mission_chat_provider_timeout');
  assert.equal(replay.idempotent, true);
  assert.equal(replay.provider_invoked, false);
  assert.equal(calls, 1);
});

test('restart reconciliation converts pending Mission turns without replay', async () => {
  const dir = await chatDir();
  const created = await createSession(dir);
  const path = sessionPath(dir, created.session.session_id);
  const record = JSON.parse(await readFile(path, 'utf-8'));
  const at = new Date().toISOString();
  record.turns.push({
    turn_id: 'mission-turn:interrupted-test',
    idempotency_key: 'mission-chat-message-0006',
    content_hash: createHash('sha256').update('tokyo\nInterrupted Mission message').digest('hex'),
    target_agent_id: 'tokyo',
    target_roles: ['test'],
    state: 'provider_pending',
    human_message: {
      role: 'human',
      content: 'Interrupted Mission message',
      actor: ACTOR,
      created_at: at,
    },
    agent_message: null,
    error_code: null,
    created_at: at,
    updated_at: at,
  });
  record.updated_at = at;
  await writeFile(path, `${JSON.stringify(record, null, 2)}\n`, 'utf-8');

  const recovery = await reconcileInterruptedMissionChatTurns({ dir });
  const stored = await readMissionChatSession({ dir, sessionId: created.session.session_id });

  assert.equal(recovery.recovered_turns, 1);
  assert.equal(stored.state, 'needs_human');
  assert.equal(stored.turns[0].state, 'needs_human');
  assert.equal(stored.turns[0].error_code, 'mission_chat_provider_interrupted');
});

test('closing the Mission chat is durable and idempotent', async () => {
  const dir = await chatDir();
  const created = await createSession(dir);
  const first = await closeMissionChatSession({
    dir,
    mission: MISSION,
    sessionId: created.session.session_id,
    actor: ACTOR,
    reason: 'Discussion complete',
    idempotencyKey: 'mission-chat-close-0001',
  });
  const replay = await closeMissionChatSession({
    dir,
    mission: MISSION,
    sessionId: created.session.session_id,
    actor: ACTOR,
    reason: 'Discussion complete',
    idempotencyKey: 'mission-chat-close-0001',
  });

  assert.equal(first.session.state, 'closed');
  assert.equal(replay.idempotent, true);
});
