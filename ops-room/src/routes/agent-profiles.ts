import { getAgentProfile, listAgentProfiles } from '../services/agent-profile/registry.js';
import { toPublicAgentProfile } from '../services/agent-profile/public-profile.js';
import { buildMemorySpaceCatalog, buildSkillCatalog } from '../services/agent-profile/catalogs.js';

const SAFE_AGENT_ID = /^[a-z][a-z0-9-]*$/;

export type ReadOnlyApiResult = { status: number; body: unknown };

export function handleReadOnlyAgentProfileApi(pathname: string): ReadOnlyApiResult | null {
  if (pathname === '/api/agents/profiles') {
    const profiles = listAgentProfiles()
      .slice()
      .sort((left, right) => left.id.localeCompare(right.id))
      .map(toPublicAgentProfile);
    return { status: 200, body: { profiles, count: profiles.length } };
  }

  const detailMatch = pathname.match(/^\/api\/agents\/profiles\/([^/]+)$/);
  if (detailMatch) {
    let id: string;
    try {
      id = decodeURIComponent(detailMatch[1]);
    } catch {
      return { status: 400, body: { error: 'invalid_agent_profile_id' } };
    }
    if (!SAFE_AGENT_ID.test(id)) {
      return { status: 400, body: { error: 'invalid_agent_profile_id', agent_id: id } };
    }
    const profile = getAgentProfile(id);
    if (!profile) {
      return { status: 404, body: { error: 'agent_profile_not_found', agent_id: id } };
    }
    return { status: 200, body: { profile: toPublicAgentProfile(profile) } };
  }

  if (pathname === '/api/skills') {
    const skills = buildSkillCatalog(listAgentProfiles());
    return { status: 200, body: { skills, count: skills.length } };
  }

  if (pathname === '/api/memory-spaces') {
    const memorySpaces = buildMemorySpaceCatalog(listAgentProfiles());
    return { status: 200, body: { memory_spaces: memorySpaces, count: memorySpaces.length } };
  }

  return null;
}
