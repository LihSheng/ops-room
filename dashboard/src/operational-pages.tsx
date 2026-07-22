import {
  Alert,
  Badge,
  Box,
  Code,
  Group,
  Paper,
  SegmentedControl,
  SimpleGrid,
  Skeleton,
  Stack,
  Table,
  Text,
  ThemeIcon,
  Timeline,
  Title,
} from '@mantine/core';
import { useQuery } from '@tanstack/react-query';
import {
  IconActivity,
  IconAlertTriangle,
  IconBrandGithub,
  IconCheck,
  IconClock,
  IconGitBranch,
  IconLock,
  IconRobot,
  IconRoute,
  IconServer,
  IconSettings,
  IconShieldCheck,
} from '@tabler/icons-react';
import { useMemo, useState } from 'react';
import { opsApi } from './api';
import type { AgentInstance, OpsTask } from './types';

const ACTIVE_STATES = new Set([
  'PENDING', 'QUEUED', 'CLAIMED', 'RUNNING', 'IN_PROGRESS', 'REVIEWING', 'FIX_QUEUED', 'FIXING', 'CANCELLING',
]);
const ATTENTION_STATES = new Set([
  'ERROR', 'FAILED', 'CHANGES_REQUESTED', 'NEEDS_HUMAN', 'BLOCKED', 'CANCELLED', 'STALE',
]);
const SUCCESS_STATES = new Set(['PASSED', 'SUCCESS', 'COMPLETED', 'DONE', 'FIX_PUSHED', 'APPROVED']);

interface OperationalData {
  health: Awaited<ReturnType<typeof opsApi.health>>;
  instances: Awaited<ReturnType<typeof opsApi.instances>>;
  tasks: Awaited<ReturnType<typeof opsApi.tasks>>;
}

interface WorkflowRun {
  key: string;
  title: string;
  repository: string;
  reference: string;
  type: string;
  status: string;
  agents: string[];
  taskCount: number;
  updatedAt?: string;
}

function useOperationalData() {
  return useQuery({
    queryKey: ['ops-dashboard'],
    queryFn: async (): Promise<OperationalData> => {
      const [health, instances, tasks] = await Promise.all([
        opsApi.health(),
        opsApi.instances(),
        opsApi.tasks(),
      ]);
      return { health, instances, tasks };
    },
    refetchInterval: 10_000,
  });
}

function normalizeState(task: OpsTask): string {
  return String(task.status || task.state || 'UNKNOWN').toUpperCase();
}

function taskId(task: OpsTask): string {
  return String(task.task_id || task.id || task.file || `${task.agent || 'task'}-${task.received_at || 'unknown'}`);
}

function taskTitle(task: OpsTask): string {
  return String(task.issue_title || task.task_text || task.task || taskId(task) || 'Untitled task');
}

function taskTimestamp(task: OpsTask): string | undefined {
  return task.updated_at || task.completed_at || task.received_at || task.created_at;
}

function stringField(task: OpsTask, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = task[key];
    if (typeof value === 'string' && value.trim()) return value;
    if (typeof value === 'number') return String(value);
  }
  return undefined;
}

function numericField(task: OpsTask, keys: string[]): number | undefined {
  for (const key of keys) {
    const value = task[key];
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string' && /^\d+$/.test(value)) return Number(value);
  }
  return undefined;
}

function dateValue(value?: string): number {
  if (!value) return 0;
  const timestamp = Date.parse(value);
  return Number.isNaN(timestamp) ? 0 : timestamp;
}

function relativeTime(value?: string): string {
  if (!value) return 'Unknown time';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  const seconds = Math.round((date.getTime() - Date.now()) / 1000);
  const formatter = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
  const ranges: Array<[Intl.RelativeTimeFormatUnit, number]> = [
    ['year', 31_536_000],
    ['month', 2_592_000],
    ['week', 604_800],
    ['day', 86_400],
    ['hour', 3_600],
    ['minute', 60],
  ];
  for (const [unit, amount] of ranges) {
    if (Math.abs(seconds) >= amount) return formatter.format(Math.round(seconds / amount), unit);
  }
  return formatter.format(seconds, 'second');
}

