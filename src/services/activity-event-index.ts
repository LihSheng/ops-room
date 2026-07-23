import { listMissions } from './mission-store.js';
import { handleMissionRoomDetail } from '../routes/mission-room.js';

export type ActivityEventSourceState = 'available' | 'degraded' | 'unavailable';
export type ActivityEventSeverity = 'info' | 'success' | 'warning' | 'attention' | 'error';
export type ActivityEventCategory = 'mission' | 'workflow' | 'stage' | 'workspace' | 'effect' | 'review' | 'intervention';

const SEVERITIES = new Set<ActivityEventSeverity>(['info', 'success', 'warning', 'attention', 'error']);
const CATEGORIES = new Set<ActivityEventCategory>(['mission', 'workflow', 'stage', 'workspace', 'effect', 'review', 'intervention']);

function bounded(value: unknown, maximum: number) {
  const normalized = String(value ?? '').trim();
  return normalized ? normalized.slice(0, maximum) : null;
}

function safePath(value: unknown) {
  const path = bounded(value, 500);
  return path && path.startsWith('/') && !path.startsWith('//') ? path : null;
}

function timestamp(value: unknown) {
  const parsed = value ? Date.parse(String(value)) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : 0;
}

function boundedLimit(value: unknown) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 100;
  return Math.max(1, Math.min(Math.trunc(parsed), 500));
}

function normalizeFilter<T extends string>(value: unknown, allowed: Set<T>, errorCode: string): T | null {
  const normalized = String(value || '').trim() as T;
  if (!normalized) return null;
  if (!allowed.has(normalized)) throw new Error(errorCode);
  return normalized;
}

function truthy(value: unknown) {
  return ['1', 'true', 'yes'].includes(String(value || '').trim().toLowerCase());
}

function missionSummary(record: any) {
  return {
    mission_id: bounded(record?.mission_id, 180) || 'mission-unavailable',
    title: bounded(record?.title, 180) || 'Mission',
    state: bounded(record?.state, 80),
    repository_id: bounded(record?.repository_id, 220),
    workflow_id: bounded(record?.workflow_id, 180),
  };
}

export function serializeGlobalActivityEvent(event: any, missionRecord: any) {
  const mission = missionSummary(missionRecord);
  const eventId = bounded(event?.event_id, 220) || 'event-unavailable';
  const missionId = mission.mission_id;
  return {
    activity_id: `${missionId}:${eventId}`,
    event_id: eventId,
    event_type: bounded(event?.event_type, 120) || 'activity_event',
    category: CATEGORIES.has(event?.category) ? event.category : 'intervention',
    severity: SEVERITIES.has(event?.severity) ? event.severity : 'warning',
    source: bounded(event?.source, 80) || 'mission',
    source_id: bounded(event?.source_id, 220),
    title: bounded(event?.title, 220) || 'Mission activity',
    detail: bounded(event?.detail, 500),
    reason_code: bounded(event?.reason_code, 160),
    at: bounded(event?.at, 64) || new Date(0).toISOString(),
    mission,
    workflow_id: bounded(event?.workflow_id, 180) || mission.workflow_id,
    child_id: bounded(event?.child_id, 220),
    stage_key: bounded(event?.stage_key, 220),
    iteration: Number.isInteger(event?.iteration) ? event.iteration : null,
    stage: bounded(event?.stage, 80),
    owner_agent: bounded(event?.owner_agent, 120),
    input_sha: bounded(event?.input_sha, 64),
    output_sha: bounded(event?.output_sha, 64),
    state: bounded(event?.state, 100),
    attempt: Number.isInteger(event?.attempt) ? event.attempt : null,
    links: {
      mission: safePath(event?.links?.mission) || `/missions/${encodeURIComponent(missionId)}`,
      stage: safePath(event?.links?.stage),
      agent: safePath(event?.links?.agent),
      workflow: safePath(event?.links?.workflow),
    },
  };
}

export interface ActivityEventIndexFilters {
  severity?: ActivityEventSeverity | null;
  category?: ActivityEventCategory | null;
  missionId?: string | null;
  attentionOnly?: boolean;
  limit?: number;
}

