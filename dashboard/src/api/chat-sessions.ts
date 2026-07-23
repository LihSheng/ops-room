export type ChatSessionType = 'direct' | 'mission';
export type ChatSessionState = 'open' | 'needs_human' | 'closed';
export type ChatSessionSourceState = 'available' | 'degraded' | 'unavailable';

export interface ChatSessionIndexItem {
  session_id: string;
  session_type: ChatSessionType;
  state: ChatSessionState;
  title: string;
  agent_id: string | null;
  mission_id: string | null;
  participant_ids: string[];
  turn_count: number;
  latest_turn: {
    turn_id: string;
    state: string;
    target_agent_id: string | null;
    error_code: string | null;
    updated_at: string | null;
  } | null;
  attention_required: boolean;
  attention_code: string | null;
  created_by: {
    actor_id: string;
    actor_type: string;
    actor_display_name: string;
  };
  created_at: string;
  updated_at: string;
  closed_at: string | null;
  links: {
    session_index: string;
    agent: string | null;
    mission: string | null;
    transcript: string;
  };
}

export interface ChatSessionIndexResponse {
  sessions: ChatSessionIndexItem[];
  count: number;
  total_matching: number;
  attention_count: number;
  sources: {
    direct_sessions: ChatSessionSourceState;
    mission_sessions: ChatSessionSourceState;
  };
  generated_at: string;
}

export interface ChatSessionFilters {
  type?: ChatSessionType | 'all';
  state?: ChatSessionState | 'all';
  attention?: boolean;
  agentId?: string;
  missionId?: string;
  limit?: number;
}

export interface ChatTranscriptActor {
  actor_id: string;
  actor_type: string;
  actor_display_name: string;
}

export interface ChatTranscriptTurn {
  turn_id: string;
  state: string;
  target_agent_id?: string;
  human_message: {
    role: 'human';
    content: string;
    actor: ChatTranscriptActor;
    created_at: string;
  };
  agent_message: {
    role: 'agent';
    agent_id?: string;
    content: string;
    created_at: string;
    provider: string;
    model: string;
  } | null;
  error_code: string | null;
  created_at: string;
  updated_at: string;
}

export interface ChatTranscriptSession {
  session_id: string;
  agent_id?: string;
  mission_id?: string;
  title: string;
  state: ChatSessionState;
  created_by: ChatTranscriptActor;
  created_at: string;
  updated_at: string;
  closed_at: string | null;
  last_error: string | null;
  turn_count: number;
  turns: ChatTranscriptTurn[];
}

function queryString(filters: ChatSessionFilters = {}) {
  const params = new URLSearchParams();
  if (filters.type && filters.type !== 'all') params.set('type', filters.type);
  if (filters.state && filters.state !== 'all') params.set('state', filters.state);
  if (filters.attention) params.set('attention', 'true');
  if (filters.agentId) params.set('agent_id', filters.agentId);
  if (filters.missionId) params.set('mission_id', filters.missionId);
  params.set('limit', String(Math.max(1, Math.min(filters.limit || 100, 200))));
  const encoded = params.toString();
  return encoded ? `?${encoded}` : '';
}

async function getJson<T>(url: string): Promise<T> {
  const response = await fetch(url, {
    credentials: 'same-origin',
    headers: { Accept: 'application/json' },
  });
  const payload = await response.json().catch(() => ({})) as Record<string, unknown>;
  if (!response.ok) {
    throw new Error(String(payload.error || response.statusText || 'Chat session request failed'));
  }
  return payload as T;
}

export const chatSessionsApi = {
  list: (filters: ChatSessionFilters = {}) => getJson<ChatSessionIndexResponse>(
    `/api/operator/chat-sessions${queryString(filters)}`,
  ),
  detail: (session: Pick<ChatSessionIndexItem, 'session_id' | 'session_type'>) => getJson<{ session: ChatTranscriptSession }>(
    session.session_type === 'direct'
      ? `/api/operator/chat-sessions/${encodeURIComponent(session.session_id)}`
      : `/api/operator/mission-chat-sessions/${encodeURIComponent(session.session_id)}`,
  ),
};
