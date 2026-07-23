import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildActivityEventIndex,
  handleActivityEventIndex,
  serializeGlobalActivityEvent,
} from '../src/services/activity-event-index.js';

function mission(id: string, title = id) {
  return { mission_id: id, title, state: 'active', repository_id: 'LihSheng/ops-room', workflow_id: `workflow-${id}` };
}

function event(id: string, at: string, severity = 'info', category = 'mission') {
  return {
    event_id: id,
    event_type: id,
    category,
    severity,
    source: 'mission',
    source_id: id,
    title: `Event ${id}`,
    detail: `Detail ${id}`,
    at,
    links: {},
  };
}

const dirs = {
  missionsDir: '/missions',
  workflowRunsDir: '/workflows',
  workflowEffectsDir: '/effects',
  workspaceRecordsDir: '/workspaces',
};

test('global activity index composes, deduplicates, and deterministically orders Mission Room events', async () => {
  const records = [mission('mission-b', 'Beta'), mission('mission-a', 'Alpha')];
  const result = await buildActivityEventIndex({
    ...dirs,
    listRecords: async () => records as any,
    roomHandler: async (missionId: string) => ({
      status: 200,
      body: {
        room: {
          activity: missionId === 'mission-a'
            ? [event('shared', '2026-07-23T10:00:00.000Z'), event('newer', '2026-07-23T12:00:00.000Z', 'success', 'stage')]
            : [event('shared', '2026-07-23T11:00:00.000Z', 'attention', 'workflow')],
        },
      },
    }) as any,
    now: () => '2026-07-23T13:00:00.000Z',
  });

  assert.equal(result.events.length, 3);
  assert.deepEqual(result.events.map((entry) => entry.activity_id), [
    'mission-a:newer',
    'mission-b:shared',
    'mission-a:shared',
  ]);
  assert.deepEqual(result.missions.map((entry) => entry.mission_id), ['mission-a', 'mission-b']);
  assert.equal(result.summary.attention, 1);
  assert.equal(result.summary.success, 1);
  assert.equal(result.sources.missions, 'available');
  assert.equal(result.sources.mission_rooms, 'available');
});

test('global activity index filters attention, category, severity, and Mission without mutating records', async () => {
  const records = [mission('mission-a')];
  const base = {
    ...dirs,
    listRecords: async () => records as any,
    roomHandler: async () => ({
      status: 200,
      body: { room: { activity: [
        event('info', '2026-07-23T10:00:00.000Z'),
        event('attention', '2026-07-23T11:00:00.000Z', 'attention', 'workflow'),
        event('error', '2026-07-23T12:00:00.000Z', 'error', 'effect'),
      ] } },
    }) as any,
  };

  const attention = await buildActivityEventIndex({ ...base, filters: { attentionOnly: true } });
  assert.deepEqual(attention.events.map((entry) => entry.event_id), ['error', 'attention']);
  const effect = await buildActivityEventIndex({ ...base, filters: { category: 'effect' } });
  assert.deepEqual(effect.events.map((entry) => entry.event_id), ['error']);
  const errors = await buildActivityEventIndex({ ...base, filters: { severity: 'error', missionId: 'mission-a' } });
  assert.deepEqual(errors.events.map((entry) => entry.event_id), ['error']);
});

test('Mission Room failures degrade independently while healthy Missions remain visible', async () => {
  const result = await buildActivityEventIndex({
    ...dirs,
    listRecords: async () => [mission('healthy'), mission('broken')] as any,
    roomHandler: async (missionId: string) => {
      if (missionId === 'broken') throw new Error('unavailable');
      return { status: 200, body: { room: { activity: [event('ok', '2026-07-23T10:00:00.000Z')] } } } as any;
    },
  });
  assert.equal(result.events.length, 1);
  assert.equal(result.sources.missions, 'available');
  assert.equal(result.sources.mission_rooms, 'degraded');
});

test('Mission list failure returns unavailable source evidence instead of synthetic activity', async () => {
  const result = await buildActivityEventIndex({
    ...dirs,
    listRecords: async () => { throw new Error('unavailable'); },
  });
  assert.deepEqual(result.events, []);
  assert.equal(result.sources.missions, 'unavailable');
  assert.equal(result.sources.mission_rooms, 'unavailable');
});

test('public activity serialization keeps bounded evidence and rejects unsafe links', () => {
  const serialized = serializeGlobalActivityEvent({
    ...event('bounded', '2026-07-23T10:00:00.000Z'),
    detail: 'x'.repeat(800),
    links: { mission: 'https://evil.example', stage: '/missions/a#stage-1' },
  }, mission('mission-a'));
  assert.equal(serialized.detail?.length, 500);
  assert.equal(serialized.links.mission, '/missions/mission-a');
  assert.equal(serialized.links.stage, '/missions/a#stage-1');
  assert.equal('provider_output' in serialized, false);
  assert.equal('environment' in serialized, false);
});

test('activity filters fail closed', async () => {
  const invalidSeverity = await handleActivityEventIndex(new URLSearchParams('severity=secret'), dirs);
  assert.equal(invalidSeverity.status, 400);
  assert.equal(invalidSeverity.body.error, 'invalid_activity_severity_filter');
  const invalidCategory = await handleActivityEventIndex(new URLSearchParams('category=raw-provider'), dirs);
  assert.equal(invalidCategory.status, 400);
  assert.equal(invalidCategory.body.error, 'invalid_activity_category_filter');
});
