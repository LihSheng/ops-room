import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  handleAppendAgentChatMessage,
  handleCloseAgentChatSession,
  handleCreateAgentChatSession,
} from '../src/services/operator-agent-chat.js';

const ACTOR = {
  actor_type: 'human_operator',
  actor_id: 'operator-test',
  actor_display_name: 'Operator Test',
  auth_method: 'operator_session',
  session_id: 'session-test',
};

const PROFILE = {
  id: 'professor',
  enabled: true,
  runtime: { backend: 'opencode' },
};

async function dirs() {
  const root = await mkdtemp(join(tmpdir(), 'ops-room-operator-chat-'));
  const chat = join(root, 'chat');
  const audit = join(root, 'audit');
  await Promise.all([mkdir(chat, { recursive: true }), mkdir(audit, { recursive: true })]);
  return { root, chat, audit };
}

async function auditRecords(dir: string) {
  const names = (await readdir(dir)).filter((name) => name.startsWith('event-'));
  return Promise.all(names.map(async (name) => JSON.parse(await readFile(join(dir, name), 'utf-8'))));
}

test('session creation validates profile authority and records an audit event', async () => {
  const target = await dirs();
  const result = await handleCreateAgentChatSession({
    agentId: 'professor',
    body: {
      title: 'Professor clarification',
      reason: 'Clarify the implementation boundary',
      idempotency_key: 'agent-chat-create-handler-0001',
    },
    actor: ACTOR,
    chatDir: target.chat,
    auditDir: target.audit,
    profileLookup: () => PROFILE,
  });

  assert.equal(result.status, 201);
  assert.equal(result.body.session.agent_id, 'professor');
  assert.equal(result.body.session.state, 'open');
  assert.equal(result.body.provider_invoked, false);
  assert.ok(result.body.audit_event_id);

  const audits = await auditRecords(target.audit);
  assert.equal(audits.length, 1);
  assert.equal(audits[0].operation, 'agent.chat.session.create');
  assert.equal(audits[0].actor.actor_id, 'operator-test');
  assert.equal(audits[0].metadata.agent_id, 'professor');
});

test('message submission invokes one bounded provider turn and audits only digest metadata', async () => {
  const target = await dirs();
  const created = await handleCreateAgentChatSession({
    agentId: 'professor',
    body: {
      reason: 'Start a direct discussion',
      idempotency_key: 'agent-chat-create-handler-0002',
    },
    actor: ACTOR,
    chatDir: target.chat,
    auditDir: target.audit,
    profileLookup: () => PROFILE,
  });
  let calls = 0;
  const request = {
    sessionId: created.body.session.session_id,
    body: {
      content: 'What should remain outside this chat?',
      idempotency_key: 'agent-chat-message-handler-0001',
    },
    actor: ACTOR,
    chatDir: target.chat,
    auditDir: target.audit,
    invokeProvider: async () => {
      calls += 1;
      return { text: 'Operational mutations remain outside chat.', provider: 'opencode', model: 'test-model' };
    },
  };

  const first = await handleAppendAgentChatMessage(request);
  const replay = await handleAppendAgentChatMessage(request);

  assert.equal(first.status, 202);
  assert.equal(first.body.turn.state, 'completed');
  assert.equal(first.body.turn.agent_message.content, 'Operational mutations remain outside chat.');
  assert.equal(replay.body.domain_idempotent, true);
  assert.equal(replay.body.provider_invoked, false);
  assert.equal(calls, 1);

  const audits = await auditRecords(target.audit);
  const sends = audits.filter((event) => event.operation === 'agent.chat.message.send');
  assert.equal(sends.length, 2);
  assert.match(sends[0].metadata.message_digest, /^[a-f0-9]{64}$/);
  assert.equal(sends[0].metadata.message_length, 37);
  assert.doesNotMatch(JSON.stringify(sends), /What should remain outside this chat/);
  assert.doesNotMatch(JSON.stringify(sends), /Operational mutations remain outside chat/);
});

test('provider failure is an accepted needs-human turn rather than an automatic retry', async () => {
  const target = await dirs();
  const created = await handleCreateAgentChatSession({
    agentId: 'professor',
    body: {
      reason: 'Start a direct discussion',
      idempotency_key: 'agent-chat-create-handler-0003',
    },
    actor: ACTOR,
    chatDir: target.chat,
    auditDir: target.audit,
    profileLookup: () => PROFILE,
  });
  let calls = 0;
  const result = await handleAppendAgentChatMessage({
    sessionId: created.body.session.session_id,
    body: {
      content: 'Give me a bounded summary.',
      idempotency_key: 'agent-chat-message-handler-0002',
    },
    actor: ACTOR,
    chatDir: target.chat,
    auditDir: target.audit,
    invokeProvider: async () => {
      calls += 1;
      throw new Error('agent_chat_provider_timeout');
    },
  });

  assert.equal(result.status, 202);
  assert.equal(result.body.turn.state, 'needs_human');
  assert.equal(result.body.session.state, 'needs_human');
  assert.equal(result.body.turn.error_code, 'agent_chat_provider_timeout');
  assert.equal(calls, 1);
});

test('closing a session is authorized through a separate deliberate operation', async () => {
  const target = await dirs();
  const created = await handleCreateAgentChatSession({
    agentId: 'professor',
    body: {
      reason: 'Start a direct discussion',
      idempotency_key: 'agent-chat-create-handler-0004',
    },
    actor: ACTOR,
    chatDir: target.chat,
    auditDir: target.audit,
    profileLookup: () => PROFILE,
  });
  const result = await handleCloseAgentChatSession({
    sessionId: created.body.session.session_id,
    body: {
      reason: 'The clarification is complete',
      idempotency_key: 'agent-chat-close-handler-0001',
    },
    actor: ACTOR,
    chatDir: target.chat,
    auditDir: target.audit,
  });

  assert.equal(result.status, 200);
  assert.equal(result.body.session.state, 'closed');
  assert.equal(result.body.provider_invoked, false);
});

test('invalid agent and malformed message requests are rejected with audit evidence', async () => {
  const target = await dirs();
  const missing = await handleCreateAgentChatSession({
    agentId: 'unknown',
    body: {
      reason: 'Attempt chat',
      idempotency_key: 'agent-chat-create-handler-0005',
    },
    actor: ACTOR,
    chatDir: target.chat,
    auditDir: target.audit,
    profileLookup: () => null,
  });
  assert.equal(missing.status, 404);
  assert.equal(missing.body.error_code, 'agent_chat_profile_missing');
  assert.ok(missing.body.audit_event_id);

  const malformed = await handleAppendAgentChatMessage({
    sessionId: 'missing-session',
    body: {
      content: '',
      idempotency_key: 'agent-chat-message-handler-0003',
    },
    actor: ACTOR,
    chatDir: target.chat,
    auditDir: target.audit,
  });
  assert.equal(malformed.status, 400);
  assert.equal(malformed.body.error_code, 'agent_chat_message_required');
  assert.ok(malformed.body.audit_event_id);
});
