import { useQuery } from '@tanstack/react-query';
import { memorySpacesApi, type MemorySpacesResponse } from '../api/memory-spaces';

export function useMemorySpaces() {
  return useQuery<MemorySpacesResponse>({
    queryKey: ['memory-spaces'],
    queryFn: () => memorySpacesApi.list(),
    refetchInterval: 30_000,
  });
}
