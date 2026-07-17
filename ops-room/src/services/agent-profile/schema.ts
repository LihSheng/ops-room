export const AGENT_PROFILE_SCHEMA_VERSION = 1;

export const SUPPORTED_PROFILE_BACKENDS = new Set(['opencode', 'gemini']);

export type AgentProfile = {
  schemaVersion: 1;
  id: string;
  displayName: string;
  profileVersion: string;
  mission: string;
  personality: {
    communicationStyle: string;
    decisionPolicy: string[];
    constraints: string[];
  };
  runtime: {
    backend: string;
  };
  skills: string[];
  memory: {
    read: string[];
    write: string[];
  };
  repositories: string[];
  enabled: boolean;
};

export class AgentProfileValidationError extends Error {
  issues: string[];

  constructor(issues: string[]) {
    super(`Agent profile validation failed:\n- ${issues.join('\n- ')}`);
    this.name = 'AgentProfileValidationError';
    this.issues = issues;
  }
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string' && item.trim().length > 0);
}

function duplicateValues(values: string[]) {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) duplicates.add(value);
    seen.add(value);
  }
  return [...duplicates];
}

export function validateAgentProfile(value: unknown, source: string): AgentProfile {
  const issues: string[] = [];
  const profile = value as Partial<AgentProfile> | null;

  if (!profile || typeof profile !== 'object' || Array.isArray(profile)) {
    throw new AgentProfileValidationError([`${source}: profile must be a JSON object`]);
  }

  if (profile.schemaVersion !== AGENT_PROFILE_SCHEMA_VERSION) {
    issues.push(`${source}: schemaVersion must be ${AGENT_PROFILE_SCHEMA_VERSION}`);
  }
  if (typeof profile.id !== 'string' || !/^[a-z][a-z0-9-]*$/.test(profile.id)) {
    issues.push(`${source}: id must use lowercase letters, numbers, and hyphens`);
  }
  if (typeof profile.displayName !== 'string' || !profile.displayName.trim()) {
    issues.push(`${source}: displayName is required`);
  }
  if (typeof profile.profileVersion !== 'string' || !/^\d+\.\d+\.\d+$/.test(profile.profileVersion)) {
    issues.push(`${source}: profileVersion must be semantic version format`);
  }
  if (typeof profile.mission !== 'string' || !profile.mission.trim()) {
    issues.push(`${source}: mission is required`);
  }
  if (!profile.personality || typeof profile.personality !== 'object') {
    issues.push(`${source}: personality is required`);
  } else {
    if (typeof profile.personality.communicationStyle !== 'string' || !profile.personality.communicationStyle.trim()) {
      issues.push(`${source}: personality.communicationStyle is required`);
    }
    if (!isStringArray(profile.personality.decisionPolicy)) {
      issues.push(`${source}: personality.decisionPolicy must be a non-empty string array`);
    }
    if (!isStringArray(profile.personality.constraints)) {
      issues.push(`${source}: personality.constraints must be a non-empty string array`);
    }
  }
  if (!profile.runtime || typeof profile.runtime !== 'object' || !SUPPORTED_PROFILE_BACKENDS.has(profile.runtime.backend)) {
    issues.push(`${source}: runtime.backend is unsupported`);
  }
  if (!isStringArray(profile.skills)) {
    issues.push(`${source}: skills must be a non-empty string array`);
  } else {
    const duplicates = duplicateValues(profile.skills);
    if (duplicates.length) issues.push(`${source}: duplicate skills: ${duplicates.join(', ')}`);
  }
  if (!profile.memory || typeof profile.memory !== 'object') {
    issues.push(`${source}: memory policy is required`);
  } else {
    if (!Array.isArray(profile.memory.read) || !profile.memory.read.every((item) => typeof item === 'string')) {
      issues.push(`${source}: memory.read must be a string array`);
    }
    if (!Array.isArray(profile.memory.write) || !profile.memory.write.every((item) => typeof item === 'string')) {
      issues.push(`${source}: memory.write must be a string array`);
    }
  }
  if (!isStringArray(profile.repositories)) {
    issues.push(`${source}: repositories must be a non-empty string array`);
  }
  if (typeof profile.enabled !== 'boolean') {
    issues.push(`${source}: enabled must be boolean`);
  }

  if (issues.length) throw new AgentProfileValidationError(issues);
  return profile as AgentProfile;
}
