import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createMission } from '../src/services/mission-store.js';
import {
  handleAppendMissionChatMessage,
  handleCloseMissionChatSession,
  handleCreateMissionChatSession,
} from '../src/services/operator-mission-chat.js';

const ACTOR = {
  actor_type: 'human_operator',
  actor_id: 'operator-test',
  actor_display_name: 'Operator Test',
  auth_method: 'operator_session',
  session_id: 'session-test',
};

const PROFILE = {
  id: 'tokyo',
  enabled: true,
  runtime: { backend: 'opencode' },
};

async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'ops-room-operator-mission-chat-'));
  const missions = join(root, 'missions');
  const chat = join(root, 'chat');
  const audit = join(root, 'audit');
  await Promise.all([mkdir(missions, { recursive: true }), mkdir(chat, { recursive: true }), mkdir(audit, { recursive: true })]);
  const created = await createMission({
    dir: missions,
    requestKey: 'mission-chat-test-mission-0001',
    actor: ACTOR,
    input: {
      title: 'Mission chat handler test',
      objective: 'Validate audited Mission participant chat.',
      repository: 'LihSheng/ops-room',
      starting_branch: 'main',
      starting_sha: 'a'.repeat(40),
      workflow_type: 'feature-development',
      max_iterations: 3,
      approval_policy: 'berlin-review-required',
      reference_documents: [],
      required_capabilities: [],
      priority: 'normal',
    },
  });
  return { root, missions, chat, audit, mission: created.mission };
}

async function auditRecords(dir: string) {
  const names = (await readdir(dir)).filter((name) => name.startsWith('event-'));
  return Promise.all(names.map(async (name) => JSON.parse(await readFile(join(dir, name), 'utf-8'))));
}

async function completeStoredMission(dir: string) {
  const name = (await readdir(dir)).find((candidate) => candidate.startsWith('mission-') && candidate.endsWith('.json'));
  assert.ok(name);
  const path = join(dir, name);
  const mission = JSON.parse(await readFile(path, 'utf-8'));
  const at = new Date().toISOString();
  mission.state = 'completed';
  mission.completed_at = at;
  mission.updated_at = at;
  await writeFile(path, `${JSON.stringify(mission, null, 2)}\n`, 'utf-8');
}

test('Mission chat creation records participant-bound audit evidence', async () => {
  const target = await setup();
  const result = await handleCreateMissionChatSession({
    missionId: target.mission.mission_id,
    body: {
      reason: 'Coordinate declared Mission participants',
      idempotency_key: 'mission-chat-create-handler-0001',
    },
    actor: ACTOR,
    missionsDir: target.missions,
    chatDir: target.chat,
    auditDir: target.audit,
  });

  assert.equal(result.status, 201);
  assert.equal(result.body.session.mission_id, target.mission.mission_id);
  assert.deepEqual(result.body.session.participants.map((participant: any) => participant.agent_id), ['professor', 'tokyo', 'berlin']);
  assert.equal(result.body.provider_invoked, false);
  assert.ok(result.body.audit_event_id);

  const audits = await auditRecords(target.audit);
  assert.equal(audits.length, 1);
  assert.equal(audits[0].operation, 'mission.chat.session.create');
  assert.equal(audits[0].metadata.mission_id, target.mission.mission_id);
  assert.deepEqual(audits[0].metadata.participant_ids, ['professor', 'tokyo', 'berlin']);
});

test('targeted send invokes one participant provider turn and audits digest metadata only', async () => {
  const target = await setup();
  const created = await handleCreateMissionChatSession({
    missionId: target.mission.mission_id,
    body: { reason: 'Start participant discussion', idempotency_key: 'mission-chat-create-handler-0002' },
    actor: ACTOR,
    missionsDir: target.missions,
    chatDir: target.chat,
    auditDir: target.audit,
  });
  const content = 'Which test evidence should be collected?';
  let calls = 0;
  const request = {
    sessionId: created.body.session.session_id,
    body: {
      target_agent_id: 'tokyo',
      content,
      idempotency_key: 'mission-chat-message-handler-0001',
    },
    actor: ACTOR,
    missionsDir: target.missions,
    chatDir: target.chat,
    auditDir: target.audit,
    profileLookup: () => PROFILE,
    invokeProvider: async ({ participant }: any) => {
      calls += 1;
      assert.equal(participant.agent_id, 'tokyo');
      return { text: 'Collect bounded acceptance evidence.', provider: 'opencode', model: 'test-model' };
    },
  };

  const first = await handleAppendMissionChatMessage(request);
  const replay = await handleAppendMissionChatMessage(request);

  assert.equal(first.status, 202);
  assert.equal(first.body.turn.target_agent_id, 'tokyo');
  assert.equal(first.body.turn.agent_message.agent_id, 'tokyo');
  assert.equal(replay.body.domain_idempotent, true);
  assert.equal(replay.body.provider_invoked, false);
  assert.equal(calls, 1);

  const audits = await auditRecords(target.audit);
  const sends = audits.filter((event) => event.operation === 'mission.chat.message.send');
  assert.equal(sends.length, 2);
  assert.equal(sends[0].metadata.target_agent_id, 'tokyo');
  assert.equal(sends[0].metadata.message_length, content.length);
  assert.match(sends[0].metadata.message_digest, /^[a-f0-9]{64}$/);
  assert.doesNotMatch(JSON.stringify(sends), /Which test evidence should be collected/);
  assert.doesNotMatch(JSON.stringify(sends), /Collect bounded acceptance evidence/);
});

