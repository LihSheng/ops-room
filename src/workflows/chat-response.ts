import { AGENT_NAMES } from '../lib/config.js';
import { addComment, transitionLabels } from '../services/github.js';
import { OPENCODE_API, NVIDIA_API, OPENCODE_MODEL, NVIDIA_MODEL, OPENCODE_MAX_TOKEN } from '../services/runtime-paths.js';
import { writeTaskLog } from '../services/logs.js';
import { notify } from '../lib/notify.js';

async function askAI(prompt) {
  const tryProvider = async (apiUrl, apiKey, model) => {
    const res = await fetch(apiUrl, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: prompt }],
        max_tokens: OPENCODE_MAX_TOKEN,
      }),
    });
    if (!res.ok) throw new Error(`API ${res.status}: ${await res.text()}`);
    const data = await res.json();
    return data.choices?.[0]?.message?.content || '';
  };

  if (process.env.OPENCODE_API_KEY) {
    try {
      return await tryProvider(OPENCODE_API, process.env.OPENCODE_API_KEY, OPENCODE_MODEL);
    } catch (e) {
      const msg = e.message || '';
      if (!msg.includes('401') && !msg.includes('Insufficient balance') && !msg.includes('402')) throw e;
      console.warn(`[poller] OpenCode API error: ${msg}`);
      console.warn(`[poller] OpenCode API failed, falling back to NVIDIA`);
    }
  }

  if (process.env.NVIDIA_API_KEY) {
    return await tryProvider(NVIDIA_API, process.env.NVIDIA_API_KEY, NVIDIA_MODEL);
  }

  throw new Error('No API key available (OPENCODE_API_KEY or NVIDIA_API_KEY)');
}

export async function runChatWorkflow(ctx) {
  const agentName = AGENT_NAMES[ctx.agent] || ctx.agent;
  const context = `
Issue #${ctx.issueNumber} by @${ctx.issue.user?.login}
Title: ${ctx.issueTitle}
Body: ${(ctx.issueBody || '(empty)').slice(0, 1000)}

The user @${ctx.requester} gave this command to the ${agentName} agent on the issue: "${ctx.task}"

Answer concisely based on the issue details above. If you need more context, explain what information is missing.`.trim();

  const answer = await askAI(context);
  if (!answer) return;

  addComment(ctx.issueNumber, `**${agentName}** — response 🤖\n\n${answer}\n\n---\n*Auto-responded by OpenAB poller*`, ctx.agent);

  notify('chat.completed', { issue: ctx.issueNumber, title: ctx.issueTitle, agent: ctx.agent });

  await transitionLabels(ctx, {
    remove: [`openab/${ctx.agent}/wip`, `openab/${ctx.agent}`],
    add: ['openab/done'],
  });

  await writeTaskLog(ctx, [`Chat workflow complete for #${ctx.issueNumber}`]);
  console.log(`[poller] Chat response posted to #${ctx.issueNumber} for ${ctx.agent}`);
}

export { askAI };
