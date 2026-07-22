import { MemorySpaceValidationError } from './schema.js';
function cloneManifest(manifest) {
    return {
        ...manifest,
        provenance: {
            requiredFields: [...manifest.provenance.requiredFields],
            reviewRequired: manifest.provenance.reviewRequired,
        },
    };
}
export function resolveMemoryAssignments({ profiles, manifests, }) {
    const issues = [];
    const assignments = [];
    const agentIds = new Set(profiles.map((profile) => profile.id));
    for (const manifest of manifests.values()) {
        if (manifest.ownerAgent && !agentIds.has(manifest.ownerAgent)) {
            issues.push(`${manifest.key}: ownerAgent ${manifest.ownerAgent} does not resolve to a profile`);
        }
    }
    for (const profile of [...profiles].sort((left, right) => left.id.localeCompare(right.id))) {
        for (const access of ['read', 'write']) {
            const keys = profile.memory[access];
            const duplicates = keys.filter((key, index) => keys.indexOf(key) !== index);
            if (duplicates.length) {
                issues.push(`${profile.id}: duplicate ${access} memory assignments: ${[...new Set(duplicates)].sort().join(', ')}`);
            }
            for (const key of keys) {
                const manifest = manifests.get(key);
                if (!manifest) {
                    issues.push(`${profile.id}: ${access} memory assignment ${key} does not resolve`);
                    continue;
                }
                if (manifest.kind === 'private-agent' && manifest.ownerAgent !== profile.id) {
                    issues.push(`${profile.id}: cannot access private memory space ${key} owned by ${manifest.ownerAgent}`);
                    continue;
                }
                if (access === 'write' && manifest.writePolicy === 'read-only') {
                    issues.push(`${profile.id}: cannot write to read-only memory space ${key}`);
                    continue;
                }
                if (access === 'write' && !profile.memory.read.includes(key)) {
                    issues.push(`${profile.id}: write assignment ${key} must also be declared in memory.read`);
                    continue;
                }
                assignments.push({
                    agentId: profile.id,
                    access,
                    key: manifest.key,
                    version: manifest.version,
                    manifest: cloneManifest(manifest),
                });
            }
        }
    }
    if (issues.length)
        throw new MemorySpaceValidationError(issues);
    return assignments.sort((left, right) => left.key.localeCompare(right.key)
        || left.agentId.localeCompare(right.agentId)
        || left.access.localeCompare(right.access));
}
//# sourceMappingURL=resolver.js.map