export type OperatorTaskAction = 'pause' | 'resume' | 'cancel' | 'retry';

export interface ReviewTaskRecord {
  id?: string;
  task_id?: string;
  kind?: string;
  state?: string;
  repository?: string;
  pr?: number;
  agent?: string;
  task_type?: string;
  task_text?: string;
  attempt?: number;
  created_at?: string;
  updated_at?: string;
  completed_at?: string;
  error?: string | null;
  policy?: {
    retry_budget?: number;
  };
}

export interface ReviewTasksResponse {
  tasks: ReviewTaskRecord[];
}

export interface OperatorTaskActionResponse {
  operation: string;
  task: {
    id: string;
    kind: string;
    state: string;
    attempt: number;
  };
  audit_event_id: string;
  idempotent_replay: boolean;
}

export class OperatorTaskApiError extends Error {
  readonly status: number;
  readonly errorCode: string | null;
  readonly auditEventId: string | null;

  constructor(status: number, message: string, errorCode: string | null, auditEventId: string | null) {
    super(message);
    this.name = 'OperatorTaskApiError';
    this.status = status;
    this.errorCode = errorCode;
    this.auditEventId = auditEventId;
  }
}

const ACTION_STATES: Record<OperatorTaskAction, ReadonlySet<string>> = {
  pause: new Set(['QUEUED', 'FIX_QUEUED']),
  resume: new Set(['PAUSED']),
  cancel: new Set(['QUEUED', 'FIX_QUEUED', 'CLAIMED', 'RUNNING', 'FIXING']),
  retry: new Set(['ERROR', 'NEEDS_HUMAN', 'SUPERSEDED', 'CANCELLED']),
};

const ACTION_ORDER: OperatorTaskAction[] = ['pause', 'resume', 'retry', 'cancel'];

export function normalizeReviewTaskState(value: unknown): string {
  return String(value || 'UNKNOWN').trim().toUpperCase();
}

export function reviewTaskId(task: ReviewTaskRecord): string {
  return String(task.id || task.task_id || '').trim();
}

export function availableReviewTaskActions(state: unknown): OperatorTaskAction[] {
  const normalized = normalizeReviewTaskState(state);
  return ACTION_ORDER.filter((action) => ACTION_STATES[action].has(normalized));
}

export function createTaskActionIdempotencyKey(): string {
  const suffix = globalThis.crypto?.randomUUID?.()
    || `${Date.now()}-${Math.random().toString(36).slice(2, 12)}`;
  return `browser-task:${suffix}`;
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
    throw new OperatorTaskApiError(
      response.status,
      String(payload.error || response.statusText || 'Task action failed'),
      payload.error_code ? String(payload.error_code) : null,
      payload.audit_event_id ? String(payload.audit_event_id) : null,
    );
  }
  return payload as T;
}

export const operatorTasksApi = {
  list: (limit = 100) => requestJson<ReviewTasksResponse>(`/api/review-tasks?limit=${Math.min(Math.max(limit, 1), 100)}`),
  act: ({
    taskId,
    action,
    reason,
    idempotencyKey,
    csrfToken,
  }: {
    taskId: string;
    action: OperatorTaskAction;
    reason: string;
    idempotencyKey: string;
    csrfToken: string;
  }) => requestJson<OperatorTaskActionResponse>(
    `/api/operator/tasks/${encodeURIComponent(taskId)}/${action}`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Ops-Room-CSRF': csrfToken,
      },
      body: JSON.stringify({
        reason,
        idempotency_key: idempotencyKey,
      }),
    },
  ),
};
