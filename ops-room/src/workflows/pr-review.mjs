import { AGENT_NAMES } from '../lib/config.mjs';
import { ghApi, ghApiText, addComment, addPullRequestReview, transitionLabels } from '../services/github.mjs';
import { REPO, SHARED_MEMORY } from '../services/runtime-paths.mjs';
import { appendFile } from 'node:fs/promises';
import { buildPrReviewPrompt } from '../server/pr-review-payload.mjs';
import { askAI } from './chat-response.mjs';

function parseReviewEvent(reviewText) {
  const upper = String(reviewText || '').toUpperCase();
  if (upper.includes('REQUEST_CHANGES')) return 'REQUEST_CHANGES';
  if (upper.includes('APPROVE')) return 'APPROVE';
  
  // Smart heuristic: if the review found issues and listed them, treat as REQUEST_CHANGES
  // This handles cases where the AI doesn't output the exact magic word
  if (upper.includes('## ISSUES FOUND') || upper.includes('ISSUE 1:') || upper.includes('**ISSUE')) {
    return 'REQUEST_CHANGES';
  }
  
  return 'COMMENT';
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
  } = payload;

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
