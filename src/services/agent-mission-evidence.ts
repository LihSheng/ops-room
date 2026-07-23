const CURRENT_MISSION_STATES = new Set(['planned', 'active', 'paused', 'needs_human']);
const CURRENT_CHILD_STATES = new Set(['pending', 'active', 'failed', 'needs_human']);
const STAGE_ORDER = Object.freeze(['implementation', 'test', 'integration', 'review']);
const STATE_PRIORITY: Record<string, number> = Object.freeze({
  needs_human: 0,
  active: 1,
  paused: 2,
  planned: 3,
});
const PRIORITY_ORDER: Record<string, number> = Object.freeze({
  urgent: 0,
  high: 1,
  normal: 2,
  low: 3,
});

function bounded(value: unknown, maximum = 240): string | null {
  if (value == null) return null;
  const normalized = String(value).trim();
  return normalized ? normalized.slice(0, maximum) : null;
}

function timestampValue(value: unknown): number {
  if (!value) return 0;
  const parsed = new Date(String(value)).getTime();
  return Number.isFinite(parsed) ? parsed : 0;
}

function newestTimestamp(values: unknown[]): string | null {
  return values
    .map((value) => ({ value: bounded(value, 64), timestamp: timestampValue(value) }))
    .filter((entry) => entry.value && entry.timestamp > 0)
    .sort((left, right) => right.timestamp - left.timestamp)[0]?.value || null;
}

function normalizeAgentId(value: unknown): string {
  return String(value || '').trim().toLowerCase();
}

function validMission(record: any): boolean {
  return Boolean(
    record
    && !record.unavailable
    && bounded(record.mission_id, 180)
    && CURRENT_MISSION_STATES.has(String(record.state || ''))
    && Array.isArray(record.participants),
  );
}

function validWorkflow(record: any): boolean {
  return Boolean(record && !record.unavailable && bounded(record.workflow_id, 180));
}

function workflowMatchesMission(mission: any, workflow: any): boolean {
  return String(workflow?.repository_id || '') === String(mission?.repository_id || '')
    && String(workflow?.source_sha || '').toLowerCase() === String(mission?.starting_sha || '').toLowerCase()
    && String(workflow?.workflow_type || '') === String(mission?.workflow_type || '')
    && Number(workflow?.policy?.max_iterations) === Number(mission?.policy?.max_iterations);
}

function currentWorkflowChild(workflow: any) {
  const candidates = Array.isArray(workflow?.children)
    ? workflow.children.filter((child: any) => CURRENT_CHILD_STATES.has(String(child?.state || '')))
    : [];

  candidates.sort((left: any, right: any) => {
    const iteration = Number(right?.iteration || 0) - Number(left?.iteration || 0);
    if (iteration !== 0) return iteration;
    const stateRank = (String(left?.state) === 'active' ? 0 : 1) - (String(right?.state) === 'active' ? 0 : 1);
    if (stateRank !== 0) return stateRank;
    const stageRank = STAGE_ORDER.indexOf(String(right?.stage)) - STAGE_ORDER.indexOf(String(left?.stage));
    if (stageRank !== 0) return stageRank;
    return String(left?.child_id || '').localeCompare(String(right?.child_id || ''));
  });

  return {
    child: candidates.length === 1 ? candidates[0] : null,
    ambiguous: candidates.length > 1,
  };
}

function evidenceStatus(mission: any, workflow: any, childResult: { child: any; ambiguous: boolean }) {
  if (!mission.workflow_id) return mission.state === 'planned' ? 'mission_only' : 'binding_missing';
  if (!workflow) return 'workflow_unavailable';
  if (!workflowMatchesMission(mission, workflow)) return 'workflow_conflict';
  if (childResult.ambiguous) return 'workflow_ambiguous';
  if (!childResult.child && ['active', 'blocked', 'planned'].includes(String(workflow.state || ''))) {
    return 'stage_unavailable';
  }
  return 'available';
}

function attentionReason(mission: any, child: any, status: string): string | null {
  if (String(mission.state) === 'needs_human') return 'mission_needs_human';
  if (String(child?.state) === 'failed') return 'workflow_child_failed';
  if (String(child?.state) === 'needs_human') return 'workflow_child_needs_human';
  if (!['available', 'mission_only'].includes(status)) return status;
  return null;
}

