import type { MissionRoom, MissionRoomStage } from './missions';

export type InvestigationBrowserAction =
  | 'effect_safe_to_retry'
  | 'effect_completed'
  | 'workspace_hold'
  | 'workspace_release'
  | 'workspace_cleanup';

export interface InvestigationActionOption {
  action: InvestigationBrowserAction;
  label: string;
  description: string;
  consequence: string;
  color: string;
  requiresOutput: boolean;
  requiresResultCode: boolean;
}

export interface InvestigationActionResponse {
  operation: string;
  resolution?: string;
  effect?: {
    effect_id: string;
    workflow_id: string;
    child_id: string;
    state: string;
    result_code: string | null;
    output_sha: string | null;
    updated_at: string;
  };
  workspace: {
    workspace_id: string;
    state: string;
    hold_reason?: string | null;
    resolved_sha: string | null;
  };
  provider_invoked: false;
  uncertain_effect_replayed?: false;
  cleanup_executed?: false;
  domain_idempotent?: boolean;
  audit_event_id: string;
  idempotent_replay: boolean;
}

export class OperatorInvestigationApiError extends Error {
  readonly status: number;
  readonly errorCode: string | null;
  readonly auditEventId: string | null;

  constructor(status: number, message: string, errorCode: string | null, auditEventId: string | null) {
    super(message);
    this.name = 'OperatorInvestigationApiError';
    this.status = status;
    this.errorCode = errorCode;
    this.auditEventId = auditEventId;
  }
}

const ACTION_META: Record<InvestigationBrowserAction, InvestigationActionOption> = {
  effect_safe_to_retry: {
    action: 'effect_safe_to_retry',
    label: 'Verify safe to retry',
    description: 'Resolve a needs-human provider effect only after the workspace has been restored to the exact stage input SHA.',
    consequence: 'The effect is recorded as failed with operator-verified safe-to-retry evidence. No provider is invoked and no retry is started by this request.',
    color: 'violet',
    requiresOutput: false,
    requiresResultCode: false,
  },
  effect_completed: {
    action: 'effect_completed',
    label: 'Verify completed effect',
    description: 'Resolve a needs-human provider effect as completed only when the exact workspace HEAD and bounded result evidence are known.',
    consequence: 'The durable effect becomes completed at the verified output SHA. The provider is not replayed; normal reconciliation may then recover the workflow child.',
    color: 'teal',
    requiresOutput: true,
    requiresResultCode: true,
  },
  workspace_hold: {
    action: 'workspace_hold',
    label: 'Hold for investigation',
    description: 'Place this exact workspace record on an investigation hold.',
    consequence: 'The workspace remains preserved and cannot proceed through cleanup while held. No files are deleted.',
    color: 'orange',
    requiresOutput: false,
    requiresResultCode: false,
  },
  workspace_release: {
    action: 'workspace_release',
    label: 'Release investigation hold',
    description: 'Release a held workspace only after the server verifies its actual HEAD against the authoritative child SHA.',
    consequence: 'The workspace record returns to active. This request does not resume the workflow or invoke a provider.',
    color: 'teal',
    requiresOutput: false,
    requiresResultCode: false,
  },
  workspace_cleanup: {
    action: 'workspace_cleanup',
    label: 'Request cleanup',
    description: 'Request cleanup for a terminal child or workflow after unresolved effects have been cleared.',
    consequence: 'Only the durable workspace state changes to cleanup requested. The browser request never deletes the worktree.',
    color: 'red',
    requiresOutput: false,
    requiresResultCode: false,
  },
};

export function createInvestigationIdempotencyKey(): string {
  const suffix = globalThis.crypto?.randomUUID?.()
    || `${Date.now()}-${Math.random().toString(36).slice(2, 12)}`;
  return `browser-investigation:${suffix}`;
}

