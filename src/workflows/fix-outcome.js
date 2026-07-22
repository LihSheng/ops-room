export function classifyFixOutcome({ kind, newSha = null }) {
    switch (kind) {
        case 'NO_PARSEABLE_OUTPUT':
        case 'NO_SOURCE_CHANGES':
        case 'AMBIGUOUS_FINDING':
        case 'TESTS_FAILED':
            return { state: 'NEEDS_HUMAN', requeue: false };
        case 'PUSH_FAILED':
        case 'WORKSPACE_FAILED':
            return { state: 'ERROR', requeue: false };
        case 'SUPERSEDED':
            return { state: 'SUPERSEDED', requeue: false };
        case 'FIX_PUSHED':
            return { state: 'FIX_PUSHED', requeue: false, new_sha: newSha };
        default:
            throw new Error(`Unknown fix outcome: ${kind}`);
    }
}
//# sourceMappingURL=fix-outcome.js.map