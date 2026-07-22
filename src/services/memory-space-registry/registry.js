import { listAgentProfiles } from '../agent-profile/registry.js';
import { MEMORY_SPACE_MANIFESTS_DIR } from '../runtime-paths.js';
import { loadMemorySpaceManifests } from './loader.js';
import { resolveMemoryAssignments } from './resolver.js';
let manifests = new Map();
let assignments = [];
let initializedAt = null;
function cloneManifest(manifest) {
    return {
        ...manifest,
        provenance: {
            requiredFields: [...manifest.provenance.requiredFields],
            reviewRequired: manifest.provenance.reviewRequired,
        },
    };
}
function cloneAssignment(assignment) {
    return {
        ...assignment,
        manifest: cloneManifest(assignment.manifest),
    };
}
export async function initializeMemorySpaceRegistry({ dir = MEMORY_SPACE_MANIFESTS_DIR, profiles = listAgentProfiles(), } = {}) {
    const loaded = await loadMemorySpaceManifests(dir);
    const nextManifests = new Map(loaded.manifests.map((manifest) => [manifest.key, cloneManifest(manifest)]));
    const nextAssignments = resolveMemoryAssignments({ profiles, manifests: nextManifests });
    manifests = nextManifests;
    assignments = nextAssignments;
    initializedAt = new Date().toISOString();
    return getMemorySpaceRegistryStatus();
}
export function getMemorySpaceManifest(key) {
    const manifest = manifests.get(key);
    return manifest ? cloneManifest(manifest) : null;
}
export function listMemorySpaceManifests() {
    return [...manifests.values()].sort((left, right) => left.key.localeCompare(right.key)).map(cloneManifest);
}
export function listMemoryAssignments() {
    return assignments.map(cloneAssignment);
}
export function getMemoryAssignmentsForAgent(agentId) {
    return assignments.filter((assignment) => assignment.agentId === agentId).map(cloneAssignment);
}
export function getMemorySpaceRegistryStatus() {
    const kindCounts = { project: 0, shared: 0, 'private-agent': 0, archive: 0 };
    for (const manifest of manifests.values())
        kindCounts[manifest.kind] += 1;
    return {
        status: manifests.size > 0 ? 'ready' : 'error',
        required: true,
        manifest_count: manifests.size,
        assignment_count: assignments.length,
        read_assignments: assignments.filter((assignment) => assignment.access === 'read').length,
        write_assignments: assignments.filter((assignment) => assignment.access === 'write').length,
        kind_counts: kindCounts,
        initialized_at: initializedAt,
        schema_version: 1,
    };
}
export function resetMemorySpaceRegistryForTests() {
    manifests = new Map();
    assignments = [];
    initializedAt = null;
}
//# sourceMappingURL=registry.js.map