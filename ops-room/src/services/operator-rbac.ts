export const OPERATOR_ROLE_NAMES = Object.freeze([
  'viewer',
  'operator',
  'reviewer',
  'administrator',
  'deployer',
] as const);

export const OPERATOR_PERMISSION_NAMES = Object.freeze([
  'dashboard.read',
  'task.manage',
  'workflow.recover',
  'workflow.approve',
  'agent.lifecycle',
  'agent.configure',
  'policy.manage',
  'session.manage',
  'repository.manage',
  'release.approve',
] as const);

export type OperatorRole = (typeof OPERATOR_ROLE_NAMES)[number];
export type OperatorPermission = (typeof OPERATOR_PERMISSION_NAMES)[number];

const ROLE_PERMISSIONS: Readonly<Record<OperatorRole, readonly OperatorPermission[]>> = Object.freeze({
  viewer: Object.freeze([
    'dashboard.read',
  ]),
  operator: Object.freeze([
    'dashboard.read',
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

const ROLE_SET = new Set<string>(OPERATOR_ROLE_NAMES);
const PERMISSION_SET = new Set<string>(OPERATOR_PERMISSION_NAMES);

function roleCandidates(input: unknown): string[] {
  if (Array.isArray(input)) return input.map((value) => String(value || '').trim());
  return String(input || '').split(',').map((value) => value.trim());
}

export function normalizeOperatorRoles(input: unknown): readonly OperatorRole[] {
  const roles = roleCandidates(input).filter(Boolean);
  if (roles.length === 0) throw new Error('operator_roles_missing');

  const unique: OperatorRole[] = [];
  for (const role of roles) {
    if (!ROLE_SET.has(role)) throw new Error(`operator_role_unknown:${role}`);
    if (!unique.includes(role as OperatorRole)) unique.push(role as OperatorRole);
  }

  return Object.freeze(unique);
}

export function permissionsForOperatorRoles(input: unknown): readonly OperatorPermission[] {
  const roles = normalizeOperatorRoles(input);
  const permissions = new Set<OperatorPermission>();
  for (const role of roles) {
    for (const permission of ROLE_PERMISSIONS[role]) permissions.add(permission);
  }
  return Object.freeze([...permissions]);
}

export function hasOperatorPermission(input: unknown, permission: unknown): boolean {
  const normalizedPermission = String(permission || '').trim();
  if (!PERMISSION_SET.has(normalizedPermission)) return false;

  try {
    return permissionsForOperatorRoles(input).includes(normalizedPermission as OperatorPermission);
  } catch {
    return false;
  }
}

export function requireOperatorPermission(input: unknown, permission: unknown): void {
  if (!hasOperatorPermission(input, permission)) {
    throw new Error(`operator_permission_denied:${String(permission || 'unknown')}`);
  }
}
