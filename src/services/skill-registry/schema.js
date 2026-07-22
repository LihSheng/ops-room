import { isAbsolute } from 'node:path';
export const SKILL_MANIFEST_SCHEMA_VERSION = 1;
export const SKILL_KEY_PATTERN = /^[a-z][a-z0-9-]*$/;
export const SEMANTIC_VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;
export const SUPPORTED_SKILL_RUNTIMES = new Set(['opencode', 'gemini']);
export const INSPECTABLE_SKILL_COMMANDS = new Set(['git', 'gh', 'opencode', 'codex', 'claude', 'gemini']);
export const ALLOWED_SKILL_PERMISSIONS = new Set([
    'repository.read',
    'repository.write',
    'pull-request.read',
    'pull-request.comment',
    'test.execute',
    'research.read',
    'documentation.write',
]);
const MANIFEST_FIELDS = new Set([
    'schemaVersion',
    'key',
    'version',
    'description',
    'supportedRuntimes',
    'requiredCommands',
    'requiredCredentials',
    'permissions',
]);
const SECRET_LOOKING_FIELD = /(secret|token|password|private.?key|credential.?value|environment|prompt|instruction)/i;
const COMMAND_PATTERN = /^[a-z0-9][a-z0-9._-]*$/;
const CREDENTIAL_PATTERN = /^[a-z][a-z0-9-]*$/;
export class SkillManifestValidationError extends Error {
    issues;
    constructor(issues) {
        super(`Skill manifest validation failed:\n- ${issues.join('\n- ')}`);
        this.name = 'SkillManifestValidationError';
        this.issues = issues;
    }
}
function isRecord(value) {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
function duplicateValues(values) {
    const seen = new Set();
    const duplicates = new Set();
    for (const value of values) {
        if (seen.has(value))
            duplicates.add(value);
        seen.add(value);
    }
    return [...duplicates].sort();
}
function containsUnsafePath(value) {
    const normalized = value.replaceAll('\\', '/');
    return value.includes('\0') || isAbsolute(value) || /^[A-Za-z]:\//.test(normalized) || normalized.split('/').includes('..');
}
function validateNormalizedArray({ value, field, source, issues, pattern, allowlist, requireNonEmpty = false, }) {
    if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
        issues.push(`${source}: ${field} must be a string array`);
        return [];
    }
    const values = value;
    if (requireNonEmpty && values.length === 0)
        issues.push(`${source}: ${field} must not be empty`);
    for (const item of values) {
        if (!item || item !== item.trim() || item !== item.toLowerCase()) {
            issues.push(`${source}: ${field} entries must be normalized lowercase values`);
            continue;
        }
        if (containsUnsafePath(item))
            issues.push(`${source}: ${field} contains an unsafe path value`);
        if (pattern && !pattern.test(item))
            issues.push(`${source}: ${field} contains invalid value ${item}`);
        if (allowlist && !allowlist.has(item))
            issues.push(`${source}: ${field} contains unsupported value ${item}`);
    }
    const duplicates = duplicateValues(values);
    if (duplicates.length)
        issues.push(`${source}: duplicate ${field}: ${duplicates.join(', ')}`);
    return values;
}
export function isValidSemanticVersion(value) {
    return SEMANTIC_VERSION_PATTERN.test(value);
}
export function validateSkillManifest(value, source) {
    if (!isRecord(value)) {
        throw new SkillManifestValidationError([`${source}: manifest must be a JSON object`]);
    }
    const issues = [];
    for (const field of Object.keys(value)) {
        if (MANIFEST_FIELDS.has(field))
            continue;
        if (SECRET_LOOKING_FIELD.test(field))
            issues.push(`${source}: secret-looking field ${field} is not allowed`);
        else
            issues.push(`${source}: unknown field ${field}`);
    }
    if (value.schemaVersion !== SKILL_MANIFEST_SCHEMA_VERSION) {
        issues.push(`${source}: schemaVersion must be ${SKILL_MANIFEST_SCHEMA_VERSION}`);
    }
    if (typeof value.key !== 'string' || !SKILL_KEY_PATTERN.test(value.key)) {
        issues.push(`${source}: key must use lowercase letters, numbers, and hyphens`);
    }
    if (typeof value.version !== 'string' || !isValidSemanticVersion(value.version)) {
        issues.push(`${source}: version must be a valid semantic version`);
    }
    if (typeof value.description !== 'string' || !value.description.trim()) {
        issues.push(`${source}: description is required`);
    }
    else if (containsUnsafePath(value.description)) {
        issues.push(`${source}: description must not contain an absolute path or traversal segment`);
    }
    validateNormalizedArray({
        value: value.supportedRuntimes,
        field: 'supportedRuntimes',
        source,
        issues,
        pattern: SKILL_KEY_PATTERN,
        allowlist: SUPPORTED_SKILL_RUNTIMES,
        requireNonEmpty: true,
    });
    validateNormalizedArray({
        value: value.requiredCommands,
        field: 'requiredCommands',
        source,
        issues,
        pattern: COMMAND_PATTERN,
        allowlist: INSPECTABLE_SKILL_COMMANDS,
    });
    validateNormalizedArray({
        value: value.requiredCredentials,
        field: 'requiredCredentials',
        source,
        issues,
        pattern: CREDENTIAL_PATTERN,
    });
    validateNormalizedArray({
        value: value.permissions,
        field: 'permissions',
        source,
        issues,
        allowlist: ALLOWED_SKILL_PERMISSIONS,
        requireNonEmpty: true,
    });
    if (Array.isArray(value.permissions) && value.permissions.includes('*')) {
        issues.push(`${source}: wildcard permission is not allowed`);
    }
    if (issues.length)
        throw new SkillManifestValidationError(issues);
    return value;
}
//# sourceMappingURL=schema.js.map