function statusColor(status?: string): string {
  const value = String(status || 'UNKNOWN').toUpperCase();
  if (SUCCESS_STATES.has(value) || value === 'RUNNING' || value === 'HEALTHY' || value === 'OK') return 'teal';
  if (ATTENTION_STATES.has(value) || value === 'UNHEALTHY' || value === 'RESTARTING') {
    return value === 'ERROR' || value === 'FAILED' ? 'red' : 'orange';
  }
  if (ACTIVE_STATES.has(value)) return 'violet';
  return 'gray';
}

function StatusBadge({ status }: { status?: string }) {
  return (
    <Badge color={statusColor(status)} variant="light">
      {String(status || 'unknown').replaceAll('_', ' ').toLowerCase()}
    </Badge>
  );
}

function PageHeader({
  title,
  description,
}: {
  title: string;
  description: string;
}) {
  return (
    <Group justify="space-between" align="flex-end">
      <Box>
        <Title order={1} className="page-title">{title}</Title>
        <Text c="dimmed" mt={6}>{description}</Text>
      </Box>
      <Badge variant="light" color="gray" leftSection={<IconLock size={12} />}>Read only</Badge>
    </Group>
  );
}

function LoadingPanel() {
  return <Stack gap="md">{Array.from({ length: 3 }).map((_, index) => <Skeleton key={index} height={110} radius="lg" />)}</Stack>;
}

function ErrorPanel() {
  return (
    <Alert color="red" title="Operational data unavailable" icon={<IconAlertTriangle size={18} />}>
      The existing Ops Room APIs could not be loaded. No workflow or runtime action was attempted.
    </Alert>
  );
}

function workflowGroupKey(task: OpsTask): string {
  const workflowRun = stringField(task, ['workflow_run_id', 'workflowRunId']);
  if (workflowRun) return workflowRun;

  const repository = task.repository || 'unknown-repository';
  const pr = numericField(task, ['pr', 'pull_request', 'pull_request_number']);
  if (pr) return `${repository}:pr:${pr}`;

  const issue = numericField(task, ['issue_number', 'issue']);
  if (issue) return `${repository}:issue:${issue}`;

  const correlation = stringField(task, ['review_loop_id', 'correlation_id', 'parent_task_id']);
  return correlation || taskId(task);
}

function workflowType(task: OpsTask): string {
  const mode = String(task.mode || '').toLowerCase();
  const type = String(task.task_type || task.taskType || task.trigger || '').toLowerCase();

  if (mode === 'auto-fix') return 'Review and fix';
  if (mode === 'review' || type.includes('review')) return 'PR review';
  if (type.includes('fix')) return 'Fix task';
  if (type.includes('research')) return 'Research';
  if (type.includes('patrol') || type.includes('schedule')) return 'Scheduled patrol';
  return type ? type.replaceAll('_', ' ') : 'Task workflow';
}

function workflowStatus(tasks: OpsTask[]): string {
  const states = tasks.map(normalizeState);
  const attention = states.find((state) => ATTENTION_STATES.has(state));
  if (attention) return attention;
  const active = states.find((state) => ACTIVE_STATES.has(state));
  if (active) return active;
  if (states.length && states.every((state) => SUCCESS_STATES.has(state))) return 'COMPLETED';
  return states[0] || 'UNKNOWN';
}

function deriveWorkflowRuns(tasks: OpsTask[]): WorkflowRun[] {
  const groups = new Map<string, OpsTask[]>();

  for (const task of tasks) {
    const key = workflowGroupKey(task);
    const group = groups.get(key) || [];
    group.push(task);
    groups.set(key, group);
  }

  return Array.from(groups.entries()).map(([key, group]) => {
    const sorted = [...group].sort((a, b) => dateValue(taskTimestamp(b)) - dateValue(taskTimestamp(a)));
    const latest = sorted[0];
    const repository = latest.repository || 'Repository not recorded';
    const pr = numericField(latest, ['pr', 'pull_request', 'pull_request_number']);
    const issue = numericField(latest, ['issue_number', 'issue']);
    const reference = pr ? `PR #${pr}` : issue ? `Issue #${issue}` : 'Direct task';
    const title = pr
      ? `${repository} · PR #${pr}`
      : issue
        ? `${repository} · Issue #${issue}`
        : taskTitle(latest);

    return {
      key,
      title,
      repository,
      reference,
      type: workflowType(latest),
      status: workflowStatus(group),
      agents: Array.from(new Set(group.map((task) => task.agent).filter((agent): agent is string => Boolean(agent)))),
      taskCount: group.length,
      updatedAt: taskTimestamp(latest),
    };
  }).sort((a, b) => dateValue(b.updatedAt) - dateValue(a.updatedAt));
}

