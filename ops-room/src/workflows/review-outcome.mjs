export function taskStateForReviewEvent(event) {
  switch (event) {
    case 'APPROVE': return 'PASSED';
    case 'REQUEST_CHANGES': return 'CHANGES_REQUESTED';
    case 'SUPERSEDED': return 'SUPERSEDED';
    default: return 'NEEDS_HUMAN';
  }
}

export function commitStatusForReviewEvent(event) {
  if (event === 'APPROVE') return { state: 'success', description: 'Approved' };
  if (event === 'REQUEST_CHANGES') return { state: 'failure', description: 'Changes requested' };
  if (event === 'SUPERSEDED') return { state: 'error', description: 'Review superseded by a newer commit' };
  return { state: 'error', description: 'Review requires human attention' };
}
