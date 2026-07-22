import { isAbsolute } from 'node:path';
export const MEMORY_SPACE_MANIFEST_SCHEMA_VERSION = 1;
export const MEMORY_SPACE_KEY_PATTERN = /^[a-z][a-z0-9-]*$/;
export const MEMORY_SPACE_SEMVER_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;
export const MEMORY_SPACE_KINDS = new Set(['project', 'shared', 'private-agent', 'archive']);
export const MEMORY_WRITE_POLICIES = new Set(['read-only', 'review-required']);
export const MEMORY_PROVENANCE_FIELDS = new Set(['agent_id', 'task_id', 'source_refs', 'created_at']);
const KIND_ROOTS = {
    project: '20_Projects',
    shared: '90_Shared',
    'private-agent': '90_Agents',
    archive: '99_Archive',
};
const MANIFEST_FIELDS = new Set([
    'schemaVersion',
    'key',
    'version',
    'displayName',
    'description',
    'kind',
    'publicationPath',
    'parentKey',
    'ownerAgent',
    'writePolicy',
    'provenance',
]);
const PROVENANCE_FIELDS = new Set(['requiredFields', 'reviewRequired']);
const SECRET_LOOKING_FIELD = /(secret|token|password|private.?key|credential|environment|prompt|instruction)/i;
export class MemorySpaceValidationError extends Error {
    issues;
    constructor(issues) {
        super(`Memory space validation failed:\n- ${issues.join('\n- ')}`);
        this.name = 'MemorySpaceValidationError';
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
export function isValidMemorySpaceVersion(value) {
    return MEMORY_SPACE_SEMVER_PATTERN.test(value);
}
export function normalizePublicationPath(value) {
    return value.replaceAll('\\', '/').replace(/^\.\//, '').replace(/\/$/, '');
}
export function isSafePublicationPath(value) {
    const normalized = normalizePublicationPath(value);
    const segments = normalized.split('/');
    return Boolean(normalized)
        && normalized === value
        && !value.includes('\0')
        && !value.includes('*')
        && !isAbsolute(value)
        && !/^[A-Za-z]:\//.test(normalized)
        && !segments.includes('..')
        && !segments.includes('.')
        && segments.length >= 2
        && segments.every(Boolean);
}
export function validateMemorySpaceManifest(value, source) {
    if (!isRecord(value)) {
        throw new MemorySpaceValidationError([`${source}: manifest must be a JSON object`]);
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
    if (value.schemaVersion !== MEMORY_SPACE_MANIFEST_SCHEMA_VERSION) {
        issues.push(`${source}: schemaVersion must be ${MEMORY_SPACE_MANIFEST_SCHEMA_VERSION}`);
    }
    if (typeof value.key !== 'string' || !MEMORY_SPACE_KEY_PATTERN.test(value.key)) {
        issues.push(`${source}: key must use lowercase letters, numbers, and hyphens`);
    }
    if (typeof value.version !== 'string' || !isValidMemorySpaceVersion(value.version)) {
        issues.push(`${source}: version must be a valid semantic version`);
    }
    if (typeof value.displayName !== 'string' || !value.displayName.trim()) {
        issues.push(`${source}: displayName is required`);
    }
    if (typeof value.description !== 'string' || !value.description.trim()) {
        issues.push(`${source}: description is required`);
    }
    if (typeof value.kind !== 'string' || !MEMORY_SPACE_KINDS.has(value.kind)) {
        issues.push(`${source}: kind must be project, shared, private-agent, or archive`);
    }
    if (typeof value.publicationPath !== 'string' || !isSafePublicationPath(value.publicationPath)) {
        issues.push(`${source}: publicationPath must be a normalized curated relative path without traversal or wildcards`);
    }
    else if (typeof value.kind === 'string' && MEMORY_SPACE_KINDS.has(value.kind)) {
        const expectedRoot = KIND_ROOTS[value.kind];
        if (value.publicationPath.split('/')[0] !== expectedRoot) {
            issues.push(`${source}: ${value.kind} publicationPath must be rooted under ${expectedRoot}`);
        }
    }
    if (value.parentKey !== undefined && (typeof value.parentKey !== 'string' || !MEMORY_SPACE_KEY_PATTERN.test(value.parentKey))) {
        issues.push(`${source}: parentKey must be a normalized memory space key`);
    }
    if (value.parentKey === value.key)
        issues.push(`${source}: parentKey cannot reference the same key`);
    if (value.ownerAgent !== undefined && (typeof value.ownerAgent !== 'string' || !MEMORY_SPACE_KEY_PATTERN.test(value.ownerAgent))) {
        issues.push(`${source}: ownerAgent must be a normalized agent key`);
    }
    if (value.kind === 'private-agent' && typeof value.ownerAgent !== 'string') {
        issues.push(`${source}: private-agent spaces require ownerAgent`);
    }
    if (value.kind !== 'private-agent' && value.ownerAgent !== undefined) {
        issues.push(`${source}: ownerAgent is only allowed for private-agent spaces`);
    }
    if (typeof value.writePolicy !== 'string' || !MEMORY_WRITE_POLICIES.has(value.writePolicy)) {
        issues.push(`${source}: writePolicy must be read-only or review-required`);
    }
    if (value.kind === 'archive' && value.writePolicy !== 'read-only') {
        issues.push(`${source}: archive spaces must be read-only`);
    }
    if (!isRecord(value.provenance)) {
        issues.push(`${source}: provenance is required`);
    }
    else {
        for (const field of Object.keys(value.provenance)) {
            if (!PROVENANCE_FIELDS.has(field))
                issues.push(`${source}: provenance contains unknown field ${field}`);
        }
        const requiredFields = value.provenance.requiredFields;
        if (!Array.isArray(requiredFields) || requiredFields.some((field) => typeof field !== 'string')) {
            issues.push(`${source}: provenance.requiredFields must be a string array`);
        }
        else {
            for (const field of requiredFields) {
                if (!MEMORY_PROVENANCE_FIELDS.has(field))
                    issues.push(`${source}: unsupported provenance field ${field}`);
            }
            const duplicates = duplicateValues(requiredFields);
            if (duplicates.length)
                issues.push(`${source}: duplicate provenance fields: ${duplicates.join(', ')}`);
        }
        if (typeof value.provenance.reviewRequired !== 'boolean') {
            issues.push(`${source}: provenance.reviewRequired must be boolean`);
        }
        if (value.writePolicy === 'review-required' && value.provenance.reviewRequired !== true) {
            issues.push(`${source}: review-required spaces must require provenance review`);
        }
    }
    if (issues.length)
        throw new MemorySpaceValidationError(issues);
    return value;
}
//# sourceMappingURL=schema.js.map