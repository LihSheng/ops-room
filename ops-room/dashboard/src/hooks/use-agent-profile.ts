import { useQuery } from '@tanstack/react-query';
import { agentProfileApi, type ProfileDetailResponse } from '../api/agent-profiles';

export function useAgentProfile(id: string | undefined) {
  return useQuery<ProfileDetailResponse>({
    queryKey: ['agent-profile', id],
    queryFn: () => agentProfileApi.detail(id!),
    enabled: Boolean(id),
    refetchInterval: 30_000,
  });
}
