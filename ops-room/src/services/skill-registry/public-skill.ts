import type { AgentProfile } from '../agent-profile/schema.js';
import type { SkillAssignmentResolution } from './resolver.js';
import type { SkillManifest } from './schema.js';

function publicCompatibility(assignment: SkillAssignmentResolution) {
  return {
    status: assignment.compatibility.status,
    reasons: assignment.compatibility.reasons.map((reason) => ({ ...reason })),
  };
}

function publicRequirements(assignment: SkillAssignmentResolution) {
  return {
    commands: assignment.compatibility.requirements.commands.map((item) => ({ ...item })),
    credentials: assignment.compatibility.requirements.credentials.map((item) => ({ ...item })),
  };
}

function compatibilitySummary(assignments: SkillAssignmentResolution[]) {
  const summary = { compatible: 0, incompatible: 0, unknown: 0 };
  for (const assignment of assignments) summary[assignment.compatibility.status] += 1;
  return summary;
}

export function toPublicSkillAssignment(assignment: SkillAssignmentResolution) {
  return {
    key: assignment.key,
    version: assignment.version,
    agent_id: assignment.agentId,
    runtime_backend: assignment.runtimeBackend,
    resolution_status: assignment.resolutionStatus,
    compatibility: publicCompatibility(assignment),
    requirements: publicRequirements(assignment),
  };
}

export function toPublicProfileSkillAssignments(profile: AgentProfile, assignments: SkillAssignmentResolution[]) {
  const byId = new Map(assignments.map((assignment) => [`${assignment.key}@${assignment.version}`, assignment]));
  return profile.skills.map((declared) => {
    const assignment = byId.get(`${declared.key}@${declared.version}`);
    if (assignment) {
      const publicAssignment = toPublicSkillAssignment(assignment);
      return {
        key: publicAssignment.key,
        version: publicAssignment.version,
        resolution_status: publicAssignment.resolution_status,
        compatibility: publicAssignment.compatibility,
        requirements: publicAssignment.requirements,
      };
    }
    return {
      key: declared.key,
      version: declared.version,
      resolution_status: 'unresolved',
      compatibility: {
        status: 'unknown',
        reasons: [{ code: 'manifest_unresolved', message: 'The declared skill version could not be resolved.' }],
      },
      requirements: { commands: [], credentials: [] },
    };
  });
}

export function toPublicSkillCatalogItem(manifest: SkillManifest, assignments: SkillAssignmentResolution[]) {
  const matching = assignments
    .filter((assignment) => assignment.key === manifest.key && assignment.version === manifest.version)
    .sort((left, right) => left.agentId.localeCompare(right.agentId));
  return {
    key: manifest.key,
    version: manifest.version,
    description: manifest.description,
    agents: matching.map((assignment) => assignment.agentId),
    supported_runtimes: [...manifest.supportedRuntimes],
    required_commands: [...manifest.requiredCommands],
    required_credentials: [...manifest.requiredCredentials],
    permissions: [...manifest.permissions],
    compatibility_summary: compatibilitySummary(matching),
  };
}

export function buildPublicSkillCatalog(manifests: SkillManifest[], assignments: SkillAssignmentResolution[]) {
  return manifests
    .slice()
    .sort((left, right) => left.key.localeCompare(right.key) || left.version.localeCompare(right.version))
    .map((manifest) => toPublicSkillCatalogItem(manifest, assignments));
}

export function toPublicSkillDetail(manifest: SkillManifest, assignments: SkillAssignmentResolution[]) {
  const catalog = toPublicSkillCatalogItem(manifest, assignments);
  const matching = assignments
    .filter((assignment) => assignment.key === manifest.key && assignment.version === manifest.version)
    .sort((left, right) => left.agentId.localeCompare(right.agentId));
  return {
    ...catalog,
    assignments: matching.map(toPublicSkillAssignment),
  };
}