export function WorkflowsPage() {
  const query = useOperationalData();
  const tasks = query.data?.tasks.tasks || [];
  const workflows = useMemo(() => deriveWorkflowRuns(tasks), [tasks]);
  const active = workflows.filter((workflow) => ACTIVE_STATES.has(workflow.status)).length;
  const attention = workflows.filter((workflow) => ATTENTION_STATES.has(workflow.status)).length;
  const completed = workflows.filter((workflow) => SUCCESS_STATES.has(workflow.status) || workflow.status === 'COMPLETED').length;

  return (
    <Stack gap="lg">
      <PageHeader
        title="Workflows"
        description="A read-only grouping of current tasks into the operational runs they belong to."
      />

      <Alert color="violet" variant="light" icon={<IconRoute size={18} />} title="Visibility only">
        This page derives workflow runs from existing task records. It does not change task creation, claiming, agent hand-offs, retries, or GitHub effects.
      </Alert>

      <SimpleGrid cols={{ base: 1, sm: 3 }}>
        <Paper withBorder p="lg">
          <Text size="sm" c="dimmed">Active runs</Text>
          <Text fz={30} fw={700} mt={4}>{active}</Text>
          <Text size="xs" c="dimmed" mt="sm">Currently queued or executing</Text>
        </Paper>
        <Paper withBorder p="lg">
          <Text size="sm" c="dimmed">Needs attention</Text>
          <Text fz={30} fw={700} mt={4}>{attention}</Text>
          <Text size="xs" c="dimmed" mt="sm">Blocked, failed, or awaiting a decision</Text>
        </Paper>
        <Paper withBorder p="lg">
          <Text size="sm" c="dimmed">Completed runs</Text>
          <Text fz={30} fw={700} mt={4}>{completed}</Text>
          <Text size="xs" c="dimmed" mt="sm">Derived from successful task outcomes</Text>
        </Paper>
      </SimpleGrid>

      <Paper withBorder p="lg">
        <Group justify="space-between" mb="md">
          <Box>
            <Title order={3}>Current workflow runs</Title>
            <Text size="sm" c="dimmed" mt={3}>Grouped by workflow identifier, pull request, issue, or direct task.</Text>
          </Box>
          <Badge variant="dot" color="violet">{workflows.length} runs</Badge>
        </Group>

        {query.isLoading ? <LoadingPanel /> : query.isError ? <ErrorPanel /> : workflows.length ? (
          <Table.ScrollContainer minWidth={820}>
            <Table verticalSpacing="md" highlightOnHover>
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>Workflow</Table.Th>
                  <Table.Th>Type</Table.Th>
                  <Table.Th>Status</Table.Th>
                  <Table.Th>Agents</Table.Th>
                  <Table.Th>Tasks</Table.Th>
                  <Table.Th>Updated</Table.Th>
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {workflows.map((workflow) => (
                  <Table.Tr key={workflow.key}>
                    <Table.Td>
                      <Group gap="sm" wrap="nowrap">
                        <ThemeIcon variant="light" color="violet"><IconGitBranch size={17} /></ThemeIcon>
                        <Box style={{ minWidth: 0 }}>
                          <Text size="sm" fw={600} lineClamp={1}>{workflow.title}</Text>
                          <Text size="xs" c="dimmed">{workflow.reference}</Text>
                        </Box>
                      </Group>
                    </Table.Td>
                    <Table.Td><Text size="sm" tt="capitalize">{workflow.type}</Text></Table.Td>
                    <Table.Td><StatusBadge status={workflow.status} /></Table.Td>
                    <Table.Td>
                      <Text size="sm">{workflow.agents.length ? workflow.agents.join(', ') : 'Unassigned'}</Text>
                    </Table.Td>
                    <Table.Td><Badge variant="light" color="gray">{workflow.taskCount}</Badge></Table.Td>
                    <Table.Td><Text size="sm" c="dimmed" style={{ whiteSpace: 'nowrap' }}>{relativeTime(workflow.updatedAt)}</Text></Table.Td>
                  </Table.Tr>
                ))}
              </Table.Tbody>
            </Table>
          </Table.ScrollContainer>
        ) : (
          <Stack align="center" py={48} gap={8}>
            <ThemeIcon size={44} radius="xl" variant="light" color="gray"><IconRoute size={21} /></ThemeIcon>
            <Text fw={600}>No workflow runs yet</Text>
            <Text size="sm" c="dimmed">Existing tasks will be grouped here without changing their execution.</Text>
          </Stack>
        )}
      </Paper>
    </Stack>
  );
}

