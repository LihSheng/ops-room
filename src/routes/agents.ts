import { getAgentList } from '../services/agent-registry.js';
import { getAgentFleetWithMissionEvidence } from '../services/agent-fleet-missions.js';

export async function handleAgentsList() {
  const agents = await getAgentList();
  const fleet = await getAgentFleetWithMissionEvidence({ agents });
  return {
    agents,
    fleet: fleet.fleet,
    fleet_count: fleet.count,
    generated_at: fleet.generated_at,
    sources: fleet.sources,
  };
}
