import { getAgentList } from '../services/agent-registry.mjs';

export async function handleAgentsList() {
  const agents = await getAgentList();
  return { agents };
}
