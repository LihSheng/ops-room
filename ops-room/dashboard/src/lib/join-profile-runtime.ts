import type { PublicAgentProfile } from '../api/agent-profiles';
import type { AgentInstance } from '../types';

export interface JoinedAgentRow {
  id: string;
  profile: PublicAgentProfile | null;
  runtime: AgentInstance | null;
}

/**
 * Join profile policy and runtime data by agent ID.
 *
 * - Every runtime instance and every profile contributes a row.
 * - Rows are sorted deterministically by agent ID.
 * - Missing profile or runtime is represented as `null` in its field.
 */
export function joinProfileRuntime(
  profiles: PublicAgentProfile[],
  instances: AgentInstance[],
): JoinedAgentRow[] {
  const profileMap = new Map(profiles.map((p) => [p.id, p]));
  const instanceMap = new Map(instances.map((i) => [i.agent, i]));
  const allIds = new Set([
    ...instances.map((i) => i.agent),
    ...profiles.map((p) => p.id),
  ]);
  return [...allIds]
    .sort((a, b) => a.localeCompare(b))
    .map((id) => ({
      id,
      profile: profileMap.get(id) ?? null,
      runtime: instanceMap.get(id) ?? null,
    }));
}
