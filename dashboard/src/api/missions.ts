export type MissionPriority = 'low' | 'normal' | 'high' | 'urgent';
export type MissionEvidenceSourceState = 'available' | 'degraded' | 'unavailable' | 'not_applicable';
export type MissionActivitySeverity = 'info' | 'success' | 'warning' | 'attention' | 'error';
export type MissionActivityCategory = 'mission' | 'workflow' | 'stage' | 'workspace' | 'effect' | 'review' | 'intervention';

export interface MissionParticipant {
  agent_id: string;
  roles: string[];
}

export interface MissionRecord {
  mission_id: string;
  title: string;
  objective: string | null;
  repository_id: string | null;
  starting_branch: string | null;
  starting_sha: string | null;
  workflow_type: 'feature-development';
  policy: {
    max_iterations: number;
    approval_policy: 'berlin-review-required';
  } | null;
  state: 'planned' | 'active' | 'paused' | 'completed' | 'needs_human' | 'cancelled';
  participants: MissionParticipant[];
  stage_owners: Record<string, string> | null;
  workflow_id: string | null;
  github_issue: number | null;
  reference_documents: string[];
  required_capabilities: string[];
  priority: MissionPriority | null;
  deadline: string | null;
  supporting_context: string | null;
  created_by: {
    actor_id: string;
    actor_display_name: string | null;
  } | null;
  created_at: string | null;
  updated_at: string | null;
  completed_at: string | null;
  unavailable?: boolean;
  last_error?: string | null;
}

export interface WorkflowChildRecord {
  child_id: string;
  stage: string;
  owner_agent: string;
  iteration: number;
  attempt: number;
  state: string;
  depends_on: string | null;
  input_sha: string;
  output_sha: string | null;
}

export interface WorkflowRecord {
  workflow_id: string;
  workflow_type: 'feature-development';
  repository_id: string;
  source_sha: string;
  state: string;
  policy: {
    max_iterations: number;
    max_concurrency: number;
  };
  current_iteration: number;
  child_count: number;
  children: WorkflowChildRecord[];
  created_at: string;
  updated_at: string;
}

export interface MissionRoomWorkspace {
  workspace_id: string;
  mode: string | null;
  state: string;
  repository_id: string | null;
  branch: string | null;
  resolved_sha: string | null;
  held_for_investigation: boolean;
  cleanup_requested: boolean;
  created_at: string | null;
  updated_at: string | null;
  unavailable: boolean;
  last_error: string | null;
}

export interface MissionRoomEffect {
  effect_id: string;
  effect_type: string | null;
  state: string;
  attempt: number | null;
  claimed_at: string | null;
  completed_at: string | null;
  output_sha: string | null;
  result_code: string | null;
  unavailable: boolean;
  last_error: string | null;
}

export interface MissionRoomStage {
  key: string;
  child_id: string | null;
  iteration: number;
  stage: 'implementation' | 'test' | 'integration' | 'review';
  owner_agent: string;
  state: string;
  attempt: number;
  retry_count: number;
  depends_on: string | null;
  input_sha: string | null;
  output_sha: string | null;
  created_at: string | null;
  started_at: string | null;
  completed_at: string | null;
  duration_seconds: number | null;
  last_error: string | null;
  review_decision: string | null;
  review_reason: string | null;
  workspace: MissionRoomWorkspace | null;
  provider_effect: MissionRoomEffect | null;
  provider_effect_count: number;
  verification: { status: string; reason: string | null };
  retry_history: Array<{
    event: string;
    reason: string | null;
    from: string | null;
    to: string | null;
    at: string | null;
  }>;
  evidence: {
    workspace: MissionEvidenceSourceState;
    provider_effect: MissionEvidenceSourceState;
  };
}

export interface MissionActivityEvent {
  event_id: string;
  event_type: string;
  category: MissionActivityCategory;
  severity: MissionActivitySeverity;
  source: 'mission' | 'workflow' | 'workflow_child' | 'workspace' | 'provider_effect';
  source_id: string | null;
  title: string;
  detail: string | null;
  reason_code: string | null;
  at: string;
  mission_id: string | null;
  workflow_id: string | null;
  child_id: string | null;
  stage_key: string | null;
  iteration: number | null;
  stage: string | null;
  owner_agent: string | null;
  input_sha: string | null;
  output_sha: string | null;
  state: string | null;
  attempt: number | null;
  links: {
    mission: string | null;
    stage: string | null;
    agent: string | null;
    workflow: string | null;
  };
}