function activityTitle(task: OpsTask): string {
  const state = normalizeState(task).replaceAll('_', ' ').toLowerCase();
  const agent = task.agent || 'Ops Room';
  return `${agent} · ${state}`;
}

function activityReference(task: OpsTask): string {
  const repository = task.repository;
  const pr = numericField(task, ['pr', 'pull_request', 'pull_request_number']);
  const issue = numericField(task, ['issue_number', 'issue']);
  if (repository && pr) return `${repository} PR #${pr}`;
  if (repository && issue) return `${repository} issue #${issue}`;
  return repository || stringField(task, ['trigger', 'task_type', 'taskType']) || 'Task record';
}

export function ActivityPage() {
  const query = useOperationalData();
  const [filter, setFilter] = useState('all');
  const tasks = [...(query.data?.tasks.tasks || [])]
    .sort((a, b) => dateValue(taskTimestamp(b)) - dateValue(taskTimestamp(a)));

  const filtered = tasks.filter((task) => {
    const state = normalizeState(task);
    if (filter === 'active') return ACTIVE_STATES.has(state);
    if (filter === 'attention') return ATTENTION_STATES.has(state);
    if (filter === 'completed') return SUCCESS_STATES.has(state);
    return true;
  }).slice(0, 50);

  return (
    <Stack gap="lg">
      <PageHeader
        title="Activity"
        description="A concise operational timeline built from the latest state of existing task records."
      />

      <Alert color="blue" variant="light" icon={<IconActivity size={18} />} title="Current-state timeline">
        This view shows meaningful task outcomes already available to the dashboard. Full transition-by-transition audit history will require a future activity event store.
      </Alert>

      <Group justify="flex-end">
        <SegmentedControl
          value={filter}
          onChange={setFilter}
          data={[
            { label: 'All', value: 'all' },
            { label: 'Active', value: 'active' },
            { label: 'Attention', value: 'attention' },
            { label: 'Completed', value: 'completed' },
          ]}
        />
      </Group>

      <Paper withBorder p="lg">
        {query.isLoading ? <LoadingPanel /> : query.isError ? <ErrorPanel /> : filtered.length ? (
          <Timeline active={-1} bulletSize={34} lineWidth={2}>
            {filtered.map((task) => {
              const state = normalizeState(task);
              const isAttention = ATTENTION_STATES.has(state);
              const isSuccess = SUCCESS_STATES.has(state);
              const icon = isAttention
                ? <IconAlertTriangle size={16} />
                : isSuccess
                  ? <IconCheck size={16} />
                  : ACTIVE_STATES.has(state)
                    ? <IconClock size={16} />
                    : <IconActivity size={16} />;

              return (
                <Timeline.Item
                  key={taskId(task)}
                  bullet={<ThemeIcon color={statusColor(state)} variant="light" radius="xl" size={32}>{icon}</ThemeIcon>}
                  title={activityTitle(task)}
                >
                  <Text size="sm" fw={500} mt={4}>{taskTitle(task)}</Text>
                  <Group gap="xs" mt={7}>
                    <StatusBadge status={state} />
                    <Text size="xs" c="dimmed">{activityReference(task)}</Text>
                    <Text size="xs" c="dimmed">· {relativeTime(taskTimestamp(task))}</Text>
                  </Group>
                  {task.error && <Text size="xs" c="red" mt={6}>{task.error}</Text>}
                </Timeline.Item>
              );
            })}
          </Timeline>
        ) : (
          <Stack align="center" py={48} gap={8}>
            <ThemeIcon size={44} radius="xl" variant="light" color="gray"><IconActivity size={21} /></ThemeIcon>
            <Text fw={600}>No matching activity</Text>
            <Text size="sm" c="dimmed">Change the filter or wait for task records to arrive.</Text>
          </Stack>
        )}
      </Paper>
    </Stack>
  );
}

