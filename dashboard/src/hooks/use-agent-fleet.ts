import { useQuery } from '@tanstack/react-query';

import { agentFleetApi } from '../api/agent-fleet';

export function useAgentFleet() {
  return useQuery({
    queryKey: ['agent-fleet'],
    queryFn: () => agentFleetApi.list(),
    refetchInterval: 10_000,
  });
}
