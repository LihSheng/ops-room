export type MissionChatSessionState = 'open' | 'needs_human' | 'closed';
export type MissionChatTurnState = 'provider_pending' | 'completed' | 'needs_human';

export interface MissionChatActor {
  actor_id: string;
  actor_type: string;
  actor_display_name: string;
}

export interface MissionChatParticipant {
  agent_id: string;
  roles: string[];
}

export interface MissionChatTurn {
  turn_id: string;
  target_agent_id: string;
  target_roles: string[];
  state: MissionChatTurnState;
  human_message: {
    role: 'human';
    content: string;
    actor: MissionChatActor;
    created_at: string;
  };
  agent_message: {
    role: 'agent';
    agent_id: string;
    content: string;
    created_at: string;
    provider: string;
    model: string;
  } | null;
  error_code: string | null;
  created_at: string;
  updated_at: string;
}

export interface MissionChatSession {
  session_id: string;
  mission_id: string;
  title: string;
  state: MissionChatSessionState;
  participants: MissionChatParticipant[];
  created_by: MissionChatActor;
  created_at: string;
  updated_at: string;
  closed_at: string | null;
  last_error: string | null;
  turn_count: number;
  turns: MissionChatTurn[];
}

export interface MissionChatReadResponse {
  mission_id: string;
  mission_state: string;
  can_mutate: boolean;
  session: MissionChatSession | null;
}

export interface MissionChatMutationResponse {
  session: MissionChatSession;
  domain_idempotent: boolean;
  provider_invoked: boolean;
  audit_event_id: string;
}

export interface MissionChatMessageResponse extends MissionChatMutationResponse {
  turn: MissionChatTurn;
}

export class MissionChatApiError extends Error {
  readonly status: number;
  readonly errorCode: string | null;
  readonly auditEventId: string | null;

  constructor(status: number, message: string, errorCode: string | null, auditEventId: string | null) {
    super(message);
    this.name = 'MissionChatApiError';
    this.status = status;
    this.errorCode = errorCode;
    this.auditEventId = auditEventId;
  }
}

export function createMissionChatIdempotencyKey() {
  const suffix = globalThis.crypto?.randomUUID?.()
    || `${Date.now()}-${Math.random().toString(36).slice(2, 12)}`;
  return `browser-mission-chat:${suffix}`;
}

async function requestJson<T>(url: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(url, {
    ...init,
    credentials: 'same-origin',
    headers: { Accept: 'application/json', ...init.headers },
  });
  const payload = await response.json().catch(() => ({})) as Record<string, unknown>;
  if (!response.ok) {
    throw new MissionChatApiError(
      response.status,
      String(payload.error || response.statusText || 'Mission chat request failed'),
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

export const missionChatApi = {
  getForMission: (missionId: string) => requestJson<MissionChatReadResponse>(
    `/api/operator/missions/${encodeURIComponent(missionId)}/participant-chat`,
  ),
  detail: (sessionId: string) => requestJson<MissionChatReadResponse>(
    `/api/operator/mission-chat-sessions/${encodeURIComponent(sessionId)}`,
  ),
  create: ({ missionId, reason, idempotencyKey, csrfToken }: {
    missionId: string;
    reason: string;
    idempotencyKey: string;
    csrfToken: string;
  }) => requestJson<MissionChatMutationResponse>(
    `/api/operator/missions/${encodeURIComponent(missionId)}/participant-chat`,
    {
      method: 'POST',
      headers: mutationHeaders(csrfToken),
      body: JSON.stringify({ reason, idempotency_key: idempotencyKey }),
    },
  ),
  send: ({ sessionId, targetAgentId, content, idempotencyKey, csrfToken }: {
    sessionId: string;
    targetAgentId: string;
    content: string;
    idempotencyKey: string;
    csrfToken: string;
  }) => requestJson<MissionChatMessageResponse>(
    `/api/operator/mission-chat-sessions/${encodeURIComponent(sessionId)}/messages`,
    {
      method: 'POST',
      headers: mutationHeaders(csrfToken),
      body: JSON.stringify({
        target_agent_id: targetAgentId,
        content,
        idempotency_key: idempotencyKey,
      }),
    },
  ),
  close: ({ sessionId, reason, idempotencyKey, csrfToken }: {
    sessionId: string;
    reason: string;
    idempotencyKey: string;
    csrfToken: string;
  }) => requestJson<MissionChatMutationResponse>(
    `/api/operator/mission-chat-sessions/${encodeURIComponent(sessionId)}/close`,
    {
      method: 'POST',
      headers: mutationHeaders(csrfToken),
      body: JSON.stringify({ reason, idempotency_key: idempotencyKey }),
    },
  ),
};
