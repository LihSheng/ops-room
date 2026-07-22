export function toPublicAgentProfile(profile) {
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
//# sourceMappingURL=public-profile.js.map