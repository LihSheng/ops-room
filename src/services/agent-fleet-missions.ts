import { getAgentFleet } from './agent-fleet.js';
import { buildAgentMissionIndex, evidenceSourceState } from './agent-mission-evidence.js';
import { listMissions } from './mission-store.js';
import { MISSIONS_DIR, WORKFLOW_RUNS_DIR } from './runtime-paths.js';
import { listWorkflowRuns } from './workflow-run-store.js';

function timestampValue(value: unknown): number {
  if (!value) return 0;
  const parsed = new Date(String(value)).getTime();
  return Number.isFinite(parsed) ? parsed : 0;
}

function newestTimestamp(values: unknown[]): string | null {
  return values
    .map((value) => ({ value: value ? String(value).slice(0, 64) : null, timestamp: timestampValue(value) }))
    .filter((entry) => entry.value && entry.timestamp > 0)
    .sort((left, right) => right.timestamp - left.timestamp)[0]?.value || null;
}

export function enrichAgentFleetWithMissionEvidence({
  fleetSnapshot,
  missions = [],
  workflows = [],
  missionsAvailable = true,
  workflowsAvailable = true,
}: any) {
  const missionByAgent = buildAgentMissionIndex({ missions, workflows });
  const fleet = (fleetSnapshot?.fleet || []).map((agent: any) => {
    const currentMission = missionByAgent.get(String(agent.id || '').toLowerCase()) || null;
    return {
      ...agent,
      current_mission: currentMission,
      last_activity_at: newestTimestamp([
        currentMission?.updated_at,
        agent.last_activity_at,
      ]),
    };
  });

  return {
    ...fleetSnapshot,
    fleet,
    count: fleet.length,
    sources: {
      ...(fleetSnapshot?.sources || {}),
      missions: evidenceSourceState(missions, missionsAvailable),
      workflows: evidenceSourceState(workflows, workflowsAvailable),
    },
  };
}

export async function getAgentFleetWithMissionEvidence({
  agents,
  getBaseFleet = getAgentFleet,
  getMissions = () => listMissions({ dir: MISSIONS_DIR, limit: 500 }),
  getWorkflows = () => listWorkflowRuns({ dir: WORKFLOW_RUNS_DIR, limit: 500 }),
  ...baseOptions
}: any = {}) {
  const fleetSnapshot = await getBaseFleet({ agents, ...baseOptions });
  let missions: any[] = [];
  let workflows: any[] = [];
  let missionsAvailable = true;
  let workflowsAvailable = true;

  try {
    missions = await getMissions();
  } catch {
    missionsAvailable = false;
  }

  try {
    workflows = await getWorkflows();
  } catch {
    workflowsAvailable = false;
  }

  return enrichAgentFleetWithMissionEvidence({
    fleetSnapshot,
    missions,
    workflows,
    missionsAvailable,
    workflowsAvailable,
  });
}
