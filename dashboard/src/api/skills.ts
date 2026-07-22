export type CompatibilityStatus = 'compatible' | 'incompatible' | 'unknown';
export type RequirementStatus = 'present' | 'missing' | 'unknown';

export interface CompatibilityReason {
  code: string;
  subject?: string;
  message: string;
}

export interface PublicCompatibility {
  status: CompatibilityStatus;
  reasons: CompatibilityReason[];
}

export interface SkillRequirements {
  commands: { name: string; status: RequirementStatus }[];
  credentials: { reference: string; status: RequirementStatus }[];
}

export interface SkillAssignment {
  key: string;
  version: string;
  agent_id: string;
  runtime_backend: string;
  resolution_status: 'resolved' | 'unresolved';
  compatibility: PublicCompatibility;
  requirements: SkillRequirements;
}

export interface SkillCatalogItem {
  key: string;
  version: string;
  description: string;
  agents: string[];
  supported_runtimes: string[];
  required_commands: string[];
  required_credentials: string[];
  permissions: string[];
  compatibility_summary: {
    compatible: number;
    incompatible: number;
    unknown: number;
  };
}

export interface SkillDetail extends SkillCatalogItem {
  assignments: SkillAssignment[];
}

export interface SkillsCatalogResponse {
  skills: SkillCatalogItem[];
  count: number;
}

export interface SkillDetailResponse {
  skill: SkillDetail | null;
}

async function getJson<T>(url: string): Promise<T> {
  const response = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText}`);
  }
  return response.json() as Promise<T>;
}

export const skillsApi = {
  list: () => getJson<SkillsCatalogResponse>('/api/skills'),
  detail: async (key: string, version: string): Promise<SkillDetailResponse> => {
    const response = await fetch(`/api/skills/${encodeURIComponent(key)}/${encodeURIComponent(version)}`, {
      headers: { Accept: 'application/json' },
    });
    if (response.status === 404) return { skill: null };
    if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
    return response.json() as Promise<SkillDetailResponse>;
  },
};
