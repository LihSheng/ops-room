import { execSync, execFileSync } from 'node:child_process';
import { readFile, writeFile, mkdir, appendFile, rm } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { REPO, WORKSPACE_BASE, SHARED_MEMORY, FORBIDDEN_FILE_PATTERNS } from '../services/runtime-paths.mjs';
import { AGENT_NAMES, BOT_USERS } from '../lib/config.mjs';
import { githubToken, addComment, transitionLabels, ensureLabel } from '../services/github.mjs';
import { writeTaskLog } from '../services/logs.mjs';
import {
  commandExists,
  runCodingAgent,
  execCapture,
  validateCodingWorkspace,
  collectGitDebugSnapshot,
  commitIfChanges,
  pushBranch,
  hasGitChanges,
  getChangedFiles,
  getGitDiffStat,
  configureGitAuthor,
  execLogged,
} from './github-code.mjs';
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

/**
 * Checkout an existing PR branch for fixing.
 * Returns a ctx-like object for the fix workflow.
 */
async function prepareFixWorkspace(repository, pr, fixAgent, headRef) {
  const workspaceDir = join(WORKSPACE_BASE, `fix-${repository.replace('/', '-')}-pr-${pr}-${fixAgent}`);
  const parent = dirname(workspaceDir);
  
  // Clean existing workspace
  try {
    await rm(workspaceDir, { recursive: true, force: true });
  } catch { }
  try {
    await mkdir(parent, { recursive: true });
  } catch { }
  
  const token = githubToken(fixAgent);
  const env = { ...process.env, GH_TOKEN: token };
  
  console.log(`[auto-fix] Cloning ${repository} for PR #${pr}`);
  
  // Clone repo
  execFileSync('gh', ['repo', 'clone', repository, workspaceDir], {
    encoding: 'utf-8',
    stdio: 'pipe',
    env,
  });
  
  // Set authenticated remote
  execFileSync('git', ['remote', 'set-url', 'origin', `https://x-access-token:${token}@github.com/${repository}.git`], {
    encoding: 'utf-8',
    stdio: 'pipe',
    cwd: workspaceDir,
  });
  
  // Fetch PR branch
  execFileSync('git', ['fetch', 'origin', '--prune'], {
    encoding: 'utf-8',
    stdio: 'pipe',
    cwd: workspaceDir,
  });
  
  // Checkout PR branch
  const branchToCheckout = headRef || `pr/${pr}`;
  try {
    execFileSync('git', ['checkout', branchToCheckout], {
      encoding: 'utf-8',
      stdio: 'pipe',
      cwd: workspaceDir,
    });
  } catch {
    // Try fetching the PR ref directly
    try {
      execSync(`git fetch origin pull/${pr}/head:${branchToCheckout}`, {
        encoding: 'utf-8',
        stdio: 'pipe',
        cwd: workspaceDir,
      });
      execFileSync('git', ['checkout', branchToCheckout], {
        encoding: 'utf-8',
        stdio: 'pipe',
        cwd: workspaceDir,
      });
    } catch (e) {
      throw new Error(`Cannot checkout PR branch ${branchToCheckout}: ${e.message}`);
    }
  }
  
  console.log(`[auto-fix] Workspace ready at ${workspaceDir} on branch ${branchToCheckout}`);
  
  return {
    workspaceDir,
    branchName: branchToCheckout,
    repo: repository,
    issueNumber: pr,
    issueTitle: `PR #${pr} auto-fix`,
    agent: fixAgent,
    defaultBranch: 'main',
  };
}

/**
 * Build an auto-fix context for the coding agent prompt.
 */
function buildFixCtx(repository, pr, fixAgent, headRef, workspaceDir, branchName) {
  return {
    agent: fixAgent,
    repo: repository,
    issueNumber: pr,
    issueTitle: `Auto-fix for PR #${pr}`,
    issueBody: 'Auto-fix from review loop',
    issue: { user: { login: 'auto-fix' } },
    comments: [],
    requester: 'auto-fix',
    task: `Fix issues flagged in review of PR #${pr}`,
    taskId: `fix-pr-${pr}-${fixAgent}-${Date.now()}`,
    branchName: branchName || headRef || `fix-pr-${pr}`,
    workspaceDir,
    startedAt: new Date().toISOString(),
    checkResults: [],
    diffStat: '',
    codingTimeoutMs: 30 * 60 * 1000,
  };
}

