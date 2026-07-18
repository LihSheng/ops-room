export interface SkillCatalogItem {
  key: string;
  agents: string[];
}

export interface SkillsCatalogResponse {
  skills: SkillCatalogItem[];
  count: number;
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
};
