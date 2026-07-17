import type { AgentProfile } from './schema.js';

export type SkillCatalogItem = { key: string; agents: string[] };
export type MemorySpaceItem = { key: string; readers: string[]; writers: string[] };

export function buildSkillCatalog(profiles: AgentProfile[]): SkillCatalogItem[] {
  const agentsBySkill = new Map<string, Set<string>>();
  for (const profile of profiles) {
    for (const skill of profile.skills) {
      const agents = agentsBySkill.get(skill) || new Set<string>();
      agents.add(profile.id);
      agentsBySkill.set(skill, agents);
    }
  }
  return [...agentsBySkill.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, agents]) => ({ key, agents: [...agents].sort() }));
}

export function buildMemorySpaceCatalog(profiles: AgentProfile[]): MemorySpaceItem[] {
  const spaces = new Map<string, { readers: Set<string>; writers: Set<string> }>();
  const getSpace = (key: string) => {
    const existing = spaces.get(key);
    if (existing) return existing;
    const created = { readers: new Set<string>(), writers: new Set<string>() };
    spaces.set(key, created);
    return created;
  };

  for (const profile of profiles) {
    for (const key of profile.memory.read) getSpace(key).readers.add(profile.id);
    for (const key of profile.memory.write) getSpace(key).writers.add(profile.id);
  }

  return [...spaces.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, usage]) => ({
      key,
      readers: [...usage.readers].sort(),
      writers: [...usage.writers].sort(),
    }));
}
