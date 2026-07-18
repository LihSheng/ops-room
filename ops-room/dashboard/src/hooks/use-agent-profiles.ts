import { useQuery } from '@tanstack/react-query';
import { agentProfileApi, type ProfilesResponse } from '../api/agent-profiles';

export function useAgentProfiles() {
  return useQuery<ProfilesResponse>({
    queryKey: ['agent-profiles'],
    queryFn: () => agentProfileApi.list(),
    refetchInterval: 30_000,
  });
}
