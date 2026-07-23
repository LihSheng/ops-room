export type MissionPriority = 'low' | 'normal' | 'high' | 'urgent';

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

export interface MissionsListResponse {
  missions: MissionRecord[];
  count: number;
  total_matching: number;
  unavailable_count: number;
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
    headers: {
      Accept: 'application/json',
      ...init.headers,
    },
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
