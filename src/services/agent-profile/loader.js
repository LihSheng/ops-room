import { readdir, readFile } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';
import { AGENT_DEFINITIONS } from '../agent-definitions.js';
import { AgentProfileValidationError, validateAgentProfile } from './schema.js';
export async function loadAgentProfiles(dir) {
    const entries = (await readdir(dir, { withFileTypes: true }))
        .filter((entry) => entry.isFile() && extname(entry.name) === '.json')
        .sort((a, b) => a.name.localeCompare(b.name));
    if (entries.length === 0) {
        throw new AgentProfileValidationError([`${dir}: no agent profile JSON files found`]);
    }
    const profiles = [];
    const issues = [];
    const sources = {};
    for (const entry of entries) {
        const path = join(dir, entry.name);
        try {
            const parsed = JSON.parse(await readFile(path, 'utf8'));
            const profile = validateAgentProfile(parsed, entry.name);
            const expectedId = basename(entry.name, '.json');
            if (profile.id !== expectedId) {
                issues.push(`${entry.name}: filename must match profile id ${profile.id}`);
            }
            profiles.push(profile);
            sources[profile.id] = path;
        }
        catch (error) {
            if (error instanceof SyntaxError) {
                issues.push(`${entry.name}: malformed JSON`);
            }
            else if (error instanceof AgentProfileValidationError) {
                issues.push(...error.issues);
            }
            else {
                issues.push(`${entry.name}: ${error instanceof Error ? error.message : String(error)}`);
            }
        }
    }
    const seen = new Set();
    for (const profile of profiles) {
        if (seen.has(profile.id))
            issues.push(`duplicate profile id: ${profile.id}`);
        seen.add(profile.id);
    }
    const definitions = new Map(AGENT_DEFINITIONS.map((definition) => [definition.key, definition]));
    for (const profile of profiles) {
        const definition = definitions.get(profile.id);
        if (!definition) {
            issues.push(`${profile.id}: no matching agent definition`);
            continue;
        }
        if (definition.backend !== profile.runtime.backend) {
            issues.push(`${profile.id}: runtime backend must match agent definition (${definition.backend})`);
        }
    }
    for (const definition of AGENT_DEFINITIONS) {
        if (!seen.has(definition.key))
            issues.push(`${definition.key}: missing required profile`);
    }
    if (issues.length)
        throw new AgentProfileValidationError(issues);
    return { profiles, sources };
}
//# sourceMappingURL=loader.js.map