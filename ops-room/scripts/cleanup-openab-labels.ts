#!/usr/bin/env node

import { execSync } from 'node:child_process';

const REPO = process.env.OPENAB_REPO || 'LihSheng/LinkUp';
const DRY_RUN = process.argv.includes('--dry-run');
const APPLY = process.argv.includes('--apply');

const OPENAB_LABEL_PREFIXES = [
  'openab/professor',
  'openab/berlin',
  'openab/tokyo',
];

const PROTECTED_LABELS = ['openab/pr-created'];

function gh(args) {
  return execSync(`gh ${args} --repo "${REPO}"`, { encoding: 'utf-8', stdio: 'pipe' }).trim();
}

function getOpenIssues() {
  const raw = gh('issue list --state open --json number,title,labels --limit 100');
  return JSON.parse(raw);
}

function isStaleOpenabLabel(name) {
  if (PROTECTED_LABELS.includes(name)) return false;
  for (const prefix of OPENAB_LABEL_PREFIXES) {
    if (name === prefix || name.startsWith(prefix + '/')) return true;
  }
  return false;
}

async function main() {
  console.log(`[cleanup] REPO: ${REPO}`);
  console.log(`[cleanup] Mode: ${DRY_RUN ? 'DRY-RUN (no changes)' : APPLY ? 'APPLY (making changes)' : 'USE --dry-run OR --apply'}`);

  if (!DRY_RUN && !APPLY) {
    console.log('[cleanup] Please specify --dry-run or --apply');
    process.exit(1);
  }

  const issues = getOpenIssues();
  console.log(`[cleanup] Found ${issues.length} open issues`);

  let totalRemoved = 0;

  for (const issue of issues) {
    const names = (issue.labels || []).map(l => l.name);
    const stale = names.filter(isStaleOpenabLabel);

    if (stale.length === 0) continue;

    console.log(`\n[cleanup] #${issue.number}: ${issue.title}`);
    console.log(`[cleanup]   Current labels: ${names.join(', ')}`);
    console.log(`[cleanup]   Stale labels: ${stale.join(', ')}`);

    if (APPLY) {
      for (const label of stale) {
        try {
          gh(`issue edit ${issue.number} --remove-label "${label}"`);
          console.log(`[cleanup]   ✓ Removed: ${label}`);
          totalRemoved++;
        } catch (e) {
          const msg = e.stderr?.toString() || e.message;
          console.warn(`[cleanup]   ✗ Failed to remove ${label}: ${msg.slice(0, 200)}`);
        }
      }
    } else {
      console.log(`[cleanup]   (would remove: ${stale.join(', ')})`);
      totalRemoved += stale.length;
    }
  }

  console.log(`\n[cleanup] Done. ${totalRemoved} stale label(s) ${APPLY ? 'removed' : 'would be removed'}.`);
}

main().catch(e => {
  console.error('[cleanup] Fatal:', e.message);
  process.exit(1);
});
