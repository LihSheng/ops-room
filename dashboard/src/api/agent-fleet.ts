export type AgentFleetState = 'offline' | 'idle' | 'working' | 'waiting' | 'paused' | 'needs_human' | 'unavailable';

export interface AgentFleetWorkspace {
  workspace_id: string;
  mode: string | null;
  state: string | null;
  repository_id: string | null;
  branch: string | null;
  resolved_sha: string | null;
  held_for_investigation: boolean;
  cleanup_requested: boolean;
}

export interface AgentFleetTask {
  task_id: string;
  title: string;
  status: string;
  repository: string | null;
  task_type: string | null;
  updated_at: string | null;
  workspace: AgentFleetWorkspace | null;
}

export interface AgentFleetItem {
  id: string;
  display_name: string;
  role: string | null;
  description: string | null;
  responsibility: string | null;
  state: AgentFleetState;
  attention: {
    required: boolean;
    reason_code: string | null;
    summary: string | null;
  };
  profile: {
    available: boolean;
    enabled: boolean;
    profile_version: string | null;
    runtime_backend: string | null;
  };
  runtime: {
    available: boolean;
    status: string;
    health: string | null;
    desired_state: string | null;
    lifecycle_state: string | null;
    convergence_status: string | null;
    restart_count: number;
  };
  current_task: AgentFleetTask | null;
  current_mission: null;
  repositories: string[];
  last_activity_at: string | null;
  links: {
    detail: string;
    logs: string;
    tasks: string;
  };
}

export interface AgentFleetResponse {
  fleet: AgentFleetItem[];
  fleet_count: number;
  generated_at: string;
  sources: {
    profiles: 'available' | 'unavailable';
    runtime: 'available' | 'unavailable';
    tasks: 'available' | 'unavailable';
    missions: 'deferred_to_ops_012c';
  };
}

async function getJson<T>(url: string): Promise<T> {
  const response = await fetch(url, {
    credentials: 'same-origin',
    headers: { Accept: 'application/json' },
  });
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
  return response.json() as Promise<T>;
}

export const agentFleetApi = {
  list: () => getJson<AgentFleetResponse>('/api/agents'),
};
