import { AGENT_PROFILES_DIR } from '../runtime-paths.js';
import { loadAgentProfiles } from './loader.js';
import type { AgentProfile } from './schema.js';

let profiles = new Map<string, AgentProfile>();
let initializedAt: string | null = null;

export async function initializeAgentProfileRegistry(dir = AGENT_PROFILES_DIR) {
  const loaded = await loadAgentProfiles(dir);
  profiles = new Map(loaded.profiles.map((profile) => [profile.id, Object.freeze(profile)]));
  initializedAt = new Date().toISOString();
  return getAgentProfileRegistryStatus();
}

export function getAgentProfile(id: string) {
  return profiles.get(id) || null;
}

export function listAgentProfiles() {
  return [...profiles.values()];
}

export function getAgentProfileRegistryStatus() {
  return {
    status: profiles.size > 0 ? 'ok' : 'error',
    required: true,
    count: profiles.size,
    initialized_at: initializedAt,
    schema_version: 2,
  };
}

export function resetAgentProfileRegistryForTests() {
  profiles = new Map();
  initializedAt = null;
}
