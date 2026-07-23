import {
  listAgentChatSessions,
  validateAgentChatSession,
} from './agent-chat-store.js';
import {
  listMissionChatSessions,
  validateMissionChatSession,
} from './mission-chat-store.js';

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

export interface ChatSessionIndexResult {
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

export interface ChatSessionIndexFilters {
  sessionType?: ChatSessionType | 'all' | null;
  state?: ChatSessionState | 'all' | null;
  attentionOnly?: boolean;
  agentId?: string | null;
  missionId?: string | null;
  limit?: number;
}

function bounded(value: unknown, maximum: number) {
  return String(value ?? '').trim().slice(0, maximum);
}

function publicActor(actor: any) {
  return {
    actor_id: bounded(actor?.actor_id, 200),
    actor_type: bounded(actor?.actor_type, 80),
    actor_display_name: bounded(actor?.actor_display_name || actor?.actor_id, 160),
  };
}

function directSummary(record: any): ChatSessionIndexItem {
  const session = validateAgentChatSession(record);
  const latest = session.turns.at(-1) || null;
  const sessionId = String(session.session_id);
  const agentId = String(session.agent_id);
  return {
    session_id: sessionId,
    session_type: 'direct',
    state: session.state,
    title: bounded(session.title, 160),
    agent_id: agentId,
    mission_id: null,
    participant_ids: [agentId],
    turn_count: session.turns.length,
    latest_turn: latest ? {
      turn_id: String(latest.turn_id),
      state: String(latest.state),
      target_agent_id: agentId,
      error_code: latest.error_code ? bounded(latest.error_code, 120) : null,
      updated_at: latest.updated_at ? String(latest.updated_at) : null,
    } : null,
    attention_required: session.state === 'needs_human',
    attention_code: session.state === 'needs_human'
      ? bounded(latest?.error_code || session.last_error || 'agent_chat_needs_human', 120)
      : null,
    created_by: publicActor(session.created_by),
    created_at: String(session.created_at),
    updated_at: String(session.updated_at),
    closed_at: session.closed_at ? String(session.closed_at) : null,
    links: {
      session_index: `/chat-sessions?session=${encodeURIComponent(sessionId)}`,
      agent: `/agents/${encodeURIComponent(agentId)}?chat_session=${encodeURIComponent(sessionId)}#agent-chat`,
      mission: null,
      transcript: `/agents/${encodeURIComponent(agentId)}?chat_session=${encodeURIComponent(sessionId)}#agent-chat`,
    },
  };
}

function missionSummary(record: any): ChatSessionIndexItem {
  const session = validateMissionChatSession(record);
  const latest = session.turns.at(-1) || null;
  const sessionId = String(session.session_id);
  const missionId = String(session.mission_id);
  return {
    session_id: sessionId,
    session_type: 'mission',
    state: session.state,
    title: bounded(session.title, 160),
    agent_id: latest?.target_agent_id ? String(latest.target_agent_id) : null,
    mission_id: missionId,
    participant_ids: session.participants.map((participant: any) => String(participant.agent_id)),
    turn_count: session.turns.length,
    latest_turn: latest ? {
      turn_id: String(latest.turn_id),
      state: String(latest.state),
      target_agent_id: latest.target_agent_id ? String(latest.target_agent_id) : null,
      error_code: latest.error_code ? bounded(latest.error_code, 120) : null,
      updated_at: latest.updated_at ? String(latest.updated_at) : null,
    } : null,
    attention_required: session.state === 'needs_human',
    attention_code: session.state === 'needs_human'
      ? bounded(latest?.error_code || session.last_error || 'mission_chat_needs_human', 120)
      : null,
    created_by: publicActor(session.created_by),
    created_at: String(session.created_at),
    updated_at: String(session.updated_at),
    closed_at: session.closed_at ? String(session.closed_at) : null,
    links: {
      session_index: `/chat-sessions?session=${encodeURIComponent(sessionId)}`,
      agent: latest?.target_agent_id ? `/agents/${encodeURIComponent(String(latest.target_agent_id))}` : null,
      mission: `/missions/${encodeURIComponent(missionId)}?chat_session=${encodeURIComponent(sessionId)}#mission-participant-chat`,
      transcript: `/missions/${encodeURIComponent(missionId)}?chat_session=${encodeURIComponent(sessionId)}#mission-participant-chat`,
    },
  };
}

function normalizedLimit(value: unknown) {
  const limit = Number(value);
  if (!Number.isFinite(limit)) return 100;
  return Math.max(1, Math.min(Math.trunc(limit), 200));
}

function matches(item: ChatSessionIndexItem, filters: ChatSessionIndexFilters) {
  if (filters.sessionType && filters.sessionType !== 'all' && item.session_type !== filters.sessionType) return false;
  if (filters.state && filters.state !== 'all' && item.state !== filters.state) return false;
  if (filters.attentionOnly && !item.attention_required) return false;
  if (filters.agentId) {
    const agentId = bounded(filters.agentId, 200);
    if (item.agent_id !== agentId && !item.participant_ids.includes(agentId)) return false;
  }
  if (filters.missionId && item.mission_id !== bounded(filters.missionId, 200)) return false;
  return true;
}

export async function buildChatSessionIndex({
  directDir,
  missionDir,
  filters = {},
  now = () => new Date().toISOString(),
}: {
  directDir: string;
  missionDir: string;
  filters?: ChatSessionIndexFilters;
  now?: () => string;
}): Promise<ChatSessionIndexResult> {
  const sources: ChatSessionIndexResult['sources'] = {
    direct_sessions: 'available',
    mission_sessions: 'available',
  };
  const combined: ChatSessionIndexItem[] = [];

  try {
    const direct = await listAgentChatSessions({ dir: directDir, limit: 100 });
    for (const record of direct) {
      try {
        combined.push(directSummary(record));
      } catch {
        sources.direct_sessions = 'degraded';
      }
    }
  } catch {
    sources.direct_sessions = 'unavailable';
  }

  try {
    const mission = await listMissionChatSessions({ dir: missionDir, limit: 500 });
    for (const record of mission) {
      try {
        combined.push(missionSummary(record));
      } catch {
        sources.mission_sessions = 'degraded';
      }
    }
  } catch {
    sources.mission_sessions = 'unavailable';
  }

  const matching = combined
    .filter((item) => matches(item, filters))
    .sort((left, right) => (
      String(right.updated_at).localeCompare(String(left.updated_at))
      || left.session_id.localeCompare(right.session_id)
    ));
  const limit = normalizedLimit(filters.limit);
  const sessions = matching.slice(0, limit);

  return {
    sessions,
    count: sessions.length,
    total_matching: matching.length,
    attention_count: matching.filter((item) => item.attention_required).length,
    sources,
    generated_at: now(),
  };
}

export { directSummary as serializeDirectChatSessionSummary, missionSummary as serializeMissionChatSessionSummary };
