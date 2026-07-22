#!/usr/bin/env node
/**
 * openab-claim - Agent-side CLI to claim and process OpenAB tasks
 *
 * Polls GitHub issues labeled `openab/<agent>`, claims the first one,
 * and provides the context to the agent.
 *
 * Usage:
 *   node openab-claim.js                    # List all open tasks across agents
 *   node openab-claim.js <agent>            # Claim next task for agent
 *   node openab-claim.js <agent> --all      # List all tasks for agent
 *   node openab-claim.js <agent> --done     # Mark current task complete
 */
import { execSync, execFileSync } from 'node:child_process';
import { POLL_AGENTS, normalizeAgent } from '../lib/config.js';
import { extractTask } from '../lib/task-routing.js';
const REPO = process.env.OPENAB_REPO || 'LihSheng/LinkUp';
function gh(args, opts = {}) {
    const isApi = args.startsWith('api ');
    const cmd = isApi ? `gh ${args}` : `gh ${args} --repo "${REPO}"`;
    try {
        const out = execSync(cmd, {
            encoding: 'utf-8',
            stdio: ['pipe', 'pipe', 'pipe'],
            ...opts,
            maxBuffer: 10 * 1024 * 1024,
        }).trim();
        return opts.json ? JSON.parse(out) : out;
    }
    catch (e) {
        if (e.stderr)
            console.error(e.stderr.trim());
        return null;
    }
}
function listIssuesByLabel(label) {
    return gh(`issue list --label "${label}" --state open --json number,title,url,body,labels`, { json: true }) || [];
}
function getIssueComments(issueNumber) {
    const data = gh(`api repos/${REPO}/issues/${issueNumber}/comments`, { json: true });
    if (!Array.isArray(data))
        return [];
    return data.map(c => ({
        body: c.body,
        id: c.id,
        user: c.user?.login,
    }));
}
function addComment(issueNumber, body) {
    try {
        return execFileSync('gh', ['api', `repos/${REPO}/issues/${issueNumber}/comments`, '-X', 'POST', '-f', `body=${body}`], { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'], maxBuffer: 10 * 1024 * 1024 }).trim();
    }
    catch (e) {
        if (e.stderr)
            console.error(e.stderr.toString().trim());
        return null;
    }
}
function removeLabel(issueNumber, label) {
    return gh(`issue edit ${issueNumber} --remove-label "${label}"`);
}
function addLabel(issueNumber, label) {
    return gh(`issue edit ${issueNumber} --add-label "${label}"`);
}
function parseTaskFromIssue(issue, agent) {
    const comments = getIssueComments(issue.number);
    const task = extractTask(comments, agent);
    if (!task)
        return null;
    return {
        agent,
        task: task.task || issue.title,
        issue_number: issue.number,
        issue_title: issue.title,
        issue_url: issue.url || `https://github.com/${REPO}/issues/${issue.number}`,
        commenter: task.commenter || 'unknown',
    };
}
function main() {
    const args = process.argv.slice(2);
    const rawAgentName = args[0]?.toLowerCase();
    const agentName = rawAgentName ? normalizeAgent(rawAgentName) : null;
    const flag = args[1]?.toLowerCase();
    if (flag === '--done') {
        if (!agentName) {
            console.error('Usage: node openab-claim.js <agent> --done');
            process.exit(1);
        }
        // Find the assigned issue (either pending or wip) and mark it done
        const pendingIssues = listIssuesByLabel(`openab/${agentName}`);
        const wipIssues = listIssuesByLabel(`openab/${agentName}/wip`);
        const issues = [...pendingIssues, ...wipIssues];
        for (const issue of issues) {
            const hasPending = issue.labels?.some(l => l.name === `openab/${agentName}`);
            const hasWip = issue.labels?.some(l => l.name === `openab/${agentName}/wip`);
            if (hasPending || hasWip) {
                if (hasPending)
                    removeLabel(issue.number, `openab/${agentName}`);
                if (hasWip)
                    removeLabel(issue.number, `openab/${agentName}/wip`);
                addLabel(issue.number, 'openab/done');
                console.log(`Marked #${issue.number} as done.`);
                return;
            }
        }
        console.log('No open task found for this agent.');
        return;
    }
    const labels = agentName
        ? [`openab/${agentName}`]
        : null;
    if (labels) {
        const issues = listIssuesByLabel(labels[0]);
        if (issues.length === 0) {
            console.log(`No pending tasks for "${rawAgentName}".`);
            return;
        }
        if (flag === '--all') {
            for (const issue of issues) {
                const task = parseTaskFromIssue(issue, rawAgentName || agentName);
                if (task)
                    console.log(JSON.stringify(task, null, 2));
            }
            return;
        }
        // Claim the first issue
        const issue = issues[0];
        const task = parseTaskFromIssue(issue, rawAgentName || agentName);
        if (!task) {
            console.log(`Found issue #${issue.number} but could not parse task.`);
            console.log(`Title: ${issue.title}`);
            console.log(`URL: ${issue.url}`);
            return;
        }
        // Remove pending label, add in-progress label
        removeLabel(issue.number, `openab/${agentName}`);
        addLabel(issue.number, `openab/${agentName}/wip`);
        console.log(`Claimed task from #${task.issue_number}`);
        console.log(`  Repository: ${REPO}`);
        console.log(`  Issue:      #${task.issue_number} - ${task.issue_title}`);
        console.log(`  URL:        ${task.issue_url}`);
        console.log(`  From:       @${task.commenter}`);
        console.log(`  Agent:      ${task.agent}`);
        console.log(`  Task:       ${task.task}`);
        console.log(`\nTo work on this task:\n  gh issue view ${task.issue_url}`);
        console.log(`\nWhen done:\n  node openab-claim.js ${rawAgentName || agentName} --done`);
    }
    else {
        // No agent specified - list all
        for (const ag of POLL_AGENTS) {
            const issues = listIssuesByLabel(`openab/${ag}`);
            if (issues.length > 0) {
                console.log(`\n${ag} (${issues.length}):`);
                for (const issue of issues) {
                    console.log(`  #${issue.number} - ${issue.title}`);
                }
            }
        }
        console.log('\nUsage: node openab-claim.js <agent>');
    }
}
main();
//# sourceMappingURL=claim.js.map