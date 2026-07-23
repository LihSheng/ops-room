import { readMission } from '../services/mission-store.js';
import { readWorkflowRun } from '../services/workflow-run-store.js';
import { listWorkflowEffects } from '../services/workflow-effect-store.js';
import { listWorkspaceRecords } from '../services/workspace-store.js';
import { buildMissionRoom } from '../services/mission-room.js';

const SAFE_PUBLIC_ID = /^[A-Za-z0-9._:-]{1,180}$/;

export async function handleMissionRoomDetail(missionId: unknown, {
  missionsDir,
  workflowRunsDir,
  workflowEffectsDir,
  workspaceRecordsDir,
  readMissionRecord = readMission,
  readWorkflowRecord = readWorkflowRun,
  listEffects = listWorkflowEffects,
  listWorkspaces = listWorkspaceRecords,
  now = () => new Date().toISOString(),
}: any = {}) {
  const normalizedId = String(missionId || '');
  if (!SAFE_PUBLIC_ID.test(normalizedId)) {
    return { status: 400, body: { error: 'invalid_mission_id' } };
  }

  let mission;
  try {
    mission = await readMissionRecord({ dir: missionsDir, missionId: normalizedId });
  } catch (error: any) {
    if (error?.code === 'ENOENT') {
      return { status: 404, body: { error: 'Mission not found' } };
    }
    return {
      status: 200,
      body: {
        room: null,
        unavailable: true,
        error_code: 'mission_record_unavailable',
      },
    };
  }

  let workflow = null;
  let workflowSource = mission.workflow_id ? 'available' : 'not_applicable';
  if (mission.workflow_id) {
    try {
      workflow = await readWorkflowRecord({
        dir: workflowRunsDir,
        workflowId: mission.workflow_id,
      });
      if (workflow.workflow_id !== mission.workflow_id) {
        workflow = null;
        workflowSource = 'degraded';
      }
    } catch {
      workflowSource = 'unavailable';
    }
  }

  let effects: any[] = [];
  let effectsSource = mission.workflow_id ? 'available' : 'not_applicable';
  if (mission.workflow_id) {
    try {
      effects = await listEffects({
        dir: workflowEffectsDir,
        workflowId: mission.workflow_id,
        limit: 1000,
      });
    } catch {
      effectsSource = 'unavailable';
    }
  }

  let workspaces: any[] = [];
  let workspacesSource = mission.workflow_id ? 'available' : 'not_applicable';
  if (mission.workflow_id) {
    try {
      workspaces = await listWorkspaces({ dir: workspaceRecordsDir });
      if (workspaces.some((workspace) => workspace?.last_error === 'workspace_record_unavailable')) {
        workspacesSource = 'degraded';
      }
    } catch {
      workspacesSource = 'unavailable';
    }
  }

  const room = buildMissionRoom({
    mission,
    workflow,
    effects,
    workspaces,
    sources: {
      mission: 'available',
      workflow: workflowSource,
      effects: effectsSource,
      workspaces: workspacesSource,
    },
    generatedAt: now(),
  });

  if (mission.workflow_id && !workflow) {
    room.summary.attention_required = true;
  }

  return { status: 200, body: { room } };
}
