import {
  OPERATOR_DISPLAY_NAME,
  OPERATOR_ID,
} from './runtime-paths.js';

const SAFE_ACTOR_ID = /^[A-Za-z0-9._:-]{2,100}$/;

export function resolveOperatorIdentity({
  actorId = OPERATOR_ID,
  displayName = OPERATOR_DISPLAY_NAME,
  authMethod = 'operator_token',
} = {}) {
  const normalizedId = String(actorId || '').trim();
  const normalizedDisplayName = String(displayName || '').trim();

  if (!SAFE_ACTOR_ID.test(normalizedId)) {
    throw new Error('Operator identity is not configured');
  }
  if (!normalizedDisplayName || normalizedDisplayName.length > 120) {
    throw new Error('Operator display name is not configured');
  }

  return Object.freeze({
    actor_type: 'human_operator',
    actor_id: normalizedId,
    actor_display_name: normalizedDisplayName,
    auth_method: authMethod,
  });
}
