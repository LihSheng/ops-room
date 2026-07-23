import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  appendAgentChatTurn,
  closeAgentChatSession,
  createOrLoadAgentChatSession,
  readAgentChatSession,
  reconcileInterruptedAgentChatTurns,
  serializeAgentChatSession,
} from '../src/services/agent-chat-store.js';

const ACTOR = {
  actor_type: 'human_operator',
  actor_id: 'operator-test',
  actor_display_name: 'Operator Test',
};

async function chatDir() {
  const root = await mkdtemp(join(tmpdir(), 'ops-room-agent-chat-'));
  const dir = join(root, 'sessions');
  await mkdir(dir, { recursive: true });
  return dir;
}

function sessionPath(dir: string, sessionId: string) {
  return join(dir, `session-${createHash('sha256').update(sessionId).digest('hex')}.json`);
}

async function createSession(dir: string, key = 'agent-chat-create-0001') {
  return createOrLoadAgentChatSession({
    dir,
    agentId: 'professor',
    actor: ACTOR,
    idempotencyKey: key,
    title: 'Professor discussion',
  });
}

test('session creation is deterministic and idempotent', async () => {
  const dir = await chatDir();
  const first = await createSession(dir);
  const second = await createSession(dir);

  assert.equal(first.created, true);
  assert.equal(second.created, false);
  assert.equal(second.idempotent, true);
  assert.equal(second.session.session_id, first.session.session_id);
  assert.equal(second.session.agent_id, 'professor');
  assert.deepEqual(second.session.turns, []);
});

test('one message key invokes the provider once and replays the durable response', async () => {
  const dir = await chatDir();
  const created = await createSession(dir);
  let calls = 0;
  const invokeProvider = async ({ agentId, transcript }: any) => {
    calls += 1;
    assert.equal(agentId, 'professor');
    assert.deepEqual(transcript, [{ role: 'user', content: 'Explain the next safe step.' }]);
    return { text: 'Review the durable evidence first.', provider: 'opencode', model: 'test-model' };
  };

  const first = await appendAgentChatTurn({
    dir,
    sessionId: created.session.session_id,
    actor: ACTOR,
    content: 'Explain the next safe step.',
    idempotencyKey: 'agent-chat-message-0001',
    invokeProvider,
  });
  const replay = await appendAgentChatTurn({
    dir,
    sessionId: created.session.session_id,
    actor: ACTOR,
    content: 'Explain the next safe step.',
    idempotencyKey: 'agent-chat-message-0001',
    invokeProvider,
  });

  assert.equal(first.turn.state, 'completed');
  assert.equal(first.turn.agent_message.content, 'Review the durable evidence first.');
  assert.equal(replay.idempotent, true);
  assert.equal(replay.provider_invoked, false);
  assert.equal(calls, 1);

  const publicSession = serializeAgentChatSession(replay.session);
  assert.equal(publicSession.turns[0].human_message.content, 'Explain the next safe step.');
  assert.equal('idempotency_key' in publicSession.turns[0], false);
  assert.equal('content_hash' in publicSession.turns[0], false);
});

test('reusing one message key for different content fails closed', async () => {
  const dir = await chatDir();
  const created = await createSession(dir);
  await appendAgentChatTurn({
    dir,
    sessionId: created.session.session_id,
    actor: ACTOR,
    content: 'First message',
    idempotencyKey: 'agent-chat-message-0002',
    invokeProvider: async () => ({ text: 'First reply', provider: 'opencode', model: 'test-model' }),
  });

  await assert.rejects(
    appendAgentChatTurn({
      dir,
      sessionId: created.session.session_id,
      actor: ACTOR,
      content: 'Different message',
      idempotencyKey: 'agent-chat-message-0002',
      invokeProvider: async () => ({ text: 'Must not run' }),
    }),
    /agent_chat_idempotency_conflict/,
  );
});

test('provider failures become needs-human evidence and are not replayed', async () => {
  const dir = await chatDir();
  const created = await createSession(dir);
  let calls = 0;
  const request = {
    dir,
    sessionId: created.session.session_id,
    actor: ACTOR,
    content: 'Summarize the current situation.',
    idempotencyKey: 'agent-chat-message-0003',
    invokeProvider: async () => {
      calls += 1;
      throw new Error('agent_chat_provider_timeout');
    },
  };

  const first = await appendAgentChatTurn(request);
  const replay = await appendAgentChatTurn(request);

  assert.equal(first.session.state, 'needs_human');
  assert.equal(first.turn.state, 'needs_human');
  assert.equal(first.turn.error_code, 'agent_chat_provider_timeout');
  assert.equal(replay.idempotent, true);
  assert.equal(replay.provider_invoked, false);
  assert.equal(calls, 1);
});

test('restart reconciliation converts pending provider turns without replay', async () => {
  const dir = await chatDir();
  const created = await createSession(dir);
  const path = sessionPath(dir, created.session.session_id);
  const record = JSON.parse(await readFile(path, 'utf-8'));
  const at = new Date().toISOString();
  record.turns.push({
    turn_id: 'turn:interrupted-test',
    idempotency_key: 'agent-chat-message-0004',
    content_hash: createHash('sha256').update('Interrupted message').digest('hex'),
    state: 'provider_pending',
    human_message: {
      role: 'human',
      content: 'Interrupted message',
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

  const recovery = await reconcileInterruptedAgentChatTurns({ dir });
  const stored = await readAgentChatSession({ dir, sessionId: created.session.session_id });

  assert.equal(recovery.recovered_turns, 1);
  assert.equal(stored.state, 'needs_human');
  assert.equal(stored.turns[0].state, 'needs_human');
  assert.equal(stored.turns[0].error_code, 'agent_chat_provider_interrupted');
});

test('closing a session is durable and idempotent', async () => {
  const dir = await chatDir();
  const created = await createSession(dir);
  const first = await closeAgentChatSession({
    dir,
    sessionId: created.session.session_id,
    actor: ACTOR,
    reason: 'Discussion complete',
    idempotencyKey: 'agent-chat-close-0001',
  });
  const replay = await closeAgentChatSession({
    dir,
    sessionId: created.session.session_id,
    actor: ACTOR,
    reason: 'Discussion complete',
    idempotencyKey: 'agent-chat-close-0001',
  });

  assert.equal(first.session.state, 'closed');
  assert.equal(replay.idempotent, true);
  await assert.rejects(
    appendAgentChatTurn({
      dir,
      sessionId: created.session.session_id,
      actor: ACTOR,
      content: 'One more message',
      idempotencyKey: 'agent-chat-message-0005',
      invokeProvider: async () => ({ text: 'Must not run' }),
    }),
    /agent_chat_session_not_open:closed/,
  );
});
