export function evaluateAutoFixPolicy({ requestedMode, policy = {}, findings = [] }) {
  if (requestedMode !== 'auto-fix' || policy.allow_auto_fix !== true) {
    return { allowed: false, reason: 'not_explicitly_enabled' };
  }
  if (policy.trusted_source !== true) {
    return { allowed: false, reason: 'untrusted_source' };
  }
  if (policy.same_repository !== true) {
    return { allowed: false, reason: 'fork_or_no_push_permission' };
  }
  if (findings.some((finding) => finding?.severity === 'critical' || finding?.auto_fixable === false || finding?.requires_human === true)) {
    return { allowed: false, reason: 'critical_or_ambiguous_finding' };
  }
  return { allowed: true, reason: 'allowed' };
}
