import { getAgentList } from '../services/agent-registry.js';

export async function handleAgentsList() {
  const agents = await getAgentList();
  return { agents };
}
