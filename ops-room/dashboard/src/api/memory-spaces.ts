export interface MemorySpaceItem {
  key: string;
  version: string;
  display_name: string;
  description: string;
  kind: 'project' | 'shared' | 'private-agent' | 'archive';
  publication_path: string;
  parent_key: string | null;
  owner_agent: string | null;
  write_policy: 'read-only' | 'review-required';
  provenance: {
    required_fields: string[];
    review_required: boolean;
  };
  readers: string[];
  writers: string[];
  assignment_count: number;
}

export interface MemorySpacesResponse {
  memory_spaces: MemorySpaceItem[];
  count: number;
}

export interface MemorySpaceDetailResponse {
  memory_space: MemorySpaceItem;
}

async function getJson<T>(url: string): Promise<T> {
  const response = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText}`);
  }
  return response.json() as Promise<T>;
}

export const memorySpacesApi = {
  list: () => getJson<MemorySpacesResponse>('/api/memory-spaces'),
  detail: (key: string) => getJson<MemorySpaceDetailResponse>(`/api/memory-spaces/${encodeURIComponent(key)}`),
};
