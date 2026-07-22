export const AGENT_PROFILE_SCHEMA_VERSION = 2;
export const SUPPORTED_PROFILE_BACKENDS = new Set(['opencode', 'gemini']);
const SEMANTIC_VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;
const SKILL_KEY_PATTERN = /^[a-z][a-z0-9-]*$/;
const MEMORY_SPACE_KEY_PATTERN = /^[a-z][a-z0-9-]*$/;
export class AgentProfileValidationError extends Error {
    issues;
    constructor(issues) {
        super(`Agent profile validation failed:\n- ${issues.join('\n- ')}`);
        this.name = 'AgentProfileValidationError';
        this.issues = issues;
    }
}
function isStringArray(value) {
    return Array.isArray(value) && value.length > 0 && value.every((item) => typeof item === 'string' && item.trim().length > 0);
}
function duplicateValues(values) {
    const seen = new Set();
    const duplicates = new Set();
    for (const value of values) {
        if (seen.has(value))
            duplicates.add(value);
        seen.add(value);
    }
    return [...duplicates];
}
function validateMemoryKeys(value, field, source, issues) {
    if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
        issues.push(`${source}: ${field} must be a string array`);
        return;
    }
    const keys = value;
    for (const key of keys) {
        if (!MEMORY_SPACE_KEY_PATTERN.test(key)) {
            issues.push(`${source}: ${field} entries must be normalized logical memory-space keys`);
        }
    }
    const duplicates = duplicateValues(keys);
    if (duplicates.length)
        issues.push(`${source}: duplicate ${field} assignments: ${duplicates.join(', ')}`);
}
function validateSkillAssignments(value, source, issues) {
    if (!Array.isArray(value) || value.length === 0) {
        issues.push(`${source}: skills must be a non-empty versioned assignment array`);
        return false;
    }
    const keys = [];
    for (const [index, item] of value.entries()) {
        if (!item || typeof item !== 'object' || Array.isArray(item)) {
            issues.push(`${source}: skills[${index}] must be an object with key and version`);
            continue;
        }
        const assignment = item;
        const unknownFields = Object.keys(item).filter((field) => !['key', 'version'].includes(field));
        if (unknownFields.length)
            issues.push(`${source}: skills[${index}] contains unknown fields: ${unknownFields.join(', ')}`);
        if (typeof assignment.key !== 'string' || !SKILL_KEY_PATTERN.test(assignment.key)) {
            issues.push(`${source}: skills[${index}].key must use lowercase letters, numbers, and hyphens`);
        }
        else {
            keys.push(assignment.key);
        }
        if (typeof assignment.version !== 'string' || !SEMANTIC_VERSION_PATTERN.test(assignment.version)) {
            issues.push(`${source}: skills[${index}].version must be a valid semantic version`);
        }
    }
    const duplicates = duplicateValues(keys);
    if (duplicates.length)
        issues.push(`${source}: duplicate skill assignments: ${duplicates.join(', ')}`);
    return issues.length === 0;
}
export function validateAgentProfile(value, source) {
    const issues = [];
    const profile = value;
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
    if (typeof profile.profileVersion !== 'string' || !SEMANTIC_VERSION_PATTERN.test(profile.profileVersion)) {
        issues.push(`${source}: profileVersion must be semantic version format`);
    }
    if (typeof profile.mission !== 'string' || !profile.mission.trim()) {
        issues.push(`${source}: mission is required`);
    }
    if (!profile.personality || typeof profile.personality !== 'object') {
        issues.push(`${source}: personality is required`);
    }
    else {
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
    validateSkillAssignments(profile.skills, source, issues);
    if (!profile.memory || typeof profile.memory !== 'object') {
        issues.push(`${source}: memory policy is required`);
    }
    else {
        validateMemoryKeys(profile.memory.read, 'memory.read', source, issues);
        validateMemoryKeys(profile.memory.write, 'memory.write', source, issues);
    }
    if (!isStringArray(profile.repositories)) {
        issues.push(`${source}: repositories must be a non-empty string array`);
    }
    if (typeof profile.enabled !== 'boolean') {
        issues.push(`${source}: enabled must be boolean`);
    }
    if (issues.length)
        throw new AgentProfileValidationError(issues);
    return profile;
}
//# sourceMappingURL=schema.js.map