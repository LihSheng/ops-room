import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { handleMissionDetail, handleMissionsList } from '../src/routes/missions.js';
import { createMission } from '../src/services/mission-store.js';

const SHA = 'b'.repeat(40);
const actor = { actor_id: 'operator-1', actor_display_name: 'Operator One' };

async function seed(dir: string, title: string, priority: string, requestKey: string, createdAt: string) {
  return createMission({
    dir,
    actor,
    requestKey,
    now: () => createdAt,
    input: {
      title,
      objective: `${title} objective`,
      repository: 'LihSheng/ops-room',
      starting_branch: 'main',
      starting_sha: SHA,
      workflow_type: 'feature-development',
      max_iterations: 3,
      approval_policy: 'berlin-review-required',
      priority,
    },
  });
}

test('mission list is bounded, filterable, and omits history', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'ops-room-mission-route-'));
  t.after(() => rm(dir, { recursive: true, force: true }));

  await seed(dir, 'Normal mission', 'normal', 'mission-route-0001', '2026-07-22T13:00:00.000Z');
  await seed(dir, 'Urgent mission', 'urgent', 'mission-route-0002', '2026-07-22T14:00:00.000Z');

  const result = await handleMissionsList(new URLSearchParams({ priority: 'urgent', limit: '10' }), {
    missionsDir: dir,
  });
  assert.equal(result.status, 200);
  assert.equal(result.body.count, 1);
  assert.equal(result.body.total_matching, 1);
  assert.equal(result.body.missions[0].title, 'Urgent mission');
  assert.equal(Object.hasOwn(result.body.missions[0], 'history'), false);
  assert.equal(Object.hasOwn(result.body.missions[0], 'creation_request_hash'), false);
});

test('mission detail returns bounded durable creation evidence', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'ops-room-mission-detail-'));
  t.after(() => rm(dir, { recursive: true, force: true }));

  const created = await seed(dir, 'Mission detail', 'high', 'mission-route-0003', '2026-07-22T14:00:00.000Z');
  const result = await handleMissionDetail(created.mission.mission_id, { missionsDir: dir });

  assert.equal(result.status, 200);
  assert.equal(result.body.mission.state, 'planned');
  assert.equal(result.body.mission.workflow_id, null);
  assert.equal(result.body.mission.history[0].event, 'mission_created');
  assert.equal(Object.hasOwn(result.body.mission, 'creation_request_hash'), false);
});

test('mission read filters and IDs fail closed', async () => {
  const invalidState = await handleMissionsList(new URLSearchParams({ state: 'executing' }), {
    missionsDir: '/unused',
    listRecords: async () => [],
  });
  assert.equal(invalidState.status, 400);
  assert.equal(invalidState.body.error, 'invalid_mission_state_filter');

  const invalidId = await handleMissionDetail('../mission', {
    missionsDir: '/unused',
    readRecord: async () => { throw new Error('should_not_read'); },
  });
  assert.equal(invalidId.status, 400);
  assert.equal(invalidId.body.error, 'invalid_mission_id');
});

test('unreadable mission records degrade without exposing filesystem errors', async () => {
  const result = await handleMissionDetail('mission:example:0123456789abcdef01234567', {
    missionsDir: '/private/path',
    readRecord: async () => { throw new Error('/private/path/mission.json failed'); },
  });

  assert.equal(result.status, 200);
  assert.equal(result.body.mission.unavailable, true);
  assert.equal(result.body.mission.last_error, 'mission_record_unavailable');
  assert.equal(JSON.stringify(result.body).includes('/private/path'), false);
});
