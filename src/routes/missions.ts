import {
  listMissions,
  readMission,
  serializeMission,
} from '../services/mission-store.js';
import {
  WORKFLOW_EFFECTS_DIR,
  WORKFLOW_RUNS_DIR,
  WORKSPACE_RECORDS_DIR,
} from '../services/runtime-paths.js';
import { handleMissionRoomDetail } from './mission-room.js';

const MISSION_STATES = new Set([
  'planned',
  'active',
  'paused',
  'completed',
  'needs_human',
  'cancelled',
]);
const PRIORITIES = new Set(['low', 'normal', 'high', 'urgent']);
const SAFE_PUBLIC_ID = /^[A-Za-z0-9._:-]{1,180}$/;
const SAFE_REPOSITORY_ID = /^(?:[A-Za-z0-9._-]{1,120}|[A-Za-z0-9._-]{1,100}\/[A-Za-z0-9._-]{1,100})$/;

function boundedLimit(value: unknown) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 50;
  return Math.min(Math.max(Math.trunc(parsed), 1), 100);
}

function normalizeRepositoryFilter(value: unknown) {
  const repository = String(value || '').trim();
  if (!repository) return null;
  if (!SAFE_REPOSITORY_ID.test(repository) || repository.includes('..')) {
    throw new Error('invalid_mission_repository_filter');
  }
  return repository;
}

function normalizeStateFilter(value: unknown) {
  const state = String(value || '').trim();
  if (!state) return null;
  if (!MISSION_STATES.has(state)) throw new Error('invalid_mission_state_filter');
  return state;
}

function normalizePriorityFilter(value: unknown) {
  const priority = String(value || '').trim();
  if (!priority) return null;
  if (!PRIORITIES.has(priority)) throw new Error('invalid_mission_priority_filter');
  return priority;
}

function unavailableMission(record: any, missionId: string | null = null) {
  const candidate = String(missionId || record?.mission_id || 'mission-unavailable');
  return {
    mission_id: SAFE_PUBLIC_ID.test(candidate) ? candidate : 'mission-unavailable',
    title: 'Mission record unavailable',
    objective: null,
    repository_id: null,
    starting_branch: null,
    starting_sha: null,
    workflow_type: 'feature-development',
    policy: null,
    state: 'needs_human',
    participants: [],
    stage_owners: null,
    workflow_id: null,
    github_issue: null,
    reference_documents: [],
    required_capabilities: [],
    priority: null,
    deadline: null,
    supporting_context: null,
    created_by: null,
    created_at: null,
    updated_at: null,
    completed_at: null,
    history: [],
    unavailable: true,
    last_error: 'mission_record_unavailable',
  };
}

function serializeForRead(record: any, includeHistory: boolean) {
  if (record?.unavailable) return unavailableMission(record);
  try {
    return serializeMission(record, { includeHistory });
  } catch {
    return unavailableMission(record);
  }
}

export async function handleMissionsList(searchParams: any, {
  missionsDir,
  listRecords = listMissions,
}: {
  missionsDir: string;
  listRecords?: typeof listMissions;
}) {
  const limit = boundedLimit(searchParams?.get?.('limit'));
  let repository: string | null;
  let state: string | null;
  let priority: string | null;
  try {
    repository = normalizeRepositoryFilter(searchParams?.get?.('repository'));
    state = normalizeStateFilter(searchParams?.get?.('state'));
    priority = normalizePriorityFilter(searchParams?.get?.('priority'));
  } catch (error: any) {
    return { status: 400, body: { error: error?.message || 'invalid_mission_filter' } };
  }

  const records = await listRecords({ dir: missionsDir, limit: 500 });
  const serialized = records.map((record) => serializeForRead(record, false));
  const filtered = serialized.filter((mission) => {
    if (repository && mission.repository_id !== repository) return false;
    if (state && mission.state !== state) return false;
    if (priority && mission.priority !== priority) return false;
    return true;
  });
  const missions = filtered.slice(0, limit);

  return {
    status: 200,
    body: {
      missions,
      count: missions.length,
      total_matching: filtered.length,
      unavailable_count: missions.filter((mission) => mission.unavailable).length,
    },
  };
}

export async function handleMissionDetail(missionId: unknown, {
  missionsDir,
  workflowRunsDir = WORKFLOW_RUNS_DIR,
  workflowEffectsDir = WORKFLOW_EFFECTS_DIR,
  workspaceRecordsDir = WORKSPACE_RECORDS_DIR,
  readRecord = readMission,
  roomHandler = handleMissionRoomDetail,
}: {
  missionsDir: string;
  workflowRunsDir?: string;
  workflowEffectsDir?: string;
  workspaceRecordsDir?: string;
  readRecord?: typeof readMission;
  roomHandler?: typeof handleMissionRoomDetail;
}) {
  const normalizedId = String(missionId || '');
  if (!SAFE_PUBLIC_ID.test(normalizedId)) {
    return { status: 400, body: { error: 'invalid_mission_id' } };
  }

  try {
    const record = await readRecord({ dir: missionsDir, missionId: normalizedId });
    const roomResult = await roomHandler(normalizedId, {
      missionsDir,
      workflowRunsDir,
      workflowEffectsDir,
      workspaceRecordsDir,
      readMissionRecord: async () => record,
    });
    return {
      status: 200,
      body: {
        mission: serializeForRead(record, true),
        room: roomResult?.body?.room || null,
        room_unavailable: Boolean(roomResult?.body?.unavailable),
        room_error_code: roomResult?.body?.error_code || null,
      },
    };
  } catch (error: any) {
    if (error?.code === 'ENOENT') {
      return { status: 404, body: { error: 'Mission not found' } };
    }
    return {
      status: 200,
      body: {
        mission: unavailableMission(null, normalizedId),
        room: null,
        room_unavailable: true,
        room_error_code: 'mission_record_unavailable',
      },
    };
  }
}
