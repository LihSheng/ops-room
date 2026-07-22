function assignmentAgents(assignments, key, access) {
    return assignments
        .filter((assignment) => assignment.key === key && assignment.access === access)
        .map((assignment) => assignment.agentId)
        .sort();
}
export function toPublicMemorySpace(manifest, assignments) {
    const readers = assignmentAgents(assignments, manifest.key, 'read');
    const writers = assignmentAgents(assignments, manifest.key, 'write');
    return {
        key: manifest.key,
        version: manifest.version,
        display_name: manifest.displayName,
        description: manifest.description,
        kind: manifest.kind,
        publication_path: manifest.publicationPath,
        parent_key: manifest.parentKey || null,
        owner_agent: manifest.ownerAgent || null,
        write_policy: manifest.writePolicy,
        provenance: {
            required_fields: [...manifest.provenance.requiredFields],
            review_required: manifest.provenance.reviewRequired,
        },
        readers,
        writers,
        assignment_count: readers.length + writers.length,
    };
}
export function buildPublicMemorySpaceCatalog(manifests, assignments) {
    return manifests
        .slice()
        .sort((left, right) => left.key.localeCompare(right.key))
        .map((manifest) => toPublicMemorySpace(manifest, assignments));
}
export function toPublicProfileMemoryAssignments(profile, assignments) {
    const toPublic = (assignment) => ({
        key: assignment.key,
        version: assignment.version,
        access: assignment.access,
        display_name: assignment.manifest.displayName,
        kind: assignment.manifest.kind,
        publication_path: assignment.manifest.publicationPath,
        write_policy: assignment.manifest.writePolicy,
        provenance: {
            required_fields: [...assignment.manifest.provenance.requiredFields],
            review_required: assignment.manifest.provenance.reviewRequired,
        },
    });
    return {
        read: assignments
            .filter((assignment) => assignment.agentId === profile.id && assignment.access === 'read')
            .sort((left, right) => left.key.localeCompare(right.key))
            .map(toPublic),
        write: assignments
            .filter((assignment) => assignment.agentId === profile.id && assignment.access === 'write')
            .sort((left, right) => left.key.localeCompare(right.key))
            .map(toPublic),
    };
}
//# sourceMappingURL=public-memory-space.js.map