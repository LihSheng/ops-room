export interface MemorySpaceItem {
  key: string;
  readers: string[];
  writers: string[];
}

export interface MemorySpacesResponse {
  memory_spaces: MemorySpaceItem[];
  count: number;
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
};
