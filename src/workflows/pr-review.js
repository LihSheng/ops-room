import { execFileSync } from 'node:child_process';
import { AGENT_NAMES } from '../lib/config.js';
import { ghApi, ghApiText, addComment, addPullRequestReview, transitionLabels } from '../services/github.js';
import { REPO, SHARED_MEMORY, REPOSITORY_CACHE_ROOT, TASK_WORKSPACE_ROOT, WORKSPACE_RECORDS_DIR, WORKSPACE_LOCK_DIR, WORKSPACE_MAX_ACTIVE, WORKSPACE_MIN_FREE_BYTES, } from '../services/runtime-paths.js';
import { appendFile } from 'node:fs/promises';
import { buildPrReviewPrompt } from '../server/pr-review-payload.js';
import { askAI } from './chat-response.js';
import { parseStructuredReview } from './review-result.js';
import { claimEffect, completeEffect, reclaimEffect } from '../services/review-effect-ledger.js';
import { readTask, transitionTask } from '../services/review-task-store.js';
import { ensureTaskWorkspace, taskWorkspacePatch } from '../services/task-workspace-binding.js';
import { assertReviewNotCancelled } from './review-worker-guard.js';
export function isCurrentReviewHead({ expectedSha, currentSha }) {
    return !expectedSha || expectedSha === currentSha;
}
export function renderStructuredReview(result) {
    const findings = result.findings.length === 0
        ? 'None.'
        : result.findings.map((finding, index) => [
            `### ${index + 1}. ${finding.title}`,
            `- **Severity:** ${finding.severity}`,
            `- **Location:** ${finding.file}${finding.line ? `:${finding.line}` : ''}`,
            `- **Description:** ${finding.description}`,
            `- **Suggestion:** ${finding.suggestion || 'None provided'}`,
            `- **Auto-fixable:** ${finding.auto_fixable ? 'yes' : 'no'}`,
        ].join('\n')).join('\n\n');
    return `## Summary\n${result.summary || '(none)'}\n\n## Findings\n${findings}\n\n## Final Verdict\n${result.verdict}`;
}
async function appendToMemory(entry) {
    try {
        const ts = new Date().toISOString().replace('T', ' ').replace(/\.\d{3}Z/, '');
        await appendFile(SHARED_MEMORY, `- ${ts}: [GitHub Issue] ${entry}\n`);
    }
    catch (e) {
        console.error(`[pr-review] Failed to write to shared memory:`, e?.message?.slice(0, 200));
    }
}
async function fetchPrReviewContext({ repository, pr, agent }) {
    const prData = ghApi('GET', `repos/${repository}/pulls/${pr}`, agent);
    const diff = ghApiText('GET', `repos/${repository}/pulls/${pr}`, agent, ['Accept: application/vnd.github.v3.diff']);
    return {
        repository,
        pr,
        prTitle: prData.title || '',
        prBody: prData.body || '',
        prAuthor: prData.user?.login || 'unknown',
        baseRef: prData.base?.ref || '',
        headRef: prData.head?.ref || '',
        headSha: prData.head?.sha || null,
        diff,
    };
}
async function bindReviewWorkspace({ dir, taskId, headSha, lease }) {
    if (!dir || !taskId)
        return null;
    let task = await readTask({ dir, id: taskId });
    if (!task)
        throw new Error('review_task_unavailable');
    const binding = await ensureTaskWorkspace({
        task,
        cacheRoot: REPOSITORY_CACHE_ROOT,
        workspaceRoot: TASK_WORKSPACE_ROOT,
        recordRoot: WORKSPACE_RECORDS_DIR,
        lockRoot: WORKSPACE_LOCK_DIR,
        remote: `https://github.com/${task.repository}.git`,
        maxActiveWorkspaces: WORKSPACE_MAX_ACTIVE,
        minimumFreeBytes: WORKSPACE_MIN_FREE_BYTES,
    });
    if (task.state === 'CLAIMED') {
        task = await transitionTask({
            dir,
            id: taskId,
            to: 'RUNNING',
            reason: binding.reused ? 'review_workspace_recovered' : 'review_workspace_allocated',
            patch: taskWorkspacePatch(binding),
            leaseEpoch: lease?.lease_epoch,
        });
    }
    else if (task.state !== 'RUNNING') {
        throw new Error('review_workspace_task_not_executable');
    }
    let actualSha;
    try {
        actualSha = execFileSync('git', ['-C', binding.workspace_path, 'rev-parse', 'HEAD'], {
            encoding: 'utf8', timeout: 10_000, stdio: 'pipe', windowsHide: true,
        }).trim().toLowerCase();
    }
    catch {
        throw new Error('review_workspace_sha_unavailable');
    }
    if (!headSha || actualSha !== String(headSha).toLowerCase()) {
        throw new Error('review_workspace_sha_mismatch');
    }
    return binding;
}
export async function runPrReviewWorkflow(payload) {
    const { agent, task, task_type, repository, pr, mode, commenter = 'unknown', comment_id, head_sha, task_id, dir, lease, } = payload;
    await bindReviewWorkspace({ dir, taskId: task_id, headSha: head_sha, lease });
    const prContext = await fetchPrReviewContext({ repository, pr, agent });
    if (!isCurrentReviewHead({ expectedSha: head_sha, currentSha: prContext.headSha })) {
        return { mode: 'pr_review', repository, pr, agent, review_event: 'SUPERSEDED', reviewed_sha: head_sha, current_sha: prContext.headSha };
    }
    const prompt = buildPrReviewPrompt({ agent: AGENT_NAMES[agent] || agent, task, repository, pr, mode, ...prContext });
    let reviewText = (await askAI(prompt)).trim();
    if (!reviewText) {
        console.warn(`[pr-review] Empty response from askAI for ${repository}#${pr}, retrying once...`);
        const retryText = (await askAI(prompt)).trim();
        if (!retryText)
            throw new Error(`PR review generation returned an empty response for ${repository}#${pr} (retried once)`);
        reviewText = retryText;
    }
    const responseMode = task_type === 'chat' ? 'chat' : 'review';
    let event = 'COMMENT';
    let structuredReview = null;
    if (responseMode === 'chat') {
        if (dir && task_id) {
            const effect = await claimEffect({
                dir, taskId: task_id, kind: 'github_issue_comment',
                fingerprint: `${head_sha || prContext.headSha}:${comment_id || 'chat'}:${reviewText.slice(0, 80)}`,
                leaseId: lease?.lease_id, leaseEpoch: lease?.lease_epoch,
            });
            if (!effect.claimed) {
                if (effect.state === 'COMPLETED')
                    return { mode: 'pr_chat', repository, pr, agent, review_event: 'COMMENT', duplicate_effect: true };
                if (effect.state === 'CLAIMED')
                    return { mode: 'pr_chat', repository, pr, agent, review_event: 'NEEDS_HUMAN', ambiguous_effect: true, effect_id: effect.effect?.id };
                const reclaimed = await reclaimEffect({ dir, effectId: effect.effect.id, leaseId: lease?.lease_id, leaseEpoch: lease?.lease_epoch });
                if (!reclaimed.reclaimed)
                    return { mode: 'pr_chat', repository, pr, agent, review_event: 'NEEDS_HUMAN', ambiguous_effect: true, effect_id: effect.effect?.id };
                effect.effect = reclaimed.effect;
            }
            await addComment(pr, `**${AGENT_NAMES[agent] || agent}** — response 🤖\n\n${reviewText}`, agent);
            await completeEffect({ dir, effectId: effect.effect.id, result: { pr, agent, comment_id }, leaseId: lease?.lease_id, leaseEpoch: lease?.lease_epoch });
        }
        else {
            await addComment(pr, `**${AGENT_NAMES[agent] || agent}** — response 🤖\n\n${reviewText}`, agent);
        }
    }
    else {
        let structured;
        try {
            structured = parseStructuredReview(reviewText);
        }
        catch (error) {
            reviewText = (await askAI(`${prompt}\n\nYour previous response was invalid: ${error.message}. Return valid JSON only.`)).trim();
            structured = parseStructuredReview(reviewText);
        }
        const latestPr = ghApi('GET', `repos/${repository}/pulls/${pr}`, agent);
        const latestSha = latestPr?.head?.sha;
        if (!isCurrentReviewHead({ expectedSha: head_sha, currentSha: latestSha })) {
            return { mode: 'pr_review', repository, pr, agent, review_event: 'SUPERSEDED', reviewed_sha: head_sha, current_sha: latestSha };
        }
        structuredReview = structured;
        if (dir && task_id)
            assertReviewNotCancelled(await readTask({ dir, id: task_id }));
        event = structured.verdict === 'NEEDS_HUMAN' ? 'COMMENT' : structured.verdict;
        const renderedReview = renderStructuredReview(structured);
        if (dir && task_id) {
            const effect = await claimEffect({
                dir, taskId: task_id, kind: 'github_review',
                fingerprint: `${head_sha || prContext.headSha}:${event}:${renderedReview}`,
                leaseId: lease?.lease_id, leaseEpoch: lease?.lease_epoch,
            });
            if (!effect.claimed) {
                if (effect.state === 'COMPLETED')
                    return { mode: 'pr_review', repository, pr, agent, review_event: event, structured_review: structured, duplicate_effect: true };
                if (effect.state === 'CLAIMED')
                    return { mode: 'pr_review', repository, pr, agent, review_event: 'NEEDS_HUMAN', structured_review: structured, ambiguous_effect: true, effect_id: effect.effect?.id };
                const reclaimed = await reclaimEffect({ dir, effectId: effect.effect.id, leaseId: lease?.lease_id, leaseEpoch: lease?.lease_epoch });
                if (!reclaimed.reclaimed)
                    return { mode: 'pr_review', repository, pr, agent, review_event: 'NEEDS_HUMAN', structured_review: structured, ambiguous_effect: true, effect_id: effect.effect?.id };
                effect.effect = reclaimed.effect;
            }
            await addPullRequestReview(pr, renderedReview, event, agent);
            await completeEffect({ dir, effectId: effect.effect.id, result: { event, sha: head_sha || prContext.headSha }, leaseId: lease?.lease_id, leaseEpoch: lease?.lease_epoch });
        }
        else {
            await addPullRequestReview(pr, renderedReview, event, agent);
        }
    }
    await appendToMemory(`PR review from ${repository}#${pr} by @${commenter} → **${agent}**: ${task}`);
    return { mode: responseMode === 'chat' ? 'pr_chat' : 'pr_review', repository, pr, agent, review_event: event, structured_review: structuredReview };
}
//# sourceMappingURL=pr-review.js.map