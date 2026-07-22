import { getAgentProfile, listAgentProfiles } from '../services/agent-profile/registry.js';
import { toPublicAgentProfile } from '../services/agent-profile/public-profile.js';
import { getSkillAssignmentsForAgent, getSkillManifest, listSkillAssignments, listSkillManifests, } from '../services/skill-registry/registry.js';
import { buildPublicSkillCatalog, toPublicProfileSkillAssignments, toPublicSkillDetail, } from '../services/skill-registry/public-skill.js';
import { isValidSemanticVersion, SKILL_KEY_PATTERN } from '../services/skill-registry/schema.js';
import { getMemoryAssignmentsForAgent, getMemorySpaceManifest, listMemoryAssignments, listMemorySpaceManifests, } from '../services/memory-space-registry/registry.js';
import { buildPublicMemorySpaceCatalog, toPublicMemorySpace, toPublicProfileMemoryAssignments, } from '../services/memory-space-registry/public-memory-space.js';
import { MEMORY_SPACE_KEY_PATTERN } from '../services/memory-space-registry/schema.js';
const SAFE_AGENT_ID = /^[a-z][a-z0-9-]*$/;
function publicProfile(profile) {
    return {
        ...toPublicAgentProfile(profile),
        skill_assignments: toPublicProfileSkillAssignments(profile, getSkillAssignmentsForAgent(profile.id)),
        memory_assignments: toPublicProfileMemoryAssignments(profile, getMemoryAssignmentsForAgent(profile.id)),
    };
}
function decodeRouteValue(value) {
    try {
        return decodeURIComponent(value);
    }
    catch {
        return null;
    }
}
export function handleReadOnlyAgentProfileApi(pathname) {
    if (pathname === '/api/agents/profiles') {
        const profiles = listAgentProfiles()
            .slice()
            .sort((left, right) => left.id.localeCompare(right.id))
            .map(publicProfile);
        return { status: 200, body: { profiles, count: profiles.length } };
    }
    const profileDetailMatch = pathname.match(/^\/api\/agents\/profiles\/([^/]+)$/);
    if (profileDetailMatch) {
        const id = decodeRouteValue(profileDetailMatch[1]);
        if (id === null)
            return { status: 400, body: { error: 'invalid_agent_profile_id' } };
        if (!SAFE_AGENT_ID.test(id)) {
            return { status: 400, body: { error: 'invalid_agent_profile_id', agent_id: id } };
        }
        const profile = getAgentProfile(id);
        if (!profile) {
            return { status: 404, body: { error: 'agent_profile_not_found', agent_id: id } };
        }
        return { status: 200, body: { profile: publicProfile(profile) } };
    }
    if (pathname === '/api/skills') {
        const skills = buildPublicSkillCatalog(listSkillManifests(), listSkillAssignments());
        return { status: 200, body: { skills, count: skills.length } };
    }
    const skillDetailMatch = pathname.match(/^\/api\/skills\/([^/]+)\/([^/]+)$/);
    if (skillDetailMatch) {
        const key = decodeRouteValue(skillDetailMatch[1]);
        const version = decodeRouteValue(skillDetailMatch[2]);
        if (key === null || version === null || !SKILL_KEY_PATTERN.test(key) || !isValidSemanticVersion(version)) {
            return { status: 400, body: { error: 'invalid_skill_identifier' } };
        }
        const manifest = getSkillManifest(key, version);
        if (!manifest)
            return { status: 404, body: { error: 'skill_not_found', key, version } };
        return { status: 200, body: { skill: toPublicSkillDetail(manifest, listSkillAssignments()) } };
    }
    if (pathname === '/api/memory-spaces') {
        const memorySpaces = buildPublicMemorySpaceCatalog(listMemorySpaceManifests(), listMemoryAssignments());
        return { status: 200, body: { memory_spaces: memorySpaces, count: memorySpaces.length } };
    }
    const memoryDetailMatch = pathname.match(/^\/api\/memory-spaces\/([^/]+)$/);
    if (memoryDetailMatch) {
        const key = decodeRouteValue(memoryDetailMatch[1]);
        if (key === null || !MEMORY_SPACE_KEY_PATTERN.test(key)) {
            return { status: 400, body: { error: 'invalid_memory_space_key' } };
        }
        const manifest = getMemorySpaceManifest(key);
        if (!manifest)
            return { status: 404, body: { error: 'memory_space_not_found', key } };
        return { status: 200, body: { memory_space: toPublicMemorySpace(manifest, listMemoryAssignments()) } };
    }
    return null;
}
//# sourceMappingURL=agent-profiles.js.map