export async function buildActivityEventIndex({
  missionsDir,
  workflowRunsDir,
  workflowEffectsDir,
  workspaceRecordsDir,
  filters = {},
  listRecords = listMissions,
  roomHandler = handleMissionRoomDetail,
  now = () => new Date().toISOString(),
}: {
  missionsDir: string;
  workflowRunsDir: string;
  workflowEffectsDir: string;
  workspaceRecordsDir: string;
  filters?: ActivityEventIndexFilters;
  listRecords?: typeof listMissions;
  roomHandler?: typeof handleMissionRoomDetail;
  now?: () => string;
}) {
  const sources: { missions: ActivityEventSourceState; mission_rooms: ActivityEventSourceState } = {
    missions: 'available',
    mission_rooms: 'available',
  };
  let records: any[] = [];
  try {
    records = await listRecords({ dir: missionsDir, limit: 500 });
  } catch {
    sources.missions = 'unavailable';
    sources.mission_rooms = 'unavailable';
  }

  const missionMap = new Map<string, ReturnType<typeof missionSummary>>();
  const byId = new Map<string, ReturnType<typeof serializeGlobalActivityEvent>>();
  let roomFailures = 0;

  if (records.length > 0) {
    const results = await Promise.allSettled(records.map(async (record) => {
      const mission = missionSummary(record);
      missionMap.set(mission.mission_id, mission);
      const result = await roomHandler(mission.mission_id, {
        missionsDir,
        workflowRunsDir,
        workflowEffectsDir,
        workspaceRecordsDir,
        readMissionRecord: async () => record,
      });
      const room = result?.body?.room;
      if (!room || result?.body?.unavailable) throw new Error('mission_room_unavailable');
      return { record, events: Array.isArray(room.activity) ? room.activity : [] };
    }));

    for (const result of results) {
      if (result.status === 'rejected') {
        roomFailures += 1;
        continue;
      }
      for (const event of result.value.events) {
        try {
          const serialized = serializeGlobalActivityEvent(event, result.value.record);
          const existing = byId.get(serialized.activity_id);
          if (!existing || timestamp(serialized.at) > timestamp(existing.at)) byId.set(serialized.activity_id, serialized);
        } catch {
          roomFailures += 1;
        }
      }
    }
  }

  if (roomFailures > 0) {
    sources.mission_rooms = records.length > 0 && roomFailures >= records.length ? 'unavailable' : 'degraded';
  }

  const matching = [...byId.values()]
    .filter((event) => {
      if (filters.severity && event.severity !== filters.severity) return false;
      if (filters.category && event.category !== filters.category) return false;
      if (filters.missionId && event.mission.mission_id !== filters.missionId) return false;
      if (filters.attentionOnly && !['attention', 'error'].includes(event.severity)) return false;
      return true;
    })
    .sort((left, right) => (
      timestamp(right.at) - timestamp(left.at)
      || left.mission.mission_id.localeCompare(right.mission.mission_id)
      || left.activity_id.localeCompare(right.activity_id)
    ));

  const limit = boundedLimit(filters.limit);
  const events = matching.slice(0, limit);
  const byCategory: Record<string, number> = {};
  for (const event of matching) byCategory[event.category] = (byCategory[event.category] || 0) + 1;

  return {
    events,
    count: events.length,
    total_matching: matching.length,
    missions: [...missionMap.values()].sort((left, right) => left.title.localeCompare(right.title) || left.mission_id.localeCompare(right.mission_id)),
    summary: {
      total: matching.length,
      attention: matching.filter((event) => ['attention', 'error'].includes(event.severity)).length,
      errors: matching.filter((event) => event.severity === 'error').length,
      success: matching.filter((event) => event.severity === 'success').length,
      by_category: byCategory,
      latest_at: matching[0]?.at || null,
    },
    sources,
    generated_at: now(),
  };
}

export async function handleActivityEventIndex(searchParams: any, deps: Omit<Parameters<typeof buildActivityEventIndex>[0], 'filters'>) {
  try {
    const severity = normalizeFilter(searchParams?.get?.('severity'), SEVERITIES, 'invalid_activity_severity_filter');
    const category = normalizeFilter(searchParams?.get?.('category'), CATEGORIES, 'invalid_activity_category_filter');
    const missionId = bounded(searchParams?.get?.('mission_id'), 180);
    const limit = boundedLimit(searchParams?.get?.('limit'));
    const body = await buildActivityEventIndex({
      ...deps,
      filters: {
        severity,
        category,
        missionId,
        attentionOnly: truthy(searchParams?.get?.('attention')),
        limit,
      },
    });
    return { status: 200, body };
  } catch (error: any) {
    return { status: 400, body: { error: error?.message || 'invalid_activity_filter' } };
  }
}