export interface MissionRoom {
  mission: MissionRecord;
  workflow: {
    workflow_id: string | null;
    workflow_type: string | null;
    repository_id: string | null;
    source_sha: string | null;
    state: string | null;
    current_iteration: number;
    policy: { max_iterations: number; max_concurrency: number } | null;
    created_at: string | null;
    updated_at: string | null;
    completed_at: string | null;
    last_error: string | null;
  } | null;
  timeline: MissionRoomStage[];
  activity: MissionActivityEvent[];
  activity_summary: {
    total: number;
    attention: number;
    reviews: number;
    retries: number;
    effects: number;
    latest_at: string | null;
  };
  summary: {
    iterations: number;
    created_stages: number;
    completed_stages: number;
    attention_stages: number;
    degraded_stages: number;
    current_stage_key: string | null;
    attention_required: boolean;
  };
  sources: {
    mission: MissionEvidenceSourceState;
    workflow: MissionEvidenceSourceState;
    workspaces: MissionEvidenceSourceState;
    effects: MissionEvidenceSourceState;
  };
  generated_at: string;
}

export interface MissionsListResponse {
  missions: MissionRecord[];
  count: number;
  total_matching: number;
  unavailable_count: number;
}

export interface MissionDetailResponse {
  mission: MissionRecord;
  room: MissionRoom | null;
  room_unavailable: boolean;
  room_error_code: string | null;
}

export interface CreateMissionRequest {
  title: string;
  objective: string;
  repository: string;
  starting_branch: string;
  starting_sha: string;
  workflow_type: 'feature-development';
  max_iterations: number;
  approval_policy: 'berlin-review-required';
  github_issue?: number;
  reference_documents: string[];
  required_capabilities: string[];
  priority: MissionPriority;
  deadline?: string;
  supporting_context?: string;
  reason: string;
  idempotency_key: string;
}

export interface CreateMissionResponse {
  operation: 'mission.create';
  mission: MissionRecord;
  audit_event_id: string;
  idempotent_replay: boolean;
}

export interface StartMissionRequest {
  reason: string;
  idempotency_key: string;
}

export interface StartMissionResponse {
  operation: 'mission.start';
  mission: MissionRecord;
  workflow: WorkflowRecord;
  initial_child: WorkflowChildRecord;
  started: boolean;
  provider_invoked: false;
  audit_event_id: string;
  idempotent_replay: boolean;
}

export class MissionApiError extends Error {
  readonly status: number;
  readonly errorCode: string | null;
  readonly auditEventId: string | null;

  constructor(status: number, message: string, errorCode: string | null, auditEventId: string | null) {
    super(message);
    this.name = 'MissionApiError';
    this.status = status;
    this.errorCode = errorCode;
    this.auditEventId = auditEventId;
  }
}

async function requestJson<T>(url: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(url, {
    ...init,
    credentials: 'same-origin',
    headers: { Accept: 'application/json', ...init.headers },
  });
  const payload = await response.json().catch(() => ({})) as Record<string, unknown>;
  if (!response.ok) {
    throw new MissionApiError(
      response.status,
      String(payload.error || response.statusText || 'Mission request failed'),
      payload.error_code ? String(payload.error_code) : null,
      payload.audit_event_id ? String(payload.audit_event_id) : null,
    );
  }
  return payload as T;
}

export const missionsApi = {
  listMissions: () => requestJson<MissionsListResponse>('/api/missions?limit=100'),
  getMission: (missionId: string) => requestJson<MissionDetailResponse>(
    `/api/missions/${encodeURIComponent(missionId)}`,
  ),
  createMission: (request: CreateMissionRequest, csrfToken: string) => requestJson<CreateMissionResponse>(
    '/api/operator/missions',
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Ops-Room-CSRF': csrfToken,
      },
      body: JSON.stringify(request),
    },
  ),
  startMission: (missionId: string, request: StartMissionRequest, csrfToken: string) => {
    const path = `/api/operator/missions/${encodeURIComponent(missionId)}/start`;
    return requestJson<StartMissionResponse>(path, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Ops-Room-CSRF': csrfToken,
        'X-Ops-Room-Confirmation': `confirm:mission.start:POST:${path}`,
      },
      body: JSON.stringify(request),
    });
  },
};
