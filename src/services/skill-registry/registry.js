import { commandExists } from '../../workflows/github-code.js';
import { listAgentProfiles } from '../agent-profile/registry.js';
import { SKILL_MANIFESTS_DIR } from '../runtime-paths.js';
import { createCredentialReferenceResolver } from './credential-references.js';
import { loadSkillManifests } from './loader.js';
import { resolveSkillAssignments, skillManifestId } from './resolver.js';
let manifests = new Map();
let assignments = [];
let initializedAt = null;
function cloneManifest(manifest) {
    return {
        ...manifest,
        supportedRuntimes: [...manifest.supportedRuntimes],
        requiredCommands: [...manifest.requiredCommands],
        requiredCredentials: [...manifest.requiredCredentials],
        permissions: [...manifest.permissions],
    };
}
function cloneAssignment(assignment) {
    return {
        ...assignment,
        manifest: assignment.manifest ? cloneManifest(assignment.manifest) : null,
        compatibility: {
            status: assignment.compatibility.status,
            reasons: assignment.compatibility.reasons.map((reason) => ({ ...reason })),
            requirements: {
                commands: assignment.compatibility.requirements.commands.map((item) => ({ ...item })),
                credentials: assignment.compatibility.requirements.credentials.map((item) => ({ ...item })),
            },
        },
    };
}
export async function initializeSkillRegistry({ dir = SKILL_MANIFESTS_DIR, profiles = listAgentProfiles(), commandExistsFn = commandExists, env = process.env, } = {}) {
    const loaded = await loadSkillManifests(dir);
    const nextManifests = new Map(loaded.manifests.map((manifest) => [skillManifestId(manifest.key, manifest.version), cloneManifest(manifest)]));
    const commands = [...new Set(loaded.manifests.flatMap((manifest) => manifest.requiredCommands))].sort();
    let commandPresence = {};
    try {
        commandPresence = Object.fromEntries(await Promise.all(commands.map(async (name) => [name, await commandExistsFn(name)])));
    }
    catch {
        commandPresence = null;
    }
    const credentialResolver = createCredentialReferenceResolver(env);
    const nextAssignments = resolveSkillAssignments({
        profiles,
        manifests: nextManifests,
        commandPresence,
        credentialResolver,
    });
    manifests = nextManifests;
    assignments = nextAssignments;
    initializedAt = new Date().toISOString();
    return getSkillRegistryStatus();
}
export function getSkillManifest(key, version) {
    const manifest = manifests.get(skillManifestId(key, version));
    return manifest ? cloneManifest(manifest) : null;
}
export function listSkillManifests() {
    return [...manifests.values()]
        .sort((left, right) => left.key.localeCompare(right.key) || left.version.localeCompare(right.version))
        .map(cloneManifest);
}
export function listSkillAssignments() {
    return assignments.map(cloneAssignment);
}
export function getSkillAssignmentsForAgent(agentId) {
    return assignments.filter((assignment) => assignment.agentId === agentId).map(cloneAssignment);
}
export function getSkillRegistryStatus() {
    const summary = { compatible: 0, incompatible: 0, unknown: 0 };
    for (const assignment of assignments)
        summary[assignment.compatibility.status] += 1;
    return {
        status: manifests.size > 0 ? 'ready' : 'error',
        required: true,
        manifest_count: manifests.size,
        assignment_count: assignments.length,
        compatible_assignments: summary.compatible,
        incompatible_assignments: summary.incompatible,
        unknown_assignments: summary.unknown,
        initialized_at: initializedAt,
        schema_version: 1,
    };
}
export function resetSkillRegistryForTests() {
    manifests = new Map();
    assignments = [];
    initializedAt = null;
}
//# sourceMappingURL=registry.js.map