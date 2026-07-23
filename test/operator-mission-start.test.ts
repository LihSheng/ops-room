import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { handleStartMission } from '../src/routes/operator-missions.js';
import { createMission } from '../src/services/mission-store.js';

const SHA_A = 'a'.repeat(40);
const actor = {
  actor_id: 'operator-lihsheng',
  actor_display_name: 'Lih Sheng',
  roles: ['operator'],
};

async function fixture(t: test.TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'ops-room-operator-mission-start-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const paths = {
    missionsDir: join(root, 'missions'),
    workflowRunsDir: join(root, 'workflow-runs'),
    auditDir: join(root, 'audit'),
    idempotencyDir: join(root, 'idempotency'),
  };
  const created = await createMission({
    dir: paths.missionsDir,
    input: {
      title: 'Start governed mission',
      objective: 'Bind the mission to its deterministic workflow.',
      repository: 'LihSheng/ops-room',
      starting_branch: 'main',
      starting_sha: SHA_A,
      workflow_type: 'feature-development',
      max_iterations: 3,
      approval_policy: 'berlin-review-required',
      priority: 'high',
    },
    actor,
    requestKey: 'mission-start-route-create',
  });
  return { paths, mission: created.mission };
}

function startBody(overrides: Record<string, unknown> = {}) {
  return {
    reason: 'Start the approved mission workflow.',
    idempotency_key: 'mission-start-handler-0001',
    ...overrides,
  };
}

test('mission start binds one workflow and records bounded audit evidence', async (t) => {
  const setup = await fixture(t);
  const result = await handleStartMission({
    missionId: setup.mission.mission_id,
    body: startBody(),
    actor,
    ...setup.paths,
  });

  assert.equal(result.status, 200);
  assert.equal(result.body.operation, 'mission.start');
  assert.equal(result.body.idempotent_replay, false);
  assert.equal(result.body.started, true);
  assert.equal(result.body.provider_invoked, false);
  assert.equal(result.body.mission.state, 'active');
  assert.equal(result.body.mission.workflow_id, result.body.workflow.workflow_id);
  assert.equal(result.body.workflow.state, 'active');
  assert.equal(result.body.initial_child.stage, 'implementation');
  assert.equal(result.body.initial_child.owner_agent, 'professor');
  assert.equal(result.body.initial_child.state, 'pending');
  assert.ok(result.body.audit_event_id);

  assert.equal((await readdir(setup.paths.workflowRunsDir)).filter((name) => name.endsWith('.json')).length, 1);
  assert.equal((await readdir(setup.paths.auditDir)).length, 1);
  assert.equal((await readdir(setup.paths.idempotencyDir)).length, 1);
});

test('identical start requests replay without duplicate workflows or audits', async (t) => {
  const setup = await fixture(t);
  const first = await handleStartMission({
    missionId: setup.mission.mission_id,
    body: startBody(),
    actor,
    ...setup.paths,
  });
  const replay = await handleStartMission({
    missionId: setup.mission.mission_id,
    body: startBody(),
    actor,
    ...setup.paths,
  });

  assert.equal(first.status, 200);
  assert.equal(replay.status, 200);
  assert.equal(replay.body.idempotent_replay, true);
  assert.equal(replay.body.workflow.workflow_id, first.body.workflow.workflow_id);
  assert.equal(replay.body.initial_child.child_id, first.body.initial_child.child_id);
  assert.equal((await readdir(setup.paths.workflowRunsDir)).filter((name) => name.endsWith('.json')).length, 1);
  assert.equal((await readdir(setup.paths.auditDir)).length, 1);
});

test('conflicting idempotency reuse is rejected and audited', async (t) => {
  const setup = await fixture(t);
  await handleStartMission({
    missionId: setup.mission.mission_id,
    body: startBody(),
    actor,
    ...setup.paths,
  });
  const conflict = await handleStartMission({
    missionId: setup.mission.mission_id,
    body: startBody({ reason: 'Use the same key for a different request.' }),
    actor,
    ...setup.paths,
  });

  assert.equal(conflict.status, 409);
  assert.equal(conflict.body.error_code, 'IDEMPOTENCY_CONFLICT');
  assert.ok(conflict.body.audit_event_id);
  assert.equal((await readdir(setup.paths.auditDir)).length, 2);
});

test('missing missions fail closed with durable rejection evidence', async (t) => {
  const setup = await fixture(t);
  const missing = await handleStartMission({
    missionId: 'mission:missing:000000000000000000000000',
    body: startBody({ idempotency_key: 'mission-start-handler-missing' }),
    actor,
    ...setup.paths,
  });

  assert.equal(missing.status, 404);
  assert.equal(missing.body.error_code, 'mission_not_found');
  assert.ok(missing.body.audit_event_id);
});
