import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { handleCreateMission } from '../src/routes/operator-missions.js';

const actor = {
  actor_id: 'operator-lihsheng',
  actor_display_name: 'Lih Sheng',
  roles: ['operator'],
};

function body(overrides: Record<string, unknown> = {}) {
  return {
    title: 'Create governed missions',
    objective: 'Persist a mission without starting its workflow.',
    repository: 'LihSheng/ops-room',
    starting_branch: 'main',
    starting_sha: 'c'.repeat(40),
    workflow_type: 'feature-development',
    max_iterations: 3,
    approval_policy: 'berlin-review-required',
    priority: 'high',
    reason: 'Create the approved V2 mission record.',
    idempotency_key: 'mission-handler-0001',
    ...overrides,
  };
}

async function dirs(t: test.TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'ops-room-operator-mission-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return {
    missionsDir: join(root, 'missions'),
    auditDir: join(root, 'audit'),
    idempotencyDir: join(root, 'idempotency'),
  };
}

test('operator mission creation is durable, audited, and execution-free', async (t) => {
  const paths = await dirs(t);
  const result = await handleCreateMission({ body: body(), actor, ...paths });

  assert.equal(result.status, 201);
  assert.equal(result.body.operation, 'mission.create');
  assert.equal(result.body.idempotent_replay, false);
  assert.equal(result.body.mission.state, 'planned');
  assert.equal(result.body.mission.workflow_id, null);
  assert.equal(result.body.mission.starting_sha, 'c'.repeat(40));
  assert.equal(result.body.mission.history[0].event, 'mission_created');
  assert.ok(result.body.audit_event_id);

  assert.equal((await readdir(paths.missionsDir)).length, 1);
  assert.equal((await readdir(paths.auditDir)).length, 1);
  assert.equal((await readdir(paths.idempotencyDir)).length, 1);
});

test('identical mission creation requests replay without duplicate records or audits', async (t) => {
  const paths = await dirs(t);
  const first = await handleCreateMission({ body: body(), actor, ...paths });
  const replay = await handleCreateMission({ body: body(), actor, ...paths });

  assert.equal(first.status, 201);
  assert.equal(replay.status, 201);
  assert.equal(replay.body.idempotent_replay, true);
  assert.equal(replay.body.mission.mission_id, first.body.mission.mission_id);
  assert.equal((await readdir(paths.missionsDir)).length, 1);
  assert.equal((await readdir(paths.auditDir)).length, 1);
});

test('conflicting idempotency reuse is rejected and audited', async (t) => {
  const paths = await dirs(t);
  await handleCreateMission({ body: body(), actor, ...paths });
  const conflict = await handleCreateMission({
    body: body({ objective: 'A different mission objective.' }),
    actor,
    ...paths,
  });

  assert.equal(conflict.status, 409);
  assert.equal(conflict.body.error_code, 'IDEMPOTENCY_CONFLICT');
  assert.ok(conflict.body.audit_event_id);
  assert.equal((await readdir(paths.missionsDir)).length, 1);
  assert.equal((await readdir(paths.auditDir)).length, 2);
});

test('invalid mission creation requests fail closed with durable rejection evidence', async (t) => {
  const paths = await dirs(t);
  const invalid = await handleCreateMission({
    body: body({ starting_sha: 'not-a-sha' }),
    actor,
    ...paths,
  });

  assert.equal(invalid.status, 400);
  assert.equal(invalid.body.error_code, 'invalid_request');
  assert.match(invalid.body.error, /invalid_mission_starting_sha/);
  assert.ok(invalid.body.audit_event_id);
  await assert.rejects(readdir(paths.missionsDir), /ENOENT/);
  assert.equal((await readdir(paths.auditDir)).length, 1);
});
