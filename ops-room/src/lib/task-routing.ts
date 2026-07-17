import { CODING_KEYWORDS } from './config.js';

export function extractTask(comments, agentKey = null) {
  const ordered = [...comments].reverse();

  for (const comment of ordered) {
    if (!comment.body?.includes('<!-- openab-task')) continue;

    const agentMatch = comment.body.match(/agent:\s*(.+?)(?:\n|$)/);
    const agent = agentMatch?.[1]?.trim();

    if (agentKey && agent && agent !== agentKey) continue;

    const taskMatch = comment.body.match(/task:\s*([\s\S]*?)(?:\nrepository:|\nissue:|\ncommenter:|\nid:|\ntask_type:|\n-->)/);
    const commenterMatch = comment.body.match(/commenter:\s*(\S+)/);
    const idMatch = comment.body.match(/id:\s*(.+?)(?:\n|$)/);
    const typeMatch = comment.body.match(/task_type:\s*(\S+)/);

    return {
      task: taskMatch?.[1]?.trim() || '',
      commenter: commenterMatch?.[1] || 'unknown',
      taskId: idMatch?.[1]?.trim() || null,
      taskType: typeMatch?.[1]?.trim() || null,
    };
  }

  return null;
}

export function parseFlags(taskText) {
  const flagMatch = taskText.match(/--(chat|code)\b/);
  return flagMatch ? flagMatch[1] : null;
}

export function isCodingTask(task, issue) {
  const title = issue?.title || '';
  const body = issue?.body || '';
  const text = `${task}\n${title}\n${body}`.toLowerCase();
  return CODING_KEYWORDS.some((keyword) => text.includes(keyword));
}
