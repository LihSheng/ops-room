#!/usr/bin/env node

import { execSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = process.env.OPENAB_REPO || 'LihSheng/LinkUp';
const STATE_DIR = join(__dirname, '..', 'state');
const PROCESSED_TASKS_FILE = join(STATE_DIR, 'processed-tasks.json');
const LOCK_DIR = '/tmp/openab-locks';

function gh(args) {
  return execSync(`gh ${args} --repo "${REPO}"`, { encoding: 'utf-8', stdio: 'pipe' }).trim();
}

function ghApi(method, path) {
  const flag = method === 'GET' ? '' : ` -X ${method}`;
  return execSync(`gh api ${path}${flag}`, { encoding: 'utf-8', stdio: 'pipe' }).trim();
}

function parseMetadata(comments) {
  const ordered = [...comments].reverse();
  for (const c of ordered) {
    if (!c.body?.includes('<!-- openab-task')) continue;
    const agentMatch = c.body.match(/agent:\s*(.+?)(?:\n|$)/);
    const taskMatch = c.body.match(/task:\s*([\s\S]*?)(?:\nrepository:|\nissue:|\ncommenter:|\n-->)/);
    const commenterMatch = c.body.match(/commenter:\s*(\S+)/);
    const idMatch = c.body.match(/id:\s*(.+?)(?:\n|$)/);
    const typeMatch = c.body.match(/task_type:\s*(\S+)/);
    return {
      task: taskMatch?.[1]?.trim() || '',
      commenter: commenterMatch?.[1] || 'unknown',
      taskId: idMatch?.[1]?.trim() || null,
      taskType: typeMatch?.[1]?.trim() || null,
      agent: agentMatch?.[1]?.trim() || null,
    };
  }
  return null;
}

const codingKeywords = [
  "implement", "fix", "create pr", "pull request", "change code",
  "change files", "modify code", "update code", "add feature",
  "refactor", "run tests", "commit", "push branch", "open a pr",
  "create a branch", "work on it", "coding task",
];

function isCoding(task, title, body) {
  const text = `${task}\n${title}\n${body}`.toLowerCase();
  return codingKeywords.some(k => text.includes(k));
}

async function main() {
  const issueNumber = process.argv[2];
  if (!issueNumber) {
    console.error('Usage: node scripts/debug-issue.mjs <issue-number>');
    process.exit(1);
  }

  console.log(`=== Debug: Issue #${issueNumber} ===\n`);

  // Fetch issue
  let issue;
  try {
    const raw = gh(`issue view ${issueNumber} --json number,title,state,labels,body`);
    issue = JSON.parse(raw);
  } catch (e) {
    console.error(`Error fetching issue #${issueNumber}:`, e.message);
    process.exit(1);
  }

  console.log(`Title: ${issue.title}`);
  console.log(`State: ${issue.state}`);
  console.log(`Body: ${(issue.body || '(empty)').slice(0, 200)}...`);
  console.log(`Labels: ${(issue.labels || []).map(l => l.name).join(', ') || '(none)'}`);
  console.log('');

  // Fetch comments
  let comments = [];
  try {
    const raw = ghApi('GET', `repos/${REPO}/issues/${issueNumber}/comments`);
    comments = JSON.parse(raw);
  } catch {
    console.log('Comments: (could not fetch)');
  }

  console.log(`Comments: ${comments.length}`);
  if (comments.length > 0) {
    const latest = comments[comments.length - 1];
    console.log(`Latest comment by @${latest.user?.login}: ${(latest.body || '').slice(0, 150)}...`);
  }
  console.log('');

  // Parse metadata
  const meta = parseMetadata(comments);
  if (meta) {
    const metaAgent = meta.agent || '(not in metadata)';
    console.log('=== OpenAB Task Metadata (newest) ===');
    console.log(`  agent:     ${metaAgent}`);
    console.log(`  taskId:    ${meta.taskId || '(none)'}`);
    console.log(`  taskType:  ${meta.taskType || '(none)'}`);
    console.log(`  commenter: ${meta.commenter}`);
    console.log(`  task:      ${(meta.task || '(empty)').slice(0, 300)}`);
    console.log('');
  } else {
    console.log('No openab-task metadata found.\n');
  }

  // Processed tasks
  let processed = [];
  try {
    processed = JSON.parse(readFileSync(PROCESSED_TASKS_FILE, 'utf-8'));
  } catch {}
  console.log('=== Processed Tasks ===');
  const matching = processed.filter(id => id.includes(`issue-${issueNumber}`));
  if (matching.length > 0) {
    matching.forEach(id => console.log(`  ✓ ${id}`));
  } else {
    console.log('  (none matching this issue)');
  }
  console.log('');

// Lock files
console.log('=== Lock Files ===');
if (existsSync(LOCK_DIR)) {
  let lockFiles = [];
  try {
    const ls = execSync(`ls ${LOCK_DIR} 2>/dev/null || true`, { encoding: 'utf-8' });
    lockFiles = ls.trim().split('\n').filter(Boolean);
  } catch {}
  const matchingLocks = lockFiles.filter(f => f.includes(`issue-${issueNumber}`));
  if (matchingLocks.length > 0) {
    matchingLocks.forEach(f => console.log(`  🔒 ${f}`));
  } else {
    console.log('  (none)');
  }
} else {
  console.log('  (directory does not exist)');
}
  console.log('');

  // Routing detection
  console.log('=== Routing Detection ===');
  const agents = ['professor', 'berlin', 'tokyo'];
  for (const agent of agents) {
    const agentMeta = parseMetadata(comments);
    const metaAgent = agentMeta?.task?.split('\n')[0] || '';
    let routes = [];

    // Check flag
    if (meta?.taskType === 'code' || meta?.taskType === 'chat') {
      routes.push(`metadata task_type = ${meta.taskType}`);
    }

    // Check --code / --chat flag
    const taskText = meta?.task || '';
    if (taskText.includes('--code')) routes.push('--code flag present');
    if (taskText.includes('--chat')) routes.push('--chat flag present');

    // Check keywords
    const wouldBeCoding = isCoding(taskText, issue.title || '', issue.body || '');
    routes.push(`keyword detection: ${wouldBeCoding ? 'CODING' : 'CHAT'}`);

    console.log(`  ${agent}: ${routes.join(', ')}`);
  }
  console.log('');

  // GH CLI auth status
  console.log('=== GH CLI Status ===');
  try {
    const status = gh('auth status 2>&1');
    console.log(`  ${status.split('\n')[0]}`);
  } catch {
    console.log('  (not authenticated)');
  }
}

main().catch(e => {
  console.error('Fatal:', e.message);
  process.exit(1);
});