/**
 * Run the auto-fix workflow: fix issues on the PR branch, push, re-trigger review.
 * 
 * @param {object} params
 * @param {string} params.repository - e.g. 'LihSheng/LinkUp'
 * @param {number} params.pr - PR number
 * @param {string} params.fixAgent - Agent to do the fixing (e.g. 'berlin')
 * @param {string} params.reviewAgent - Agent that did the review (e.g. 'professor')
 * @param {string} params.reviewText - Full review text
 * @param {string} params.prTitle - PR title
 * @param {string} params.prAuthor - PR author
 * @param {string} params.headRef - PR head branch ref
 * @param {string} params.baseRef - PR base branch ref
 * @returns {Promise<{ok: boolean, message: string}>}
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

  console.log(`[auto-fix] Starting auto-fix for ${repository}#${pr} (agent: ${fixAgent}, iteration check)`);

  // Ensure review loop directory exists
  await ensureReviewLoopDir();

  // Check iteration limit
  if (await isLoopExhausted(repository, pr, MAX_AUTO_FIX_ITERATIONS)) {
    const msg = `Max auto-fix iterations (${MAX_AUTO_FIX_ITERATIONS}) reached for ${repository}#${pr}. Escalating to human.`;
    console.log(`[auto-fix] ${msg}`);
    
    await appendToMemory(msg);
    await addComment(pr, `**Auto-Fix Loop** — max iterations reached ⚠️\n\nThis PR has been through ${MAX_AUTO_FIX_ITERATIONS} review→fix cycles. Manual review is required.\n\nLabel: \`openab/needs-human\``, reviewAgent);
    
    await transitionLabels(
      { issueNumber: pr, agent: reviewAgent },
      { remove: ['openab/review-loop', 'openab/changes-requested'], add: ['openab/needs-human'] }
    );
    
    await updateReviewLoopState(repository, pr, { status: 'escalated' });
    
    return { ok: false, message: 'Max iterations reached, escalated to human' };
  }

  // Parse review issues
  const parsedIssues = parseReviewIssues(reviewText);
  console.log(`[auto-fix] Parsed ${parsedIssues.length} issues from review`);

  // Acquire loop lock
  // const locked = await acquireReviewLoopLock(repository, pr);
  // if (!locked) {
  //   return { ok: false, message: 'Review loop already in progress for this PR' };
  // }
  
  try {
    // Update state to fixing
    await updateReviewLoopState(repository, pr, {
      status: 'fixing',
      fixAgent,
      agent: reviewAgent,
    });

    await addComment(pr, `**OpenAB / ${AGENT_NAMES[fixAgent] || fixAgent}** — auto-fix in progress 🛠️\n\nI'm fixing the issues flagged in the review. This will be re-reviewed automatically.`, fixAgent);

    // Build fix prompt
    const prompt = buildFixPrompt({
      reviewText,
      parsedIssues,
      repository,
      pr,
      prTitle,
      prAuthor,
      headRef,
      baseRef,
    });

    // Prepare workspace with PR branch checked out
    console.log(`[auto-fix] Preparing fix workspace for ${repository}#${pr} branch ${headRef}`);
    const fixCtx = await prepareFixWorkspace(repository, pr, fixAgent, headRef);
    
    // Write prompt file for the coding agent
    const promptDir = join(fixCtx.workspaceDir, '.openab');
    await mkdir(promptDir, { recursive: true });
    await writeFile(join(promptDir, 'FIX.md'), prompt);
    
    // Build a coding ctx that uses the fix prompt
    const codingCtx = {
      ...fixCtx,
      task: `Fix issues from PR review of #${pr}`,
      taskId: `auto-fix-${pr}-${fixAgent}-${Date.now()}`,
      checkResults: [],
      diffStat: '',
      codingTimeoutMs: 30 * 60 * 1000,
    };

    // Validate workspace
    await validateCodingWorkspace(codingCtx);
    
    const beforeSnapshot = await collectGitDebugSnapshot(codingCtx.workspaceDir);
    console.log('[auto-fix] before snapshot:', JSON.stringify(beforeSnapshot, null, 2));

    // Write the prompt to TASK.md so runCodingAgent picks it up
    const taskPromptPath = join(codingCtx.workspaceDir, '.openab', 'TASK.md');
    await writeFile(taskPromptPath, prompt);
    
    // Run the coding agent
    console.log(`[auto-fix] Running ${fixAgent} coding agent on PR #${pr}`);
    await runCodingAgent(codingCtx);
    
    const afterSnapshot = await collectGitDebugSnapshot(codingCtx.workspaceDir);
    console.log('[auto-fix] after snapshot:', JSON.stringify(afterSnapshot, null, 2));

    // Check for changes
    const changedFiles = getChangedFiles(codingCtx);
    console.log(`[auto-fix] Changed files: ${changedFiles.length > 0 ? changedFiles.join(', ') : 'none'}`);

    if (changedFiles.length === 0) {
      // No changes — agent decided nothing to fix or couldn't fix
      console.log('[auto-fix] No file changes produced by coding agent');
      
      await addComment(pr, `**OpenAB / ${AGENT_NAMES[fixAgent] || fixAgent}** — no changes needed 🤷\n\nThe coding agent found nothing to fix in response to the review. Re-reviewing the PR as-is.`, fixAgent);
      
      // Still advance iteration and re-review
      await advanceLoopIteration(repository, pr, {
        event: 'no_changes_needed',
        summary: 'Coding agent produced no changes',
        fixAgent,
      });
      
      return { ok: true, message: 'No changes needed', needsReReview: true };
    }

    // Configure git author
    configureGitAuthor(codingCtx);
    
    // Commit and push
    const diffStat = getGitDiffStat(codingCtx);
    console.log(`[auto-fix] Diff stat:\n${diffStat}`);

    await execLogged(`cd "${codingCtx.workspaceDir}" && git add .`, codingCtx);
    await execLogged(`cd "${codingCtx.workspaceDir}" && git commit -m "Auto-fix: address PR review feedback for #${pr}"`, codingCtx);
    await pushBranch(codingCtx);

    console.log(`[auto-fix] Fix pushed to ${headRef}`);

    // Add a comment on the PR
    await addComment(pr, `**OpenAB / ${AGENT_NAMES[fixAgent] || fixAgent}** — fix pushed ✅\n\nI've addressed the review feedback and pushed changes to \`${headRef}\`. The PR will be re-reviewed automatically.\n\n${diffStat ? `\n\`\`\`\n${diffStat}\n\`\`\`` : ''}`, fixAgent);

    // Advance iteration counter
    await advanceLoopIteration(repository, pr, {
      event: 'fix_pushed',
      summary: `Fix pushed by ${fixAgent} with ${changedFiles.length} file(s) changed`,
      fixAgent,
      changedFiles,
    });

    await appendToMemory(`Auto-fix pushed to ${repository}#${pr} by ${fixAgent}: ${changedFiles.length} file(s)`);

    return { ok: true, message: `Fix pushed (${changedFiles.length} file(s) changed)`, needsReReview: true };

  } catch (error) {
    const msg = error?.message || String(error);
    console.error(`[auto-fix] Fix workflow failed for ${repository}#${pr}:`, msg.slice(0, 500));
    
    await addComment(pr, `**Auto-Fix Loop** — fix attempt failed ❌\n\n\`\`\`\n${msg.slice(0, 2000)}\n\`\`\`\n\nEscalating for manual review.`, reviewAgent);
    
    await updateReviewLoopState(repository, pr, { status: 'failed' });
    
    await transitionLabels(
      { issueNumber: pr, agent: reviewAgent },
      { remove: ['openab/review-loop'], add: ['openab/needs-human', 'openab/auto-fix-failed'] }
    );
    
    await appendToMemory(`Auto-fix FAILED for ${repository}#${pr}: ${msg.slice(0, 200)}`);
    
    return { ok: false, message: msg };
  } finally {
    // Release lock
    // await releaseReviewLoopLock(repository, pr);
    // Cleanup workspace unless KEEP is set
    if (!process.env.OPS_ROOM_KEEP_WORKSPACE) {
      try {
        const workspaceDir = join(WORKSPACE_BASE, `fix-${repository.replace('/', '-')}-pr-${pr}-${fixAgent}`);
        await rm(workspaceDir, { recursive: true, force: true });
      } catch { }
    }
  }
}

export default {
  runAutoFixWorkflow,
  parseReviewIssues,
  buildFixPrompt,
};
