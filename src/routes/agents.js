import { getAgentList } from '../services/agent-registry.js';
import { getAgentFleet } from '../services/agent-fleet.js';
export async function handleAgentsList() {
    const agents = await getAgentList();
    const fleet = await getAgentFleet({ agents });
    return {
        agents,
        fleet: fleet.fleet,
        fleet_count: fleet.count,
        generated_at: fleet.generated_at,
        sources: fleet.sources,
    };
}
//# sourceMappingURL=agents.js.map