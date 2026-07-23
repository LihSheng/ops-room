export type AgentChatSessionState = 'open' | 'needs_human' | 'closed';
export type AgentChatTurnState = 'provider_pending' | 'completed' | 'needs_human';

export interface AgentChatActor {
  actor_id: string;
  actor_type: string;
  actor_display_name: string;
}

export interface AgentChatTurn {
  turn_id: string;
  state: AgentChatTurnState;
  human_message: {
    role: 'human';
    content: string;
    actor: AgentChatActor;
    created_at: string;
  };
  agent_message: {
    role: 'agent';
    content: string;
    created_at: string;
    provider: string;
    model: string;
  } | null;
  error_code: string | null;
  created_at: string;
  updated_at: string;
}

export interface AgentChatSession {
  session_id: string;
  agent_id: string;
  title: string;
  state: AgentChatSessionState;
  created_by: AgentChatActor;
  created_at: string;
  updated_at: string;
  closed_at: string | null;
  last_error: string | null;
  turn_count: number;
  turns: AgentChatTurn[];
}

export interface AgentChatSessionsResponse {
  agent_id: string;
  sessions: AgentChatSession[];
  count: number;
}

export interface AgentChatSessionResponse {
  session: AgentChatSession;
  domain_idempotent?: boolean;
  provider_invoked?: boolean;
  audit_event_id?: string;
}

export interface AgentChatMessageResponse extends AgentChatSessionResponse {
  turn: AgentChatTurn;
}

export class OperatorAgentChatApiError extends Error {
  readonly status: number;
  readonly errorCode: string | null;
  readonly auditEventId: string | null;

  constructor(status: number, message: string, errorCode: string | null, auditEventId: string | null) {
    super(message);
    this.name = 'OperatorAgentChatApiError';
    this.status = status;
    this.errorCode = errorCode;
    this.auditEventId = auditEventId;
  }
}

export function createAgentChatIdempotencyKey(): string {
  const suffix = globalThis.crypto?.randomUUID?.()
    || `${Date.now()}-${Math.random().toString(36).slice(2, 12)}`;
  return `browser-agent-chat:${suffix}`;
}

async function requestJson<T>(url: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(url, {
    ...init,
    credentials: 'same-origin',
    headers: { Accept: 'application/json', ...init.headers },
  });
  const payload = await response.json().catch(() => ({})) as Record<string, unknown>;
  if (!response.ok) {
    throw new OperatorAgentChatApiError(
      response.status,
      String(payload.error || response.statusText || 'Agent chat request failed'),
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

export const agentChatApi = {
  list: (agentId: string) => requestJson<AgentChatSessionsResponse>(
    `/api/operator/agents/${encodeURIComponent(agentId)}/chat-sessions?limit=50`,
  ),
  detail: (sessionId: string) => requestJson<AgentChatSessionResponse>(
    `/api/operator/chat-sessions/${encodeURIComponent(sessionId)}`,
  ),
  create: ({
    agentId,
    title,
    reason,
    idempotencyKey,
    csrfToken,
  }: {
    agentId: string;
    title: string;
    reason: string;
    idempotencyKey: string;
    csrfToken: string;
  }) => requestJson<AgentChatSessionResponse>(
    `/api/operator/agents/${encodeURIComponent(agentId)}/chat-sessions`,
    {
      method: 'POST',
      headers: mutationHeaders(csrfToken),
      body: JSON.stringify({ title, reason, idempotency_key: idempotencyKey }),
    },
  ),
  send: ({
    sessionId,
    content,
    idempotencyKey,
    csrfToken,
  }: {
    sessionId: string;
    content: string;
    idempotencyKey: string;
    csrfToken: string;
  }) => requestJson<AgentChatMessageResponse>(
    `/api/operator/chat-sessions/${encodeURIComponent(sessionId)}/messages`,
    {
      method: 'POST',
      headers: mutationHeaders(csrfToken),
      body: JSON.stringify({ content, idempotency_key: idempotencyKey }),
    },
  ),
  close: ({
    sessionId,
    reason,
    idempotencyKey,
    csrfToken,
  }: {
    sessionId: string;
    reason: string;
    idempotencyKey: string;
    csrfToken: string;
  }) => requestJson<AgentChatSessionResponse>(
    `/api/operator/chat-sessions/${encodeURIComponent(sessionId)}/close`,
    {
      method: 'POST',
      headers: mutationHeaders(csrfToken),
      body: JSON.stringify({ reason, idempotency_key: idempotencyKey }),
    },
  ),
};
