import type { MissionRoom, MissionRoomStage } from './missions';

export type WorkflowBrowserAction = 'retry' | 'resume' | 'approve' | 'changes_requested';

export interface WorkflowActionOption {
  action: WorkflowBrowserAction;
  label: string;
  description: string;
  consequence: string;
  permission: 'workflow.recover' | 'workflow.approve';
  color: string;
}

export interface WorkflowActionResponse {
  operation: string;
  workflow: {
    workflow_id: string;
    state: string;
    current_iteration: number;
    last_error: string | null;
  };
  child: {
    child_id: string;
    stage: string;
    owner_agent: string;
    iteration: number;
    attempt: number;
    state: string;
    review_decision: string | null;
  } | null;
  next_child: {
    child_id: string;
    stage: string;
    owner_agent: string;
    iteration: number;
    attempt: number;
    state: string;
  } | null;
  provider_invoked: false;
  domain_idempotent: boolean;
  audit_event_id: string;
  idempotent_replay: boolean;
}

export class OperatorWorkflowApiError extends Error {
  readonly status: number;
  readonly errorCode: string | null;
  readonly auditEventId: string | null;

  constructor(status: number, message: string, errorCode: string | null, auditEventId: string | null) {
    super(message);
    this.name = 'OperatorWorkflowApiError';
    this.status = status;
    this.errorCode = errorCode;
    this.auditEventId = auditEventId;
  }
}

const REVIEW_REACTIVATION_REASONS = new Set([
  'workflow_review_decision_missing',
  'workflow_review_decision_evidence_unavailable',
]);

const ACTION_META: Record<WorkflowBrowserAction, WorkflowActionOption> = {
  retry: {
    action: 'retry',
    label: 'Retry stage',
    description: 'Retry a failed or needs-human stage only after durable terminal effect and workspace evidence are verified.',
    consequence: 'The current attempt is fenced and the stage returns to pending with its attempt incremented once. No provider is invoked by this request.',
    permission: 'workflow.recover',
    color: 'violet',
  },
  resume: {
    action: 'resume',
    label: 'Resume workflow',
    description: 'Resume a pending stage only when no current-attempt provider effect exists and any workspace remains at the exact input SHA.',
    consequence: 'The workflow returns to active while the same pending attempt remains available for the normal dispatcher. No provider is invoked by this request.',
    permission: 'workflow.recover',
    color: 'teal',
  },
  approve: {
    action: 'approve',
    label: 'Approve workflow',
    description: 'Record Berlin approval for one completed review stage.',
    consequence: 'The workflow is completed deterministically. This approval requires action-bound step-up confirmation and does not invoke Berlin again.',
    permission: 'workflow.approve',
    color: 'teal',
  },
  changes_requested: {
    action: 'changes_requested',
    label: 'Request changes',
    description: 'Record a Berlin changes-requested decision for one completed review stage.',
    consequence: 'At most one next-iteration Professor implementation stage is created in pending state, or the workflow is escalated at its iteration limit. No provider is invoked.',
    permission: 'workflow.approve',
    color: 'orange',
  },
};

export function createWorkflowActionIdempotencyKey(): string {
  const suffix = globalThis.crypto?.randomUUID?.()
    || `${Date.now()}-${Math.random().toString(36).slice(2, 12)}`;
  return `browser-workflow:${suffix}`;
}

export function deriveWorkflowStageActions(room: MissionRoom, stage: MissionRoomStage): WorkflowActionOption[] {
  const workflow = room.workflow;
  if (!workflow || !stage.child_id || stage.state === 'not_created') return [];

  const actions: WorkflowActionOption[] = [];
  const effectState = String(stage.provider_effect?.state || '');
  const workspaceState = String(stage.workspace?.state || '');

  if (
    workflow.state === 'needs_human'
    && ['needs_human', 'failed'].includes(stage.state)
    && ['failed', 'needs_human'].includes(effectState)
    && ['active', 'held_for_investigation'].includes(workspaceState)
  ) {
    actions.push(ACTION_META.retry);
  }

  if (
    workflow.state === 'needs_human'
    && stage.state === 'pending'
    && !stage.provider_effect
    && (!stage.workspace || workspaceState === 'active')
  ) {
    actions.push(ACTION_META.resume);
  }

  if (
    stage.stage === 'review'
    && stage.owner_agent === 'berlin'
    && stage.state === 'completed'
    && !stage.review_decision
    && (
      workflow.state === 'active'
      || (workflow.state === 'needs_human' && REVIEW_REACTIVATION_REASONS.has(String(workflow.last_error || '')))
    )
  ) {
    actions.push(ACTION_META.approve, ACTION_META.changes_requested);
  }

  return actions;
}

export function rolesAllowWorkflowAction(roles: readonly string[], action: WorkflowBrowserAction): boolean {
  if (roles.includes('administrator')) return true;
  const permission = ACTION_META[action].permission;
  if (permission === 'workflow.recover') return roles.includes('operator');
  return roles.includes('reviewer');
}

async function requestJson<T>(url: string, init: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...init,
    credentials: 'same-origin',
    headers: { Accept: 'application/json', ...init.headers },
  });
  const payload = await response.json().catch(() => ({})) as Record<string, unknown>;
  if (!response.ok) {
    throw new OperatorWorkflowApiError(
      response.status,
      String(payload.error || response.statusText || 'Workflow action failed'),
      payload.error_code ? String(payload.error_code) : null,
      payload.audit_event_id ? String(payload.audit_event_id) : null,
    );
  }
  return payload as T;
}

export const operatorWorkflowsApi = {
  act: ({
    workflowId,
    childId,
    expectedAttempt,
    action,
    reason,
    idempotencyKey,
    csrfToken,
  }: {
    workflowId: string;
    childId: string;
    expectedAttempt: number;
    action: WorkflowBrowserAction;
    reason: string;
    idempotencyKey: string;
    csrfToken: string;
  }) => {
    const routeAction = action === 'approve' || action === 'changes_requested' ? 'decision' : action;
    const path = `/api/operator/workflows/${encodeURIComponent(workflowId)}/children/${encodeURIComponent(childId)}/${routeAction}`;
    const permission = routeAction === 'decision' ? 'workflow.approve' : 'workflow.recover';
    const decision = action === 'approve' ? 'approved' : action;
    return requestJson<WorkflowActionResponse>(path, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Ops-Room-CSRF': csrfToken,
        ...(routeAction === 'decision'
          ? { 'X-Ops-Room-Confirmation': `confirm:${permission}:POST:${path}` }
          : {}),
      },
      body: JSON.stringify({
        reason,
        expected_attempt: expectedAttempt,
        idempotency_key: idempotencyKey,
        ...(routeAction === 'decision' ? { decision } : {}),
      }),
    });
  },
};
