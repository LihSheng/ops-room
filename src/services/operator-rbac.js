export const OPERATOR_ROLE_NAMES = Object.freeze([
    'viewer',
    'operator',
    'reviewer',
    'administrator',
    'deployer',
]);
export const OPERATOR_PERMISSION_NAMES = Object.freeze([
    'dashboard.read',
    'mission.create',
    'task.manage',
    'workflow.recover',
    'workflow.approve',
    'agent.lifecycle',
    'agent.configure',
    'policy.manage',
    'session.manage',
    'repository.manage',
    'release.approve',
]);
const ROLE_PERMISSIONS = Object.freeze({
    viewer: Object.freeze([
        'dashboard.read',
    ]),
    operator: Object.freeze([
        'dashboard.read',
        'mission.create',
        'task.manage',
        'workflow.recover',
        'agent.lifecycle',
    ]),
    reviewer: Object.freeze([
        'dashboard.read',
        'workflow.approve',
    ]),
    administrator: Object.freeze([
        'dashboard.read',
        'mission.create',
        'task.manage',
        'workflow.recover',
        'workflow.approve',
        'agent.lifecycle',
        'agent.configure',
        'policy.manage',
        'session.manage',
        'repository.manage',
    ]),
    deployer: Object.freeze([
        'dashboard.read',
        'release.approve',
    ]),
});
const ROLE_SET = new Set(OPERATOR_ROLE_NAMES);
const PERMISSION_SET = new Set(OPERATOR_PERMISSION_NAMES);
function roleCandidates(input) {
    if (Array.isArray(input))
        return input.map((value) => String(value || '').trim());
    return String(input || '').split(',').map((value) => value.trim());
}
export function normalizeOperatorRoles(input) {
    const roles = roleCandidates(input).filter(Boolean);
    if (roles.length === 0)
        throw new Error('operator_roles_missing');
    const unique = [];
    for (const role of roles) {
        if (!ROLE_SET.has(role))
            throw new Error(`operator_role_unknown:${role}`);
        if (!unique.includes(role))
            unique.push(role);
    }
    return Object.freeze(unique);
}
export function permissionsForOperatorRoles(input) {
    const roles = normalizeOperatorRoles(input);
    const permissions = new Set();
    for (const role of roles) {
        for (const permission of ROLE_PERMISSIONS[role])
            permissions.add(permission);
    }
    return Object.freeze([...permissions]);
}
export function hasOperatorPermission(input, permission) {
    const normalizedPermission = String(permission || '').trim();
    if (!PERMISSION_SET.has(normalizedPermission))
        return false;
    try {
        return permissionsForOperatorRoles(input).includes(normalizedPermission);
    }
    catch {
        return false;
    }
}
export function requireOperatorPermission(input, permission) {
    if (!hasOperatorPermission(input, permission)) {
        throw new Error(`operator_permission_denied:${String(permission || 'unknown')}`);
    }
}
//# sourceMappingURL=operator-rbac.js.map