import type { AgentProfile } from './schema.js';

export type PublicAgentProfile = {
  id: string;
  display_name: string;
  schema_version: number;
  profile_version: string;
  mission: string;
  personality: {
    communication_style: string;
    decision_policy: string[];
    constraints: string[];
  };
  runtime: {
    backend: string;
  };
  skills: string[];
  skill_assignments: { key: string; version: string }[];
  memory: {
    read: string[];
    write: string[];
  };
  repositories: string[];
  enabled: boolean;
};

export function toPublicAgentProfile(profile: AgentProfile): PublicAgentProfile {
  return {
    id: profile.id,
    display_name: profile.displayName,
    schema_version: profile.schemaVersion,
    profile_version: profile.profileVersion,
    mission: profile.mission,
    personality: {
      communication_style: profile.personality.communicationStyle,
      decision_policy: [...profile.personality.decisionPolicy],
      constraints: [...profile.personality.constraints],
    },
    runtime: { backend: profile.runtime.backend },
    skills: profile.skills.map((skill) => skill.key),
    skill_assignments: profile.skills.map((skill) => ({ ...skill })),
    memory: {
      read: [...profile.memory.read],
      write: [...profile.memory.write],
    },
    repositories: [...profile.repositories],
    enabled: profile.enabled,
  };
}
