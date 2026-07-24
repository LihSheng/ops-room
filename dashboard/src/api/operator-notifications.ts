export type OperatorNotificationStateName = 'unread' | 'read' | 'acknowledged';
export type OperatorNotificationPriority = 'low' | 'normal' | 'high' | 'critical';

export interface OperatorNotificationState {
  state: OperatorNotificationStateName;
  read_at: string | null;
  acknowledged_at: string | null;
  acknowledgement_reason: string | null;
}

export interface OperatorNotification {
  notification_id: string;
  activity_id: string;
  notification_type: string;
  priority: OperatorNotificationPriority;
  title: string;
  detail: string | null;
  severity: string;
  category: string;
  reason_code: string | null;
  at: string;
  mission: {
    mission_id: string;
    title: string;
    state: string | null;
  };
  workflow_id: string | null;
  child_id: string | null;
  stage_key: string | null;
  owner_agent: string | null;
  state: string | null;
  input_sha: string | null;
  output_sha: string | null;
  links: {
    mission: string | null;
    stage: string | null;
    agent: string | null;
    workflow: string | null;
    activity: string | null;
  };
  operator_state: OperatorNotificationState;
}

export interface OperatorNotificationsResponse {
  notifications: OperatorNotification[];
  count: number;
  total_matching: number;
  summary: {
    total: number;
    unread: number;
    read: number;
    acknowledged: number;
    critical: number;
    latest_at: string | null;
  };
  sources: {
    activity: {
      missions: 'available' | 'degraded' | 'unavailable';
      mission_rooms: 'available' | 'degraded' | 'unavailable';
    };
    operator_state: 'available' | 'degraded' | 'unavailable';
  };
  generated_at: string;
}

export interface OperatorNotificationResponse {
  notification: OperatorNotification;
  domain_idempotent?: boolean;
  idempotent_replay?: boolean;
  audit_event_id?: string;
}

export class OperatorNotificationsApiError extends Error {
  readonly status: number;
  readonly errorCode: string | null;
  readonly auditEventId: string | null;

  constructor(status: number, message: string, errorCode: string | null, auditEventId: string | null) {
    super(message);
    this.name = 'OperatorNotificationsApiError';
    this.status = status;
    this.errorCode = errorCode;
    this.auditEventId = auditEventId;
  }
}

export function createNotificationIdempotencyKey(action: 'read' | 'acknowledge') {
  const suffix = globalThis.crypto?.randomUUID?.()
    || `${Date.now()}-${Math.random().toString(36).slice(2, 12)}`;
  return `browser-notification-${action}:${suffix}`;
}

async function requestJson<T>(url: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(url, {
    ...init,
    credentials: 'same-origin',
    headers: { Accept: 'application/json', ...init.headers },
  });
  const payload = await response.json().catch(() => ({})) as Record<string, unknown>;
  if (!response.ok) {
    throw new OperatorNotificationsApiError(
      response.status,
      String(payload.error || response.statusText || 'Notification request failed'),
      payload.error_code ? String(payload.error_code) : null,
      payload.audit_event_id ? String(payload.audit_event_id) : null,
    );
  }
  return payload as T;
}

function mutationHeaders(csrfToken: string) {
  return {
    'Content-Type': 'application/json',
    'X-Ops-Room-CSRF': csrfToken,
  };
}

function listUrl({ state = 'all', type, missionId, limit = 100 }: {
  state?: OperatorNotificationStateName | 'all';
  type?: string | null;
  missionId?: string | null;
  limit?: number;
} = {}) {
  const params = new URLSearchParams({
    state,
    limit: String(Math.max(1, Math.min(limit, 500))),
  });
  if (type) params.set('type', type);
  if (missionId) params.set('mission_id', missionId);
  return `/api/operator/notifications?${params.toString()}`;
}

export const operatorNotificationsApi = {
  list: (filters: Parameters<typeof listUrl>[0] = {}) => requestJson<OperatorNotificationsResponse>(listUrl(filters)),
  detail: (notificationId: string) => requestJson<OperatorNotificationResponse>(
    `/api/operator/notifications/${encodeURIComponent(notificationId)}`,
  ),
  markRead: ({ notificationId, csrfToken, idempotencyKey }: {
    notificationId: string;
    csrfToken: string;
    idempotencyKey: string;
  }) => requestJson<OperatorNotificationResponse>(
    `/api/operator/notifications/${encodeURIComponent(notificationId)}/read`,
    {
      method: 'POST',
      headers: mutationHeaders(csrfToken),
      body: JSON.stringify({ idempotency_key: idempotencyKey }),
    },
  ),
  acknowledge: ({ notificationId, csrfToken, idempotencyKey, reason }: {
    notificationId: string;
    csrfToken: string;
    idempotencyKey: string;
    reason: string;
  }) => requestJson<OperatorNotificationResponse>(
    `/api/operator/notifications/${encodeURIComponent(notificationId)}/acknowledge`,
    {
      method: 'POST',
      headers: mutationHeaders(csrfToken),
      body: JSON.stringify({ idempotency_key: idempotencyKey, reason }),
    },
  ),
};
