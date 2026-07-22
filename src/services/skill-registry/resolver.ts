import type { AgentProfile } from '../agent-profile/schema.js';
import { evaluateSkillCompatibility } from './compatibility.js';
import type { CredentialPresence, SkillCompatibility } from './compatibility.js';
import type { SkillManifest } from './schema.js';

export type SkillAssignmentResolution = {
  agentId: string;
  key: string;
  version: string;
  runtimeBackend: string;
  resolutionStatus: 'resolved' | 'unresolved';
  manifest: SkillManifest | null;
  compatibility: SkillCompatibility;
};

export function skillManifestId(key: string, version: string) {
  return `${key}@${version}`;
}

export function resolveSkillAssignments({
  profiles,
  manifests,
  commandPresence,
  credentialResolver,
}: {
  profiles: AgentProfile[];
  manifests: Map<string, SkillManifest>;
  commandPresence: Record<string, boolean> | null;
  credentialResolver: (reference: string) => CredentialPresence;
}): SkillAssignmentResolution[] {
  const resolutions: SkillAssignmentResolution[] = [];
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