test('accepted creation and message replay survive later terminal Mission and disabled participant state', async () => {
  const target = await setup();
  const createRequest = {
    missionId: target.mission.mission_id,
    body: { reason: 'Start participant discussion', idempotency_key: 'mission-chat-create-handler-0005' },
    actor: ACTOR,
    missionsDir: target.missions,
    chatDir: target.chat,
    auditDir: target.audit,
  };
  const created = await handleCreateMissionChatSession(createRequest);
  let calls = 0;
  const baseRequest = {
    sessionId: created.body.session.session_id,
    body: {
      target_agent_id: 'tokyo',
      content: 'Return durable evidence for safe replay.',
      idempotency_key: 'mission-chat-message-handler-0004',
    },
    actor: ACTOR,
    missionsDir: target.missions,
    chatDir: target.chat,
    auditDir: target.audit,
    invokeProvider: async () => {
      calls += 1;
      return { text: 'Durable response.', provider: 'opencode', model: 'test-model' };
    },
  };

  const first = await handleAppendMissionChatMessage({ ...baseRequest, profileLookup: () => PROFILE });
  await completeStoredMission(target.missions);
  const createReplay = await handleCreateMissionChatSession(createRequest);
  const messageReplay = await handleAppendMissionChatMessage({
    ...baseRequest,
    profileLookup: () => ({ ...PROFILE, enabled: false }),
    invokeProvider: async () => { calls += 1; return { text: 'Must not run' }; },
  });

  assert.equal(first.status, 202);
  assert.equal(createReplay.status, 200);
  assert.equal(createReplay.body.domain_idempotent, true);
  assert.equal(createReplay.body.session.session_id, created.body.session.session_id);
  assert.equal(messageReplay.status, 202);
  assert.equal(messageReplay.body.domain_idempotent, true);
  assert.equal(messageReplay.body.provider_invoked, false);
  assert.equal(messageReplay.body.turn.agent_message.content, 'Durable response.');
  assert.equal(calls, 1);
});

test('non-participant and disabled participant sends are rejected before provider invocation', async () => {
  const target = await setup();
  const created = await handleCreateMissionChatSession({
    missionId: target.mission.mission_id,
    body: { reason: 'Start participant discussion', idempotency_key: 'mission-chat-create-handler-0003' },
    actor: ACTOR,
    missionsDir: target.missions,
    chatDir: target.chat,
    auditDir: target.audit,
  });
  let calls = 0;

  const outside = await handleAppendMissionChatMessage({
    sessionId: created.body.session.session_id,
    body: {
      target_agent_id: 'osaka',
      content: 'This agent is not declared.',
      idempotency_key: 'mission-chat-message-handler-0002',
    },
    actor: ACTOR,
    missionsDir: target.missions,
    chatDir: target.chat,
    auditDir: target.audit,
    profileLookup: () => PROFILE,
    invokeProvider: async () => { calls += 1; return { text: 'Must not run' }; },
  });
  assert.equal(outside.status, 409);
  assert.equal(outside.body.error_code, 'mission_chat_target_not_participant');

  const disabled = await handleAppendMissionChatMessage({
    sessionId: created.body.session.session_id,
    body: {
      target_agent_id: 'tokyo',
      content: 'Disabled participant must not run.',
      idempotency_key: 'mission-chat-message-handler-0003',
    },
    actor: ACTOR,
    missionsDir: target.missions,
    chatDir: target.chat,
    auditDir: target.audit,
    profileLookup: () => ({ ...PROFILE, enabled: false }),
    invokeProvider: async () => { calls += 1; return { text: 'Must not run' }; },
  });
  assert.equal(disabled.status, 409);
  assert.equal(disabled.body.error_code, 'mission_chat_profile_disabled');
  assert.equal(calls, 0);
});

test('Mission chat close is a separate deliberate audited operation', async () => {
  const target = await setup();
  const created = await handleCreateMissionChatSession({
    missionId: target.mission.mission_id,
    body: { reason: 'Start participant discussion', idempotency_key: 'mission-chat-create-handler-0004' },
    actor: ACTOR,
    missionsDir: target.missions,
    chatDir: target.chat,
    auditDir: target.audit,
  });
  const result = await handleCloseMissionChatSession({
    sessionId: created.body.session.session_id,
    body: { reason: 'Discussion complete', idempotency_key: 'mission-chat-close-handler-0001' },
    actor: ACTOR,
    missionsDir: target.missions,
    chatDir: target.chat,
    auditDir: target.audit,
  });

  assert.equal(result.status, 200);
  assert.equal(result.body.session.state, 'closed');
  assert.equal(result.body.provider_invoked, false);
  const audits = await auditRecords(target.audit);
  assert.equal(audits.some((event) => event.operation === 'mission.chat.session.close'), true);
});
