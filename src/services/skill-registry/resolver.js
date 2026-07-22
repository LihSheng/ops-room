import { evaluateSkillCompatibility } from './compatibility.js';
export function skillManifestId(key, version) {
    return `${key}@${version}`;
}
export function resolveSkillAssignments({ profiles, manifests, commandPresence, credentialResolver, }) {
    const resolutions = [];
    for (const profile of profiles.slice().sort((left, right) => left.id.localeCompare(right.id))) {
        for (const assignment of profile.skills.slice().sort((left, right) => left.key.localeCompare(right.key) || left.version.localeCompare(right.version))) {
            const manifest = manifests.get(skillManifestId(assignment.key, assignment.version)) || null;
            resolutions.push({
                agentId: profile.id,
                key: assignment.key,
                version: assignment.version,
                runtimeBackend: profile.runtime.backend,
                resolutionStatus: manifest ? 'resolved' : 'unresolved',
                manifest,
                compatibility: evaluateSkillCompatibility({ profile, manifest, commandPresence, credentialResolver }),
            });
        }
    }
    return resolutions;
}
//# sourceMappingURL=resolver.js.map