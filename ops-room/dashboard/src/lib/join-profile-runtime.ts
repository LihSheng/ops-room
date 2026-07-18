// Delegates to the shared server-side module at
// src/services/agent-profile/profile-runtime-join.ts so the same production
// function is exercised by both server-side tests and the frontend dashboard.
import { joinProfileRuntime as joinGeneric } from '../../../src/services/agent-profile/profile-runtime-join';
import type { PublicAgentProfile } from '../api/agent-profiles';
import type { AgentInstance } from '../types';
import type { JoinedRow } from '../../../src/services/agent-profile/profile-runtime-join';

export type JoinedAgentRow = JoinedRow<PublicAgentProfile, AgentInstance>;

export function joinProfileRuntime(
  profiles: PublicAgentProfile[],
  instances: AgentInstance[],
): JoinedAgentRow[] {
  return joinGeneric(profiles, instances);
}
