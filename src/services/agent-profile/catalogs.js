export function buildSkillCatalog(profiles) {
    const agentsBySkill = new Map();
    for (const profile of profiles) {
        for (const skill of profile.skills) {
            const agents = agentsBySkill.get(skill.key) || new Set();
            agents.add(profile.id);
            agentsBySkill.set(skill.key, agents);
        }
    }
    return [...agentsBySkill.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, agents]) => ({ key, agents: [...agents].sort() }));
}
export function buildMemorySpaceCatalog(profiles) {
    const spaces = new Map();
    const getSpace = (key) => {
        const existing = spaces.get(key);
        if (existing)
            return existing;
        const created = { readers: new Set(), writers: new Set() };
        spaces.set(key, created);
        return created;
    };
    for (const profile of profiles) {
        for (const key of profile.memory.read)
            getSpace(key).readers.add(profile.id);
        for (const key of profile.memory.write)
            getSpace(key).writers.add(profile.id);
    }
    return [...spaces.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, usage]) => ({
        key,
        readers: [...usage.readers].sort(),
        writers: [...usage.writers].sort(),
    }));
}
//# sourceMappingURL=catalogs.js.map