export function deriveInvestigationActions(room: MissionRoom, stage: MissionRoomStage): InvestigationActionOption[] {
  if (!room.workflow || !stage.child_id || stage.state === 'not_created') return [];
  const actions: InvestigationActionOption[] = [];
  const effectState = String(stage.provider_effect?.state || '');
  const workspaceState = String(stage.workspace?.state || '');

  if (
    stage.provider_effect
    && effectState === 'needs_human'
    && stage.workspace
    && ['active', 'held_for_investigation'].includes(workspaceState)
  ) {
    actions.push(ACTION_META.effect_safe_to_retry, ACTION_META.effect_completed);
  }

  if (stage.workspace && ['active', 'failed', 'cleanup_requested'].includes(workspaceState)) {
    actions.push(ACTION_META.workspace_hold);
  }

  const authoritativeSha = stage.state === 'completed' && stage.output_sha ? stage.output_sha : stage.input_sha;
  if (
    stage.workspace
    && workspaceState === 'held_for_investigation'
    && authoritativeSha
    && (!stage.workspace.resolved_sha || stage.workspace.resolved_sha === authoritativeSha)
  ) {
    actions.push(ACTION_META.workspace_release);
  }

  const targetTerminal = ['completed', 'cancelled'].includes(stage.state)
    || ['completed', 'cancelled'].includes(String(room.workflow.state || ''));
  const effectUnresolved = ['claimed', 'needs_human'].includes(effectState);
  if (
    stage.workspace
    && targetTerminal
    && !effectUnresolved
    && ['active', 'failed', 'held_for_investigation'].includes(workspaceState)
  ) {
    actions.push(ACTION_META.workspace_cleanup);
  }

  return actions;
}

export function rolesAllowInvestigationAction(roles: readonly string[]): boolean {
  return roles.includes('administrator') || roles.includes('operator');
}

async function requestJson<T>(url: string, init: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...init,
    credentials: 'same-origin',
    headers: { Accept: 'application/json', ...init.headers },
  });
  const payload = await response.json().catch(() => ({})) as Record<string, unknown>;
  if (!response.ok) {
    throw new OperatorInvestigationApiError(
      response.status,
      String(payload.error || response.statusText || 'Investigation action failed'),
      payload.error_code ? String(payload.error_code) : null,
      payload.audit_event_id ? String(payload.audit_event_id) : null,
    );
  }
  return payload as T;
}

export const operatorInvestigationsApi = {
  act: ({
    workflowId,
    childId,
    effectId,
    workspaceId,
    expectedAttempt,
    expectedState,
    expectedHeadSha,
    action,
    reason,
    idempotencyKey,
    csrfToken,
    outputSha,
    resultCode,
  }: {
    workflowId: string;
    childId: string;
    effectId?: string | null;
    workspaceId?: string | null;
    expectedAttempt: number;
    expectedState?: string | null;
    expectedHeadSha?: string | null;
    action: InvestigationBrowserAction;
    reason: string;
    idempotencyKey: string;
    csrfToken: string;
    outputSha?: string | null;
    resultCode?: string | null;
  }) => {
    const base = `/api/operator/workflows/${encodeURIComponent(workflowId)}/children/${encodeURIComponent(childId)}`;
    const isEffect = action === 'effect_safe_to_retry' || action === 'effect_completed';
    const path = isEffect
      ? `${base}/effects/${encodeURIComponent(String(effectId || ''))}/resolve`
      : `${base}/workspaces/${encodeURIComponent(String(workspaceId || ''))}/${action.replace('workspace_', '')}`;
    return requestJson<InvestigationActionResponse>(path, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Ops-Room-CSRF': csrfToken,
      },
      body: JSON.stringify({
        reason,
        expected_attempt: expectedAttempt,
        idempotency_key: idempotencyKey,
        ...(isEffect ? {
          resolution: action === 'effect_completed' ? 'completed' : 'safe_to_retry',
          ...(outputSha ? { output_sha: outputSha } : {}),
          ...(resultCode ? { result_code: resultCode } : {}),
        } : {
          expected_state: expectedState,
          ...(action === 'workspace_release' && expectedHeadSha ? { expected_head_sha: expectedHeadSha } : {}),
        }),
      }),
    });
  },
};