function summarizeAssignment({ mission, workflow, participant, agentId }: any) {
  const childResult = currentWorkflowChild(workflow);
  const child = childResult.child;
  const status = evidenceStatus(mission, workflow, childResult);
  const reasonCode = attentionReason(mission, child, status);
  const participantRoles = Array.isArray(participant?.roles)
    ? participant.roles.map((role: unknown) => bounded(role, 80)).filter(Boolean).slice(0, 10)
    : [];
  const stageOwner = bounded(child?.owner_agent, 180);
  const workflowId = bounded(mission.workflow_id, 180);
  const startingSha = bounded(mission.starting_sha, 40);

  return {
    mission_id: bounded(mission.mission_id, 180),
    title: bounded(mission.title, 160) || 'Untitled mission',
    state: bounded(mission.state, 40) || 'unknown',
    priority: bounded(mission.priority, 20),
    repository_id: bounded(mission.repository_id, 220),
    starting_branch: bounded(mission.starting_branch, 240),
    starting_sha: startingSha && /^[0-9a-f]{40}$/i.test(startingSha) ? startingSha.toLowerCase() : null,
    workflow_id: workflowId,
    workflow_state: bounded(workflow?.state, 40),
    participant_roles: participantRoles,
    stage: bounded(child?.stage, 40),
    stage_state: bounded(child?.state, 40),
    stage_owner: stageOwner,
    iteration: Number.isInteger(Number(child?.iteration)) ? Number(child.iteration) : null,
    current_agent_is_stage_owner: Boolean(stageOwner && normalizeAgentId(stageOwner) === normalizeAgentId(agentId)),
    evidence_status: status,
    attention_required: Boolean(reasonCode),
    attention_reason_code: reasonCode,
    updated_at: newestTimestamp([
      child?.updated_at,
      workflow?.updated_at,
      mission.updated_at,
      mission.created_at,
    ]),
    additional_mission_count: 0,
  };
}

function assignmentComparator(left: any, right: any) {
  const ownerRank = Number(!left.current_agent_is_stage_owner) - Number(!right.current_agent_is_stage_owner);
  if (ownerRank !== 0) return ownerRank;

  const stateRank = (STATE_PRIORITY[left.state] ?? 99) - (STATE_PRIORITY[right.state] ?? 99);
  if (stateRank !== 0) return stateRank;

  const priorityRank = (PRIORITY_ORDER[left.priority] ?? 99) - (PRIORITY_ORDER[right.priority] ?? 99);
  if (priorityRank !== 0) return priorityRank;

  const evidenceRank = (left.evidence_status === 'available' ? 0 : left.evidence_status === 'mission_only' ? 1 : 2)
    - (right.evidence_status === 'available' ? 0 : right.evidence_status === 'mission_only' ? 1 : 2);
  if (evidenceRank !== 0) return evidenceRank;

  const timestampRank = timestampValue(right.updated_at) - timestampValue(left.updated_at);
  if (timestampRank !== 0) return timestampRank;

  return String(left.mission_id || '').localeCompare(String(right.mission_id || ''));
}

export function buildAgentMissionIndex({ missions = [], workflows = [] }: any = {}) {
  const workflowById = new Map(
    workflows
      .filter(validWorkflow)
      .map((workflow: any) => [String(workflow.workflow_id), workflow]),
  );
  const assignments = new Map<string, any[]>();

  for (const mission of missions.filter(validMission)) {
    const workflow = mission.workflow_id ? workflowById.get(String(mission.workflow_id)) || null : null;
    for (const participant of mission.participants) {
      const agentId = normalizeAgentId(participant?.agent_id);
      if (!agentId) continue;
      const current = assignments.get(agentId) || [];
      current.push(summarizeAssignment({ mission, workflow, participant, agentId }));
      assignments.set(agentId, current);
    }
  }

  const selected = new Map<string, any>();
  for (const [agentId, agentAssignments] of assignments) {
    agentAssignments.sort(assignmentComparator);
    selected.set(agentId, {
      ...agentAssignments[0],
      additional_mission_count: Math.max(0, agentAssignments.length - 1),
    });
  }
  return selected;
}

export function evidenceSourceState(records: any[], available: boolean) {
  if (!available) return 'unavailable';
  return records.some((record) => record?.unavailable) ? 'degraded' : 'available';
}
