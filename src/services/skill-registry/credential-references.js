const LOGICAL_REFERENCE_PATTERN = /^[a-z][a-z0-9-]*$/;
const ENVIRONMENT_NAME_PATTERN = /^[A-Z_][A-Z0-9_]*$/;
export function createCredentialReferenceResolver(env = process.env) {
    const raw = env.OPS_ROOM_CREDENTIAL_REFERENCE_MAP;
    if (raw === undefined)
        return () => 'unknown';
    let mapping;
    try {
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
            return () => 'unknown';
        mapping = Object.fromEntries(Object.entries(parsed).filter(([reference, environmentName]) => (LOGICAL_REFERENCE_PATTERN.test(reference) &&
            typeof environmentName === 'string' &&
            ENVIRONMENT_NAME_PATTERN.test(environmentName))));
    }
    catch {
        return () => 'unknown';
    }
    return (reference) => {
        const environmentName = mapping[reference];
        if (!environmentName)
            return 'unknown';
        const value = env[environmentName];
        return typeof value === 'string' && value.trim().length > 0 ? 'present' : 'missing';
    };
}
//# sourceMappingURL=credential-references.js.map