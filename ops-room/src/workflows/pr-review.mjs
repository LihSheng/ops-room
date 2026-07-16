import { AGENT_NAMES } from '../lib/config.mjs';
import { ghApi, ghApiText, addComment, addPullRequestReview, transitionLabels } from '../services/github.mjs';
import { REPO, SHARED_MEMORY } from '../services/runtime-paths.mjs';
import { appendFile } from 'node:fs/promises';
import { buildPrReviewPrompt } from '../server/pr-review-payload.mjs';
import { askAI } from './chat-response.mjs';
import { parseStructuredReview } from './review-result.mjs';
import { claimEffect, completeEffect, reclaimEffect } from '../services/review-effect-ledger.mjs';
import { readTask } from '../services/review-task-store.mjs';
import { assertReviewNotCancelled } from './review-worker-guard.mjs';

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
  } catch (e) {
    console.error(`[pr-review] Failed to write to shared memory:`, e?.message?.slice(0, 200));
  }
}

async function fetchPrReviewContext({ repository, pr, agent }) {
  const prData = ghApi('GET', `repos/${repository}/pulls/${pr}`, agent);
  const diff = ghApiText(
    'GET',
    `repos/${repository}/pulls/${pr}`,
    agent,
    ['Accept: application/vnd.github.v3.diff']
  );

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

export async function runPrReviewWorkflow(payload) {
  const {
    agent,
    task,
    task_type,
    repository,
    pr,
    mode,
    commenter = 'unknown',
    comment_id,
    head_sha,
    task_id,
    dir,
  } = payload;

  const prContext = await fetchPrReviewContext({ repository, pr, agent });
  if (!isCurrentReviewHead({ expectedSha: head_sha, currentSha: prContext.headSha })) {
    return { mode: 'pr_review', repository, pr, agent, review_event: 'SUPERSEDED', reviewed_sha: head_sha, current_sha: prContext.headSha };
  }
  const prompt = buildPrReviewPrompt({
    agent: AGENT_NAMES[agent] || agent,
    task,
    repository,
    pr,
    mode,
    ...prContext,
  });

  let reviewText = (await askAI(prompt)).trim();
  if (!reviewText) {
    // Retry once — reasoning model may temporarily exhaust token budget
    console.warn(`[pr-review] Empty response from askAI for ${repository}#${pr}, retrying once...`);
    const retryText = (await askAI(prompt)).trim();
    if (!retryText) {
      throw new Error(`PR review generation returned an empty response for ${repository}#${pr} (retried once)`);
    }
    console.log(`[pr-review] Retry succeeded for ${repository}#${pr} (${retryText.length} chars)`);
    reviewText = retryText;
  }

  const responseMode = task_type === 'chat' ? 'chat' : 'review';
  let event = 'COMMENT';
  let structuredReview = null;

  if (responseMode === 'chat') {
    if (dir && task_id) {
      const effect = await claimEffect({
        dir,
        taskId: task_id,
        kind: 'github_issue_comment',
        fingerprint: `${head_sha || prContext.headSha}:${comment_id || 'chat'}:${reviewText.slice(0, 80)}`,
      });
      if (!effect.claimed) {
        // Branch on the existing effect's state — same semantics as review path.
        if (effect.state === 'COMPLETED') {
          console.warn(`[pr-review] Skipping duplicate comment effect for ${repository}#${pr}`);
          return { mode: 'pr_chat', repository, pr, agent, review_event: 'COMMENT', duplicate_effect: true };
        }
        if (effect.state === 'CLAIMED') {
          console.warn(`[pr-review] Existing CLAIMED comment effect for ${repository}#${pr} — ambiguous outcome`);
          return { mode: 'pr_chat', repository, pr, agent, review_event: 'NEEDS_HUMAN', ambiguous_effect: true, effect_id: effect.effect?.id };
        }
        // ABANDONED: attempt atomic re-claim before re-posting.
        const reclaimed = await reclaimEffect({ dir, effectId: effect.effect.id });
        if (!reclaimed.reclaimed) {
          return { mode: 'pr_chat', repository, pr, agent, review_event: 'NEEDS_HUMAN', ambiguous_effect: true, effect_id: effect.effect?.id };
        }
        // Re-claimed successfully — re-post the comment.
      }
      await addComment(pr, `**${AGENT_NAMES[agent] || agent}** — response 🤖\n\n${reviewText}`, agent);
      await completeEffect({ dir, effectId: effect.effect.id, result: { pr, agent, comment_id } });
    } else {
      await addComment(pr, `**${AGENT_NAMES[agent] || agent}** — response 🤖\n\n${reviewText}`, agent);
    }
    console.log(`[pr-review] Posted chat response on ${repository}#${pr} as ${agent}`);
  } else {
    let structured;
    try {
      structured = parseStructuredReview(reviewText);
    } catch (error) {
      // One regeneration prevents malformed model output from becoming an accidental approval.
      reviewText = (await askAI(`${prompt}\n\nYour previous response was invalid: ${error.message}. Return valid JSON only.`)).trim();
      structured = parseStructuredReview(reviewText);
    }
    const latestPr = ghApi('GET', `repos/${repository}/pulls/${pr}`, agent);
    const latestSha = latestPr?.head?.sha;
    if (!isCurrentReviewHead({ expectedSha: head_sha, currentSha: latestSha })) {
      return { mode: 'pr_review', repository, pr, agent, review_event: 'SUPERSEDED', reviewed_sha: head_sha, current_sha: latestSha };
    }
    structuredReview = structured;
    if (dir && task_id) assertReviewNotCancelled(await readTask({ dir, id: task_id }));
    event = structured.verdict === 'NEEDS_HUMAN' ? 'COMMENT' : structured.verdict;
    const renderedReview = renderStructuredReview(structured);
    if (dir && task_id) {
      const effect = await claimEffect({
        dir,
        taskId: task_id,
        kind: 'github_review',
        fingerprint: `${head_sha || prContext.headSha}:${event}:${renderedReview}`,
      });
      if (!effect.claimed) {
        // Branch on the existing effect's state:
        // - COMPLETED: reuse the recorded result (duplicate).
        // - CLAIMED: the external effect may never have been applied; stop with an
        //   ambiguous outcome requiring human attention.
        // - ABANDONED: permit a new, uniquely identified attempt (operator-resolved).
        if (effect.state === 'COMPLETED') {
          console.warn(`[pr-review] Skipping duplicate GitHub review effect for ${repository}#${pr}`);
          return { mode: 'pr_review', repository, pr, agent, review_event: event, structured_review: structured, duplicate_effect: true };
        }
        if (effect.state === 'CLAIMED') {
          console.warn(`[pr-review] Existing CLAIMED GitHub review effect for ${repository}#${pr} — ambiguous outcome`);
          return { mode: 'pr_review', repository, pr, agent, review_event: 'NEEDS_HUMAN', structured_review: structured, ambiguous_effect: true, effect_id: effect.effect?.id };
        }
        // ABANDONED: attempt atomic re-claim before re-posting.
        const reclaimed = await reclaimEffect({ dir, effectId: effect.effect.id });
        if (!reclaimed.reclaimed) {
          return { mode: 'pr_review', repository, pr, agent, review_event: 'NEEDS_HUMAN', structured_review: structured, ambiguous_effect: true, effect_id: effect.effect?.id };
        }
        // Re-claimed successfully — re-post the review.
      }
      await addPullRequestReview(pr, renderedReview, event, agent);
      await completeEffect({ dir, effectId: effect.effect.id, result: { event, sha: head_sha || prContext.headSha } });
    } else {
      await addPullRequestReview(pr, renderedReview, event, agent);
    }
    console.log(`[pr-review] Posted ${event} review on ${repository}#${pr} as ${agent}`);
  }

  await appendToMemory(`PR review from ${repository}#${pr} by @${commenter} → **${agent}**: ${task}`);

  return {
    mode: responseMode === 'chat' ? 'pr_chat' : 'pr_review',
    repository,
    pr,
    agent,
    review_event: event,
    structured_review: structuredReview,
  };
}
