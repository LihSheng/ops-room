import { AGENT_IDS, AGENT_NAMES, LABEL_COLORS } from './config.mjs';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function pollAgentIssues({
  agentKey,
  listOpenIssuesForAgent,
  ensureLabel,
  removeLabel,
  addLabel,
  addComment,
  handleTask,
  cancelTask,
  logger = console,
}) {
  const issues = await listOpenIssuesForAgent(agentKey);
  if (!issues?.length) return;

  for (const issue of issues) {
    const names = issue.labels?.map((label) => label.name) || [];
    logger.log(`[poller] labels on #${issue.number}: ${names.join(', ')}`);

    if (names.includes('openab/cancel')) {
      if (cancelTask) await cancelTask(issue.number, agentKey);
      continue;
    }
    if (!names.includes(`openab/${agentKey}`)) continue;
    if (names.includes(`openab/${agentKey}/wip`)) continue;
    if (names.includes('openab/pr-created')) continue;
    if (names.includes('openab/done')) continue;
    if (names.includes(`openab/${agentKey}/failed`)) continue;

    logger.log(`[poller] ${agentKey} task on #${issue.number}: ${issue.title}`);

    await ensureLabel(`openab/${agentKey}/wip`, LABEL_COLORS.wip);
    await removeLabel(issue.number, `openab/${agentKey}`);
    await addLabel(issue.number, `openab/${agentKey}/wip`);

    const agentName = AGENT_NAMES[agentKey] || agentKey;
    const agentId = AGENT_IDS[agentKey] || 'unknown';
    await addComment(
      issue.number,
      `**OpenAB / ${agentName}** - claimed and working 🚀

> ${issue.title}

Agent <@${agentId}> is on it.

---
*Task claimed automatically by OpenAB poller*`,
      agentKey,
    );

    await handleTask(issue.number, agentKey, issue);
  }
}

export async function startIssuePoller({
  agentKeys,
  intervalMs,
  pollAgent,
  logger = console,
}) {
  logger.log('[poller] poll loop started');

  while (true) {
    const results = await Promise.allSettled(
      agentKeys.map(agentKey => pollAgent(agentKey))
    );
    for (const result of results) {
      if (result.status === 'rejected') {
        logger.error('[poller] cycle error:', result.reason?.message);
      }
    }

    await sleep(intervalMs);
  }
}
