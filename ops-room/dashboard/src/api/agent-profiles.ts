import type { PublicCompatibility, SkillRequirements } from './skills';

export interface ProfileSkillAssignment {
  key: string;
  version: string;
  resolution_status: 'resolved' | 'unresolved';
  compatibility: PublicCompatibility;
  requirements: SkillRequirements;
}

export interface PublicAgentProfile {
  id: string;
  display_name: string;
  schema_version: number;
  profile_version: string;
  mission: string;
  personality: {
    communication_style: string;
    decision_policy: string[];
    constraints: string[];
  };
  runtime: {
    backend: string;
  };
  skills: string[];
  skill_assignments: ProfileSkillAssignment[];
  memory: {
    read: string[];
    write: string[];
  };
  repositories: string[];
  enabled: boolean;
}

export interface ProfilesResponse {
  profiles: PublicAgentProfile[];
  count: number;
}

export interface ProfileDetailResponse {
  profile: PublicAgentProfile | null;
}

async function getJson<T>(url: string): Promise<T> {
  const response = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText}`);
  }
  return response.json() as Promise<T>;
}

export const agentProfileApi = {
  list: () => getJson<ProfilesResponse>('/api/agents/profiles'),
  detail: async (id: string): Promise<ProfileDetailResponse> => {
    const response = await fetch(`/api/agents/profiles/${encodeURIComponent(id)}`, {
      headers: { Accept: 'application/json' },
    });
    if (response.status === 404) {
      return { profile: null };
    }
    if (!response.ok) {
      throw new Error(`${response.status} ${response.statusText}`);
    }
    return response.json() as Promise<ProfileDetailResponse>;
  },
};
