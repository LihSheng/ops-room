import { AGENT_NAMES } from '../lib/config.mjs';
import { ghApi, ghApiText, addComment, addPullRequestReview, transitionLabels } from '../services/github.mjs';
import { REPO, SHARED_MEMORY } from '../services/runtime-paths.mjs';
import { appendFile } from 'node:fs/promises';
import { buildPrReviewPrompt } from '../server/pr-review-payload.mjs';
import { askAI } from './chat-response.mjs';
import { runAutoFixWorkflow } from './auto-fix.mjs';
import { ensureReviewLoopDir, getReviewLoopState, updateReviewLoopState, advanceLoopIteration } from '../services/review-loop-store.mjs';

function parseReviewEvent(reviewText) {
  const upper = String(reviewText || '').toUpperCase();
  if (upper.includes('REQUEST_CHANGES')) return 'REQUEST_CHANGES';
  if (upper.includes('APPROVE')) return 'APPROVE';
  return 'COMMENT';
}

async function appendToMemory(entry) {
  try {
    const ts = new Date().toISOString().replace('T', ' ').replace(/\.\d{3}Z/, '');
    await appendFile(SHARED_MEMORY, `- ${ts}: [GitHub Issue] ${entry}\n`);
  } catch { }
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
  } = payload;

  // Ensure review loop directory exists
  await ensureReviewLoopDir();

  // Track the review in loop state if in auto-fix mode
  if (mode === 'auto-fix') {
    await updateReviewLoopState(repository, pr, {
      agent,
      status: 'reviewing',
    });
  }

  const prContext = await fetchPrReviewContext({ repository, pr, agent });
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

  if (responseMode === 'chat') {
    addComment(pr, `**${AGENT_NAMES[agent] || agent}** — response 🤖\n\n${reviewText}`, agent);
    console.log(`[pr-review] Posted chat response on ${repository}#${pr} as ${agent}`);
  } else {
    event = parseReviewEvent(reviewText);
    addPullRequestReview(pr, reviewText, event, agent);
    console.log(`[pr-review] Posted ${event} review on ${repository}#${pr} as ${agent}`);

    // ── Auto-fix loop ──────────────────────────────────────────────────────
    if (mode === 'auto-fix' && event === 'REQUEST_CHANGES') {
      console.log(`[pr-review] Auto-fix mode: changes requested on ${repository}#${pr}. Dispatching fix...`);

      // Record review in loop state
      await advanceLoopIteration(repository, pr, {
        event: 'review_requested_changes',
        summary: reviewText.slice(0, 500),
        reviewer: agent,
      });

      // Run auto-fix
      const fixResult = await runAutoFixWorkflow({
        repository,
        pr,
        fixAgent: agent,         // Same agent does the fix
        reviewAgent: agent,
        reviewText,
        prTitle: prContext.prTitle,
        prAuthor: prContext.prAuthor,
        headRef: prContext.headRef,
        baseRef: prContext.baseRef,
      });

      // If fix produced changes, re-trigger review (recursive, next iteration)
      if (fixResult.ok && fixResult.needsReReview) {
        console.log(`[pr-review] Auto-fix succeeded on ${repository}#${pr}. Re-reviewing...`);

        // Re-run review recursively (will check iteration limit inside auto-fix on next round)
        return runPrReviewWorkflow({
          agent,
          task: 'Re-review after auto-fix. Check if previous issues were addressed and check for new issues.',
          task_type: 'review',
          repository,
          pr,
          mode: 'auto-fix',
          commenter: 'auto-fix-loop',
        });
      }

      if (!fixResult.ok) {
        console.log(`[pr-review] Auto-fix failed on ${repository}#${pr}: ${fixResult.message}`);
      }
    }

    // ── Auto-fix: approved ─────────────────────────────────────────────────
    if (mode === 'auto-fix' && event === 'APPROVE') {
      await advanceLoopIteration(repository, pr, {
        event: 'review_approved',
        summary: 'Review passed — all issues addressed',
        reviewer: agent,
      });

      await updateReviewLoopState(repository, pr, { status: 'approved' });
      console.log(`[pr-review] PR ${repository}#${pr} approved after auto-fix loop.`);
      await transitionLabels(
        { issueNumber: pr, agent },
        { remove: ['openab/review-pending', 'openab/changes-requested', 'openab/review-loop'], add: ['openab/review-approved'] }
      );
    }

    // ── Auto-fix: comment (no explicit approve/changes) ──────────────────
    // The review was informative. Remove loop labels and leave for human.
    if (mode === 'auto-fix' && event === 'COMMENT' && task_type !== 'chat') {
      await updateReviewLoopState(repository, pr, { status: 'commented' });
      await transitionLabels(
        { issueNumber: pr, agent },
        { remove: ['openab/review-pending', 'openab/review-loop'], add: [] }
      );
      console.log(`[pr-review] PR ${repository}#${pr} reviewed (COMMENT). Loop ended, awaiting human.`);
    }
  }

  await appendToMemory(`PR review from ${repository}#${pr} by @${commenter} → **${agent}**: ${task}`);

  return {
    mode: responseMode === 'chat' ? 'pr_chat' : 'pr_review',
    repository,
    pr,
    agent,
    review_event: event,
  };
}
