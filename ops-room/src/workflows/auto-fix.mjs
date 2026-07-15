import { execSync } from 'node:child_process';
import { mkdir, appendFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { REPO, WORKSPACE_BASE, SHARED_MEMORY } from '../services/runtime-paths.mjs';
import { AGENT_NAMES, BOT_USERS } from '../lib/config.mjs';
import { addComment, transitionLabels } from '../services/github.mjs';
import { updateReviewLoopState, advanceLoopIteration, isLoopExhausted, ensureReviewLoopDir } from '../services/review-loop-store.mjs';

const MAX_AUTO_FIX_ITERATIONS = parseInt(process.env.OPENAB_MAX_REVIEW_ITERATIONS || '3', 10);

function ts() {
  return new Date().toISOString().replace('T', ' ').replace(/\.\d{3}Z/, '');
}

async function appendToMemory(entry) {
  try {
    await appendFile(SHARED_MEMORY, `- ${ts()}: [Auto-Fix] ${entry}\n`);
  } catch { }
}

/**
 * Parse structured review feedback into actionable fix items.
 * Expects the review output format:
 *   ## Issues Found
 *   ### Issue N: <title>
 *   - **File**: <path>
 *   - **Line**: <range>
 *   - **Severity**: <HIGH|MEDIUM|LOW>
 *   - **Description**: <text>
 *   - **Suggestion**: <text>
 */
function parseReviewIssues(reviewText) {
  const issues = [];
  const blocks = reviewText.split(/###\s+Issue\s+\d+/i);
  
  for (const block of blocks.slice(1)) {
    const fileMatch = block.match(/\*\*File\*\*:\s*(.+?)(?:\n|$)/);
    const lineMatch = block.match(/\*\*Line\*\*:\s*(.+?)(?:\n|$)/);
    const severityMatch = block.match(/\*\*Severity\*\*:\s*(.+?)(?:\n|$)/);
    const descMatch = block.match(/\*\*Description\*\*:\s*([\s\S]*?)(?:\*\*Suggestion|\*\*File|\*\*Line|\*\*Severity|$)/);
    const suggestionMatch = block.match(/\*\*Suggestion\*\*:\s*([\s\S]*?)(?:\n###|\n##|$)/);

    if (fileMatch || descMatch) {
      issues.push({
        file: fileMatch?.[1]?.trim() || 'unknown',
        line: lineMatch?.[1]?.trim() || null,
        severity: severityMatch?.[1]?.trim() || 'MEDIUM',
        description: descMatch?.[1]?.trim() || block.trim(),
        suggestion: suggestionMatch?.[1]?.trim() || null,
      });
    }
  }

  return issues;
}

/**
 * Build a structured fix prompt for the coding agent based on review feedback.
 */
function buildFixPrompt({ reviewText, parsedIssues, repository, pr, prTitle, prAuthor, headRef, baseRef }) {
  const issuesSection = parsedIssues.length > 0
    ? parsedIssues.map((issue, i) => `
Issue ${i + 1}: ${issue.description.split('\n')[0]}
  File: ${issue.file}${issue.line ? ` (line ${issue.line})` : ''}
  Severity: ${issue.severity}
${issue.suggestion ? `  Suggestion: ${issue.suggestion}` : ''}
`).join('\n')
    : '(See review comments above for details)';

  return `You are an OpenAB coding agent performing an automated fix based on a PR review.

Repository: ${repository}
Pull Request: #${pr}
Title: ${prTitle || '(unknown)'}
Author: ${prAuthor || '(unknown)'}
Branch: ${headRef || '(unknown)'}
Base: ${baseRef || '(unknown)'}

## Context
This PR was reviewed and changes were requested. You need to fix the issues flagged in the review.

You are working on the EXISTING PR branch. Do NOT create a new branch.

## Issues to Fix

${issuesSection}

## Review Feedback (Full)

${reviewText || '(none provided)'}

## Instructions

1. Read the review feedback carefully.
2. Fix ONLY the issues mentioned in the review.
3. Do NOT introduce unrelated changes.
4. Do NOT modify files not mentioned in the review unless necessary to support the fix.
5. Keep changes minimal — the smallest fix that addresses each issue.
6. Run any available checks (lint, build, test) after fixing.
7. Leave the repo in a committable state.
8. The harness owns Git operations — do not run git commands yourself.
9. If the review issue is unclear or cannot be reproduced, add a comment explaining why.

## Hard Rules
- Do not merge.
- Do not create new branches.
- Do not push.
- Only fix what was flagged.`;
}

const AGENT_CONTAINER = {
  berlin: 'openab-opencode-1',
  tokyo: 'openab-opencode-2',
  professor: 'openab-opencode-professor',
};

/**
 * Checkout an existing PR branch for fixing via Docker exec into the agent's container.
 */
async function prepareFixWorkspace(repository, pr, fixAgent, headRef) {
  const dataDir = process.env.OPENAB_DATA_DIR || join(WORKSPACE_BASE, '..');
  const container = AGENT_CONTAINER[fixAgent];
  if (!container) throw new Error(`Unknown container for agent: ${fixAgent}`);

  // Place workspace inside agent's mounted home dir so it's accessible from container
  const agentHomeName = fixAgent === 'berlin' ? 'opencode-1' : fixAgent === 'tokyo' ? 'opencode-2' : fixAgent;
  const hostWorkspace = join(dataDir, 'agents', agentHomeName, 'workspace', `pr-${pr}-fix`);
  const containerWorkspace = `/home/node/workspace/pr-${pr}-fix`;

  // Clean existing
  try { await rm(hostWorkspace, { recursive: true, force: true }); } catch { }
  await mkdir(hostWorkspace, { recursive: true });

  const enc = (cmd) => JSON.stringify(cmd);

  // Clone via gh auth inside container (sets up git credential helpers automatically)
  console.log(`[auto-fix] Cloning ${repository} inside ${container} (agent: ${fixAgent})...`);
  execSync(`docker exec ${container} bash -c ${enc(`cd /home/node && gh repo clone ${repository} "${containerWorkspace}"`)}`, {
    encoding: 'utf-8', timeout: 120_000, stdio: 'pipe',
  });

  // Fetch and checkout PR branch
  execSync(`docker exec ${container} bash -c ${enc(`cd "${containerWorkspace}" && git fetch origin --prune`)}`, {
    encoding: 'utf-8', timeout: 60_000,
  });

  const branch = headRef || `pr-${pr}`;
  try {
    execSync(`docker exec ${container} bash -c ${enc(`cd "${containerWorkspace}" && git checkout "${branch}"`)}`, {
      encoding: 'utf-8', timeout: 30_000, stdio: 'pipe',
    });
  } catch {
    execSync(`docker exec ${container} bash -c ${enc(`cd "${containerWorkspace}" && git fetch origin pull/${pr}/head:"${branch}" && git checkout "${branch}"`)}`, {
      encoding: 'utf-8', timeout: 30_000, stdio: 'pipe',
    });
  }

  console.log(`[auto-fix] Workspace ready in ${container}:${containerWorkspace} on ${branch}`);

  return { hostWorkspace, containerWorkspace, container, branchName: branch };
}

/**
 * Run the auto-fix workflow: fix issues on the PR branch inside the agent's Docker container, push, re-trigger review.
 */
export async function runAutoFixWorkflow(params) {
  const {
    repository = REPO,
    pr,
    fixAgent = 'berlin',
    reviewAgent = 'professor',
    reviewText = '',
    prTitle = '',
    prAuthor = '',
    headRef = '',
    baseRef = '',
  } = params;

  console.log(`[auto-fix] Starting auto-fix for ${repository}#${pr} (fix: ${fixAgent}, review: ${reviewAgent})`);

  await ensureReviewLoopDir();

  // Check iteration limit
  if (await isLoopExhausted(repository, pr, MAX_AUTO_FIX_ITERATIONS)) {
    const msg = `Max auto-fix iterations (${MAX_AUTO_FIX_ITERATIONS}) reached for ${repository}#${pr}. Escalating.`;
    console.log(`[auto-fix] ${msg}`);
    await appendToMemory(msg);
    await addComment(pr, `**Auto-Fix Loop** — max iterations reached ⚠️\n\nManual review required.\n\nLabel: \`openab/needs-human\``, reviewAgent);
    await transitionLabels(
      { issueNumber: pr, agent: reviewAgent },
      { remove: ['openab/review-loop', 'openab/changes-requested'], add: ['openab/needs-human'] }
    );
    await updateReviewLoopState(repository, pr, { status: 'escalated' });
    return { ok: false, message: 'Max iterations reached, escalated to human' };
  }

  const parsedIssues = parseReviewIssues(reviewText);
  console.log(`[auto-fix] Parsed ${parsedIssues.length} issues from review`);

  try {
    await updateReviewLoopState(repository, pr, { status: 'fixing', fixAgent, agent: reviewAgent });

    await addComment(pr, `**OpenAB / ${AGENT_NAMES[fixAgent] || fixAgent}** — auto-fix in progress 🛠️\n\nI'm fixing the issues flagged in the review inside my container. Will re-review automatically.`, fixAgent);

    // Build fix prompt
    const prompt = buildFixPrompt({ reviewText, parsedIssues, repository, pr, prTitle, prAuthor, headRef, baseRef });

    // Prepare workspace inside container
    const ws = await prepareFixWorkspace(repository, pr, fixAgent, headRef);
    const { container, containerWorkspace } = ws;
    const enc = (cmd) => JSON.stringify(cmd);

    // Write prompt file on the HOST path that mirrors into the container
    const promptHostDir = join(ws.hostWorkspace, '.openab');
    await mkdir(promptHostDir, { recursive: true });
    const { writeFile } = await import('node:fs/promises');
    await writeFile(join(promptHostDir, 'TASK.md'), prompt);
    console.log(`[auto-fix] Prompt written to ${join(ws.hostWorkspace, '.openab', 'TASK.md')}`);

    const botUser = BOT_USERS[fixAgent] || `lihsheng-${fixAgent}[bot]`;
    execSync(`docker exec ${container} bash -c ${enc(`cd "${containerWorkspace}" && git config user.name "${botUser}" && git config user.email "${botUser}@users.noreply.github.com"`)}`, {
      encoding: 'utf-8', timeout: 10_000,
    });

    // Run opencode inside the container (not Codex on the host)
    console.log(`[auto-fix] Running opencode in ${container}:${containerWorkspace}...`);
    const startTime = Date.now();

    try {
      const result = execSync(`docker exec ${container} bash -c ${enc(`cd "${containerWorkspace}" && opencode run "${containerWorkspace}/.openab/TASK.md" 2>&1`)}`, {
        encoding: 'utf-8',
        timeout: 30 * 60 * 1000,
        maxBuffer: 50 * 1024 * 1024,
      });
      console.log(`[auto-fix] opencode finished in ${((Date.now() - startTime) / 1000).toFixed(1)}s`);
      const tail = result.slice(-2000);
      if (tail.trim()) console.log(`[auto-fix] opencode tail: ${tail}`);
    } catch (e) {
      const stdout = e.stdout?.toString()?.slice(-2000) || '';
      const stderr = e.stderr?.toString()?.slice(-2000) || '';
      console.log(`[auto-fix] opencode exit=${e.status} signal=${e.signal}`);
      if (stdout) console.log(`[auto-fix] stdout: ${stdout}`);
      if (stderr) console.log(`[auto-fix] stderr: ${stderr}`);
      // Continue — opencode may have made changes despite non-zero exit
    }

    // Check for actual source changes
    let statusOut = '';
    try {
      statusOut = execSync(`docker exec ${container} bash -c ${enc(`cd "${containerWorkspace}" && git status --short`)}`, {
        encoding: 'utf-8', timeout: 10_000,
      }).trim();
    } catch { }

    const realChanges = statusOut.split('\n')
      .filter(l => l.trim())
      .filter(l => !l.includes('.openab/'))
      .filter(l => l.startsWith(' M') || l.startsWith('M') || l.startsWith('??') || l.startsWith('A') || l.startsWith(' D') || l.startsWith('D'));

    console.log(`[auto-fix] Git status: ${statusOut ? statusOut.split('\n').length + ' entries' : 'clean'}`);

    if (realChanges.length === 0) {
      console.log('[auto-fix] No source changes produced');
      await addComment(pr, `**${AGENT_NAMES[fixAgent] || fixAgent}** — no changes needed 🤷\n\nThe agent reviewed the feedback but found nothing to fix. Re-reviewing as-is.`, fixAgent);
      await advanceLoopIteration(repository, pr, { event: 'no_changes', summary: 'No source changes', fixAgent });
      return { ok: true, message: 'No changes needed', needsReReview: true };
    }

    // Commit and push from inside the container
    console.log(`[auto-fix] Files changed:\n${realChanges.join('\n')}`);

    const gitCommands = [
      `cd "${containerWorkspace}"`,
      `git add -A`,
      `git commit -m "Auto-fix: address PR review feedback for #${pr}"`,
      `git push origin HEAD:refs/heads/"${headRef}" 2>&1`,
    ].join(' && ');

    try {
      const pushResult = execSync(`docker exec ${container} bash -c ${enc(gitCommands)}`, {
        encoding: 'utf-8', timeout: 60_000,
      });
      console.log(`[auto-fix] Push: ${pushResult.trim().slice(0, 500)}`);
    } catch (e) {
      const msg = e.stderr?.toString() || e.message;
      console.error(`[auto-fix] Push failed: ${msg.slice(0, 500)}`);
      await addComment(pr, `**Auto-Fix** — push failed ❌\n\n\`\`\`\n${msg.slice(0, 2000)}\n\`\`\``, reviewAgent);
      return { ok: false, message: `Push failed: ${msg.slice(0, 200)}` };
    }

    await addComment(pr, `**${AGENT_NAMES[fixAgent] || fixAgent}** — fix pushed ✅\n\nI've addressed the review feedback and pushed to \`${headRef}\`. Re-reviewing now.`, fixAgent);

    await advanceLoopIteration(repository, pr, {
      event: 'fix_pushed',
      summary: `Fix by ${fixAgent}: ${realChanges.length} file(s)`,
      fixAgent,
    });
    await appendToMemory(`Auto-fix pushed to ${repository}#${pr} by ${fixAgent}: ${realChanges.length} file(s)`);

    // Cleanup workspace inside container
    try {
      execSync(`docker exec ${container} rm -rf "${containerWorkspace}"`, { encoding: 'utf-8', timeout: 10_000 });
    } catch { }

    return { ok: true, message: `Fix pushed (${realChanges.length} file(s))`, needsReReview: true };

  } catch (error) {
    const msg = error?.message || String(error);
    console.error(`[auto-fix] Failed for ${repository}#${pr}:`, msg.slice(0, 500));
    await addComment(pr, `**Auto-Fix** — fix attempt failed ❌\n\n\`\`\`\n${msg.slice(0, 2000)}\n\`\`\`\n\nEscalating.`, reviewAgent);
    await updateReviewLoopState(repository, pr, { status: 'failed' });
    await transitionLabels(
      { issueNumber: pr, agent: reviewAgent },
      { remove: ['openab/review-loop'], add: ['openab/needs-human', 'openab/auto-fix-failed'] }
    );
    await appendToMemory(`Auto-fix FAILED for ${repository}#${pr}: ${msg.slice(0, 200)}`);
    return { ok: false, message: msg };
  }
}

export default {
  runAutoFixWorkflow,
  parseReviewIssues,
  buildFixPrompt,
};
