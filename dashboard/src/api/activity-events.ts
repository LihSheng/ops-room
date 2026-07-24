export type ActivityEventSourceState = 'available' | 'degraded' | 'unavailable';
export type ActivityEventSeverity = 'info' | 'success' | 'warning' | 'attention' | 'error';
export type ActivityEventCategory = 'mission' | 'workflow' | 'stage' | 'workspace' | 'effect' | 'review' | 'intervention';

export interface ActivityEventMission {
  mission_id: string;
  title: string;
  state: string | null;
  repository_id: string | null;
  workflow_id: string | null;
}

export interface ActivityEvent {
  activity_id: string;
  event_id: string;
  event_type: string;
  category: ActivityEventCategory;
  severity: ActivityEventSeverity;
  source: string;
  source_id: string | null;
  title: string;
  detail: string | null;
  reason_code: string | null;
  at: string;
  mission: ActivityEventMission;
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

export interface ActivityEventsResponse {
  events: ActivityEvent[];
  count: number;
  total_matching: number;
  missions: ActivityEventMission[];
  summary: {
    total: number;
    attention: number;
    errors: number;
    success: number;
    by_category: Record<string, number>;
    latest_at: string | null;
  };
  sources: {
    missions: ActivityEventSourceState;
    mission_rooms: ActivityEventSourceState;
  };
  generated_at: string;
}

export interface ActivityEventFilters {
  severity?: ActivityEventSeverity | 'all';
  category?: ActivityEventCategory | 'all';
  missionId?: string | null;
  attentionOnly?: boolean;
  limit?: number;
}

export class ActivityEventsApiError extends Error {
  readonly status: number;
  readonly errorCode: string | null;

  constructor(status: number, message: string, errorCode: string | null) {
    super(message);
    this.name = 'ActivityEventsApiError';
    this.status = status;
    this.errorCode = errorCode;
  }
}

async function requestJson<T>(url: string): Promise<T> {
  const response = await fetch(url, {
    credentials: 'same-origin',
    headers: { Accept: 'application/json' },
  });
  const payload = await response.json().catch(() => ({})) as Record<string, unknown>;
  if (!response.ok) {
    throw new ActivityEventsApiError(
      response.status,
      String(payload.error || response.statusText || 'Activity request failed'),
      payload.error_code ? String(payload.error_code) : null,
    );
  }
  return payload as T;
}

function listUrl(filters: ActivityEventFilters = {}) {
  const params = new URLSearchParams();
  if (filters.severity && filters.severity !== 'all') params.set('severity', filters.severity);
  if (filters.category && filters.category !== 'all') params.set('category', filters.category);
  if (filters.missionId) params.set('mission_id', filters.missionId);
  if (filters.attentionOnly) params.set('attention', 'true');
  params.set('limit', String(Math.max(1, Math.min(filters.limit || 200, 500))));
  return `/api/activity-events?${params.toString()}`;
}

export const activityEventsApi = {
  list: (filters: ActivityEventFilters = {}) => requestJson<ActivityEventsResponse>(listUrl(filters)),
};