function backendSummary(agents: AgentInstance[]): string {
  const backends = Array.from(new Set(agents.map((agent) => agent.backend).filter((backend): backend is string => Boolean(backend))));
  return backends.length ? backends.join(', ') : 'Not reported';
}

export function SettingsPage() {
  const query = useOperationalData();
  const data = query.data;
  const agents = data?.instances.instances || [];
  const runningAgents = agents.filter((agent) => String(agent.runtime?.status).toLowerCase() === 'running');
  const pollingAgents = agents.filter((agent) => agent.github_polling_enabled);
  const commands = Object.entries(data?.health.commands || {});
  const availableCommands = commands.filter(([, available]) => available).length;
  const dockerStatus = data?.instances.docker?.available === true
    ? 'available'
    : data?.instances.docker?.available === false
      ? 'degraded'
      : 'not reported';

  return (
    <Stack gap="lg">
      <PageHeader
        title="Settings"
        description="A read-only summary of runtime bindings, integrations, and the current safety boundary."
      />

      <Alert color="teal" variant="light" icon={<IconShieldCheck size={18} />} title="Execution flow remains unchanged">
        No configuration editing, lifecycle action, secret value, shell command, or policy mutation is exposed on this page.
      </Alert>

      {query.isLoading ? <LoadingPanel /> : query.isError || !data ? <ErrorPanel /> : (
        <>
          <SimpleGrid cols={{ base: 1, md: 3 }}>
            <Paper withBorder p="lg">
              <Group justify="space-between" align="flex-start">
                <Box>
                  <Text size="sm" c="dimmed">Runtime fleet</Text>
                  <Text fz={28} fw={700} mt={4}>{runningAgents.length}/{agents.length}</Text>
                </Box>
                <ThemeIcon variant="light" color="violet" size={38}><IconRobot size={20} /></ThemeIcon>
              </Group>
              <Text size="xs" c="dimmed" mt="md">Backends: {backendSummary(agents)}</Text>
            </Paper>

            <Paper withBorder p="lg">
              <Group justify="space-between" align="flex-start">
                <Box>
                  <Text size="sm" c="dimmed">GitHub polling</Text>
                  <Text fz={28} fw={700} mt={4}>{pollingAgents.length}/{agents.length}</Text>
                </Box>
                <ThemeIcon variant="light" color="teal" size={38}><IconBrandGithub size={20} /></ThemeIcon>
              </Group>
              <Text size="xs" c="dimmed" mt="md">Existing GitHub task source and webhook flow</Text>
            </Paper>

            <Paper withBorder p="lg">
              <Group justify="space-between" align="flex-start">
                <Box>
                  <Text size="sm" c="dimmed">Runtime checks</Text>
                  <Text fz={28} fw={700} mt={4}>{commands.length ? `${availableCommands}/${commands.length}` : '—'}</Text>
                </Box>
                <ThemeIcon variant="light" color={data.health.status === 'ok' ? 'teal' : 'orange'} size={38}><IconServer size={20} /></ThemeIcon>
              </Group>
              <Text size="xs" c="dimmed" mt="md">Control plane status: {data.health.status || 'unknown'}</Text>
            </Paper>
          </SimpleGrid>

          <Paper withBorder p="lg">
            <Group justify="space-between" mb="md">
              <Box>
                <Title order={3}>Agent runtime bindings</Title>
                <Text size="sm" c="dimmed" mt={3}>Presence and status only; raw configuration and secret values are not displayed.</Text>
              </Box>
              <Badge variant="dot" color={dockerStatus === 'available' ? 'teal' : dockerStatus === 'degraded' ? 'orange' : 'gray'}>
                Docker {dockerStatus}
              </Badge>
            </Group>

            <Table.ScrollContainer minWidth={760}>
              <Table verticalSpacing="md" highlightOnHover>
                <Table.Thead>
                  <Table.Tr>
                    <Table.Th>Agent</Table.Th>
                    <Table.Th>Backend</Table.Th>
                    <Table.Th>Runtime</Table.Th>
                    <Table.Th>GitHub polling</Table.Th>
                    <Table.Th>Config binding</Table.Th>
                    <Table.Th>Data binding</Table.Th>
                  </Table.Tr>
                </Table.Thead>
                <Table.Tbody>
                  {agents.map((agent) => (
                    <Table.Tr key={agent.agent}>
                      <Table.Td>
                        <Group gap="sm" wrap="nowrap">
                          <ThemeIcon variant="light" color="violet"><IconRobot size={17} /></ThemeIcon>
                          <Box>
                            <Text size="sm" fw={600}>{agent.display_name || agent.agent}</Text>
                            <Text size="xs" c="dimmed">{agent.service || agent.container_name || 'No service reported'}</Text>
                          </Box>
                        </Group>
                      </Table.Td>
                      <Table.Td><Code>{agent.backend || 'unknown'}</Code></Table.Td>
                      <Table.Td><StatusBadge status={agent.runtime?.status} /></Table.Td>
                      <Table.Td><Badge variant="dot" color={agent.github_polling_enabled ? 'teal' : 'gray'}>{agent.github_polling_enabled ? 'enabled' : 'disabled'}</Badge></Table.Td>
                      <Table.Td><Badge variant="light" color={agent.config_path ? 'teal' : 'gray'}>{agent.config_path ? 'configured' : 'not reported'}</Badge></Table.Td>
                      <Table.Td><Badge variant="light" color={agent.data_dir ? 'teal' : 'gray'}>{agent.data_dir ? 'configured' : 'not reported'}</Badge></Table.Td>
                    </Table.Tr>
                  ))}
                </Table.Tbody>
              </Table>
            </Table.ScrollContainer>
          </Paper>

          <SimpleGrid cols={{ base: 1, md: 2 }}>
            <Paper withBorder p="lg">
              <Group gap="sm" mb="md">
                <ThemeIcon variant="light" color="teal"><IconShieldCheck size={18} /></ThemeIcon>
                <Title order={4}>Current safety boundary</Title>
              </Group>
              <Stack gap="sm">
                <Group justify="space-between"><Text size="sm">Dashboard controls</Text><Badge color="gray" variant="light">Read only</Badge></Group>
                <Group justify="space-between"><Text size="sm">Secret values</Text><Badge color="teal" variant="light">Hidden</Badge></Group>
                <Group justify="space-between"><Text size="sm">Task execution flow</Text><Badge color="teal" variant="light">Unchanged</Badge></Group>
                <Group justify="space-between"><Text size="sm">Lifecycle mutations</Text><Badge color="gray" variant="light">Disabled</Badge></Group>
              </Stack>
            </Paper>

            <Paper withBorder p="lg">
              <Group gap="sm" mb="md">
                <ThemeIcon variant="light" color="violet"><IconSettings size={18} /></ThemeIcon>
                <Title order={4}>Future controlled operations</Title>
              </Group>
              <Text size="sm" c="dimmed">
                Start, drain, stop, retry, cancellation, policy editing, and secret references remain outside this read-only enhancement. They should only be enabled with authentication, RBAC, audit records, confirmation, and lease-aware safeguards.
              </Text>
            </Paper>
          </SimpleGrid>
        </>
      )}
    </Stack>
  );
}
