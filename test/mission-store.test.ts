import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  BERLIN_REVIEW_APPROVAL_POLICY,
  buildMissionId,
  createMission,
  listMissions,
  normalizeMissionInput,
  readMission,
  serializeMission,
} from '../src/services/mission-store.js';

const SHA = 'a'.repeat(40);

function input(overrides: Record<string, unknown> = {}) {
  return {
    title: 'Add mission creation',
    objective: 'Introduce a durable, governed mission authority.',
    repository: 'LihSheng/ops-room',
    starting_branch: 'main',
    starting_sha: SHA,
    workflow_type: 'feature-development',
    max_iterations: 3,
    approval_policy: BERLIN_REVIEW_APPROVAL_POLICY,
    github_issue: 68,
    reference_documents: ['https://github.com/LihSheng/ops-room/issues/68', 'Ops Room V2 specification'],
    required_capabilities: ['repository-write', 'test-development'],
    priority: 'high',
    deadline: '2026-08-01T00:00:00Z',
    supporting_context: 'Creation must not start execution.',
    ...overrides,
  };
}

const actor = {
  actor_id: 'operator-lihsheng',
  actor_display_name: 'Lih Sheng',
};

test('mission input is normalized into the fixed feature-development policy', () => {
  const normalized = normalizeMissionInput(input());
  assert.equal(normalized.repository_id, 'LihSheng/ops-room');
  assert.equal(normalized.starting_sha, SHA);
  assert.deepEqual(normalized.policy, {
    max_iterations: 3,
    approval_policy: BERLIN_REVIEW_APPROVAL_POLICY,
  });
  assert.deepEqual(normalized.required_capabilities, ['repository-write', 'test-development']);
  assert.equal(normalized.deadline, '2026-08-01T00:00:00.000Z');
});

test('mission IDs are deterministic for one repository, title, and request key', () => {
  const first = buildMissionId({
    repository: 'LihSheng/ops-room',
    title: 'Add mission creation',
    requestKey: 'mission-create-0001',
  });
  const second = buildMissionId({
    repository: 'LihSheng/ops-room',
    title: 'Add mission creation',
    requestKey: 'mission-create-0001',
  });
  assert.equal(first, second);
  assert.match(first, /^mission:add-mission-creation:[0-9a-f]{24}$/);
});

test('mission creation is durable, idempotent, and does not start a workflow', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'ops-room-missions-'));
  t.after(() => rm(dir, { recursive: true, force: true }));

  const created = await createMission({
    dir,
    input: input(),
    actor,
    requestKey: 'mission-create-0001',
    now: () => '2026-07-22T14:00:00.000Z',
  });
  assert.equal(created.created, true);
  assert.equal(created.mission.state, 'planned');
  assert.equal(created.mission.workflow_id, null);
  assert.deepEqual(created.mission.stage_owners, {
    implementation: 'professor',
    test: 'tokyo',
    integration: 'professor',
    review: 'berlin',
  });

  const replay = await createMission({
    dir,
    input: input(),
    actor,
    requestKey: 'mission-create-0001',
    now: () => '2026-07-22T14:00:00.000Z',
  });
  assert.equal(replay.created, false);
  assert.equal(replay.mission.mission_id, created.mission.mission_id);

  const read = await readMission({ dir, missionId: created.mission.mission_id });
  assert.equal(read.title, 'Add mission creation');
  assert.equal(read.history[0].event, 'mission_created');

  const files = await readdir(dir);
  assert.equal(files.length, 1);
  if (process.platform !== 'win32') {
    const mode = (await stat(join(dir, files[0]))).mode & 0o777;
    assert.equal(mode, 0o600);
  }

  const serialized = serializeMission(read);
  assert.equal(Object.hasOwn(serialized, 'creation_request_hash'), false);
});

test('mission creation rejects conflicting reuse of the same durable ID', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'ops-room-mission-conflict-'));
  t.after(() => rm(dir, { recursive: true, force: true }));

  await createMission({
    dir,
    input: input(),
    actor,
    requestKey: 'mission-create-0002',
    now: () => '2026-07-22T14:00:00.000Z',
  });

  await assert.rejects(
    createMission({
      dir,
      input: input({ objective: 'A different objective under the same request key.' }),
      actor,
      requestKey: 'mission-create-0002',
      now: () => '2026-07-22T14:00:00.000Z',
    }),
    /mission_record_conflict/,
  );
});

test('invalid mission authority and unsafe metadata fail closed', () => {
  assert.throws(() => normalizeMissionInput(input({ repository: '../unsafe' })), /invalid_mission_repository_id/);
  assert.throws(() => normalizeMissionInput(input({ starting_branch: '../main' })), /invalid_mission_starting_branch/);
  assert.throws(() => normalizeMissionInput(input({ starting_sha: 'abc123' })), /invalid_mission_starting_sha/);
  assert.throws(() => normalizeMissionInput(input({ workflow_type: 'arbitrary-graph' })), /unsupported_mission_workflow_type/);
  assert.throws(() => normalizeMissionInput(input({ max_iterations: 21 })), /invalid_mission_max_iterations/);
  assert.throws(() => normalizeMissionInput(input({ approval_policy: 'automatic' })), /unsupported_mission_approval_policy/);
  assert.throws(() => normalizeMissionInput(input({ deadline: 'not-a-date' })), /invalid_mission_deadline/);
  assert.throws(() => normalizeMissionInput(input({ reference_documents: ['/etc/passwd'] })), /invalid_mission_reference_document/);
  assert.throws(() => normalizeMissionInput(input({ required_capabilities: ['shell execute'] })), /invalid_mission_required_capability/);
});

test('mission listing degrades corrupt records to bounded unavailable evidence', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'ops-room-mission-list-'));
  t.after(() => rm(dir, { recursive: true, force: true }));

  await createMission({
    dir,
    input: input(),
    actor,
    requestKey: 'mission-create-0003',
    now: () => '2026-07-22T14:00:00.000Z',
  });
  await writeFile(join(dir, 'mission-corrupt.json'), '{not-json', 'utf8');

  const missions = await listMissions({ dir });
  assert.equal(missions.length, 2);
  assert.equal(missions.some((mission) => mission.unavailable === true), true);
  assert.equal(missions.some((mission) => mission.title === 'Add mission creation'), true);
});
