/**
 * DEPRECATED — Legacy auto-fix workflow has been retired.
 *
 * The canonical PR review/fix path is now SHA-aware and child-task-driven.
 * All fix execution MUST go through the SHA-fenced fix child task system:
 *   pr-review-controller → fix-task-controller → fix-child-executor → fix-worker
 *
 * The workspace setup helper (prepareFixWorkspace) has been moved to
 * src/workflows/fix-runtime.js, which is the only module that needs it.
 *
 * Calling runAutoFixWorkflow will throw — the legacy path is intentionally
 * disabled. Any code that still depends on this module must be migrated to
 * the canonical child-task flow.
 */
/**
 * @deprecated Use the SHA-fenced fix child task system instead.
 * @throws {Error} Always — the legacy auto-fix workflow is retired.
 */
export async function runAutoFixWorkflow(_params) {
    throw new Error('Legacy auto-fix workflow has been retired. ' +
        'Use the SHA-fenced fix child task system: ' +
        'pr-review-controller → fix-task-controller → fix-child-executor → fix-worker.');
}
/**
 * @deprecated Use {parseFiles} from fix-runtime.js instead.
 */
export function parseReviewIssues(_reviewText) {
    return [];
}
export default { runAutoFixWorkflow };
//# sourceMappingURL=auto-fix.js.map