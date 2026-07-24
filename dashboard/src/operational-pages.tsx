import {
  Alert,
  Badge,
  Box,
  Button,
  Code,
  Group,
  Modal,
  Paper,
  SegmentedControl,
  Select,
  SimpleGrid,
  Skeleton,
  Stack,
  Table,
  Text,
  Textarea,
  ThemeIcon,
  Timeline,
  Title,
} from '@mantine/core';
import { notifications as toast } from '@mantine/notifications';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  IconActivity,
  IconAlertTriangle,
  IconBell,
  IconCheck,
  IconClock,
  IconExternalLink,
  IconGitBranch,
  IconLock,
  IconRobot,
  IconRoute,
  IconServer,
  IconSettings,
  IconShieldCheck,
} from '@tabler/icons-react';
import { useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';

import { opsApi } from './api';
import {
  activityEventsApi,
  type ActivityEvent,
  type ActivityEventCategory,
  type ActivityEventSeverity,
} from './api/activity-events';
import {
  createNotificationIdempotencyKey,
  operatorNotificationsApi,
  type OperatorNotification,
  type OperatorNotificationStateName,
} from './api/operator-notifications';
import { useOperatorAuth } from './operator-auth';
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

function dateValue(value?: string | null): number {
  if (!value) return 0;
  const timestamp = Date.parse(value);
  return Number.isNaN(timestamp) ? 0 : timestamp;
}

function relativeTime(value?: string | null): string {
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

function StatusBadge({ status }: { status?: string | null }) {
  return (
    <Badge color={statusColor(status || undefined)} variant="light">
      {String(status || 'unknown').replaceAll('_', ' ').toLowerCase()}
    </Badge>
  );
}

function PageHeader({ title, description, action }: {
  title: string;
  description: string;
  action?: React.ReactNode;
}) {
  return (
    <Group justify="space-between" align="flex-end">
      <Box>
        <Title order={1} className="page-title">{title}</Title>
        <Text c="dimmed" mt={6}>{description}</Text>
      </Box>
      {action || <Badge variant="light" color="gray" leftSection={<IconLock size={12} />}>Read only</Badge>}
    </Group>
  );
}

function LoadingPanel() {
  return <Stack gap="md">{Array.from({ length: 3 }).map((_, index) => <Skeleton key={index} height={110} radius="lg" />)}</Stack>;
}

function ErrorPanel({ message = 'The existing Ops Room APIs could not be loaded. No workflow or runtime action was attempted.' }: { message?: string }) {
  return (
    <Alert color="red" title="Operational data unavailable" icon={<IconAlertTriangle size={18} />}>
      {message}
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
  return stringField(task, ['review_loop_id', 'correlation_id', 'parent_task_id']) || taskId(task);
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
  return states.find((state) => ATTENTION_STATES.has(state))
    || states.find((state) => ACTIVE_STATES.has(state))
    || (states.length && states.every((state) => SUCCESS_STATES.has(state)) ? 'COMPLETED' : states[0] || 'UNKNOWN');
}

function deriveWorkflowRuns(tasks: OpsTask[]): WorkflowRun[] {
  const groups = new Map<string, OpsTask[]>();
  for (const task of tasks) groups.set(workflowGroupKey(task), [...(groups.get(workflowGroupKey(task)) || []), task]);
  return Array.from(groups.entries()).map(([key, group]) => {
    const sorted = [...group].sort((a, b) => dateValue(taskTimestamp(b)) - dateValue(taskTimestamp(a)));
    const latest = sorted[0];
    const repository = latest.repository || 'Repository not recorded';
    const pr = numericField(latest, ['pr', 'pull_request', 'pull_request_number']);
    const issue = numericField(latest, ['issue_number', 'issue']);
    return {
      key,
      title: pr ? `${repository} · PR #${pr}` : issue ? `${repository} · Issue #${issue}` : taskTitle(latest),
      repository,
      reference: pr ? `PR #${pr}` : issue ? `Issue #${issue}` : 'Direct task',
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
  const workflows = useMemo(() => deriveWorkflowRuns(query.data?.tasks.tasks || []), [query.data]);
  const active = workflows.filter((workflow) => ACTIVE_STATES.has(workflow.status)).length;
  const attention = workflows.filter((workflow) => ATTENTION_STATES.has(workflow.status)).length;
  const completed = workflows.filter((workflow) => SUCCESS_STATES.has(workflow.status) || workflow.status === 'COMPLETED').length;

  return (
    <Stack gap="lg">
      <PageHeader title="Workflows" description="A read-only grouping of current tasks into the operational runs they belong to." />
      <Alert color="violet" variant="light" icon={<IconRoute size={18} />} title="Visibility only">
        This page derives workflow runs from existing task records. It does not change task creation, claiming, agent hand-offs, retries, or GitHub effects.
      </Alert>
      <SimpleGrid cols={{ base: 1, sm: 3 }}>
        <Paper withBorder p="lg"><Text size="sm" c="dimmed">Active runs</Text><Text fz={30} fw={700} mt={4}>{active}</Text><Text size="xs" c="dimmed" mt="sm">Currently queued or executing</Text></Paper>
        <Paper withBorder p="lg"><Text size="sm" c="dimmed">Needs attention</Text><Text fz={30} fw={700} mt={4}>{attention}</Text><Text size="xs" c="dimmed" mt="sm">Blocked, failed, or awaiting a decision</Text></Paper>
        <Paper withBorder p="lg"><Text size="sm" c="dimmed">Completed runs</Text><Text fz={30} fw={700} mt={4}>{completed}</Text><Text size="xs" c="dimmed" mt="sm">Derived from successful task outcomes</Text></Paper>
      </SimpleGrid>
      <Paper withBorder p="lg">
        <Group justify="space-between" mb="md"><Box><Title order={3}>Current workflow runs</Title><Text size="sm" c="dimmed" mt={3}>Grouped by workflow identifier, pull request, issue, or direct task.</Text></Box><Badge variant="dot" color="violet">{workflows.length} runs</Badge></Group>
        {query.isLoading ? <LoadingPanel /> : query.isError ? <ErrorPanel /> : workflows.length ? (
          <Table.ScrollContainer minWidth={820}><Table verticalSpacing="md" highlightOnHover><Table.Thead><Table.Tr><Table.Th>Workflow</Table.Th><Table.Th>Type</Table.Th><Table.Th>Status</Table.Th><Table.Th>Agents</Table.Th><Table.Th>Tasks</Table.Th><Table.Th>Updated</Table.Th></Table.Tr></Table.Thead><Table.Tbody>{workflows.map((workflow) => (
            <Table.Tr key={workflow.key}><Table.Td><Group gap="sm" wrap="nowrap"><ThemeIcon variant="light" color="violet"><IconGitBranch size={17} /></ThemeIcon><Box style={{ minWidth: 0 }}><Text size="sm" fw={600} lineClamp={1}>{workflow.title}</Text><Text size="xs" c="dimmed">{workflow.reference}</Text></Box></Group></Table.Td><Table.Td><Text size="sm" tt="capitalize">{workflow.type}</Text></Table.Td><Table.Td><StatusBadge status={workflow.status} /></Table.Td><Table.Td><Text size="sm">{workflow.agents.length ? workflow.agents.join(', ') : 'Unassigned'}</Text></Table.Td><Table.Td><Badge variant="light" color="gray">{workflow.taskCount}</Badge></Table.Td><Table.Td><Text size="sm" c="dimmed">{relativeTime(workflow.updatedAt)}</Text></Table.Td></Table.Tr>
          ))}</Table.Tbody></Table></Table.ScrollContainer>
        ) : <Text c="dimmed" ta="center" py="xl">No workflow runs yet.</Text>}
      </Paper>
    </Stack>
  );
}

function activityColor(severity: string) {
  if (severity === 'error') return 'red';
  if (severity === 'attention' || severity === 'warning') return 'orange';
  if (severity === 'success') return 'teal';
  return 'violet';
}

function activityIcon(event: ActivityEvent) {
  if (event.severity === 'error' || event.severity === 'attention') return <IconAlertTriangle size={16} />;
  if (event.severity === 'success') return <IconCheck size={16} />;
  if (event.state === 'active' || event.state === 'running') return <IconClock size={16} />;
  return <IconActivity size={16} />;
}

function safeInternalLink(value: string | null | undefined) {
  return value && value.startsWith('/') && !value.startsWith('//') ? value : null;
}

function EvidenceLinks({ links }: { links: Record<string, string | null | undefined> }) {
  const entries = Object.entries(links).filter((entry): entry is [string, string] => Boolean(safeInternalLink(entry[1])));
  if (!entries.length) return null;
  return <Group gap="xs" mt="sm">{entries.map(([label, href]) => <Button key={label} component="a" href={href} variant="subtle" size="compact-xs" rightSection={<IconExternalLink size={12} />}>{label}</Button>)}</Group>;
}

function DurableActivityPanel({ selectedActivityId }: { selectedActivityId: string | null }) {
  const [severity, setSeverity] = useState<ActivityEventSeverity | 'all'>('all');
  const [category, setCategory] = useState<ActivityEventCategory | 'all'>('all');
  const [missionId, setMissionId] = useState<string | null>(null);
  const [attentionOnly, setAttentionOnly] = useState(false);
  const query = useQuery({
    queryKey: ['activity-events', severity, category, missionId, attentionOnly],
    queryFn: () => activityEventsApi.list({ severity, category, missionId, attentionOnly, limit: 300 }),
    refetchInterval: 10_000,
  });
  const data = query.data;
  const degraded = data && (data.sources.missions !== 'available' || data.sources.mission_rooms !== 'available');

  return <Stack gap="lg">
    <Alert color="blue" variant="light" icon={<IconActivity size={18} />} title="Durable Mission activity">
      This timeline is composed from accepted Mission, Workflow, stage, workspace, review, and provider-effect evidence. It does not infer transitions from task snapshots or browser state.
    </Alert>
    {degraded && <Alert color="orange" icon={<IconAlertTriangle size={18} />} title="Activity evidence is degraded">Mission source: {data.sources.missions}; Mission Room source: {data.sources.mission_rooms}. Healthy durable events remain visible and no placeholder events are created.</Alert>}
    <SimpleGrid cols={{ base: 2, md: 4 }}>
      <Paper withBorder p="md"><Text size="xs" c="dimmed">Matching events</Text><Text fz={26} fw={700}>{data?.summary.total || 0}</Text></Paper>
      <Paper withBorder p="md"><Text size="xs" c="dimmed">Attention</Text><Text fz={26} fw={700}>{data?.summary.attention || 0}</Text></Paper>
      <Paper withBorder p="md"><Text size="xs" c="dimmed">Errors</Text><Text fz={26} fw={700}>{data?.summary.errors || 0}</Text></Paper>
      <Paper withBorder p="md"><Text size="xs" c="dimmed">Successful</Text><Text fz={26} fw={700}>{data?.summary.success || 0}</Text></Paper>
    </SimpleGrid>
    <Paper withBorder p="md"><Group align="flex-end" grow>
      <SegmentedControl value={attentionOnly ? 'attention' : 'all'} onChange={(value) => setAttentionOnly(value === 'attention')} data={[{ label: 'All activity', value: 'all' }, { label: 'Attention only', value: 'attention' }]} />
      <Select label="Severity" value={severity} onChange={(value) => setSeverity((value || 'all') as ActivityEventSeverity | 'all')} data={['all', 'info', 'success', 'warning', 'attention', 'error']} />
      <Select label="Category" value={category} onChange={(value) => setCategory((value || 'all') as ActivityEventCategory | 'all')} data={['all', 'mission', 'workflow', 'stage', 'workspace', 'effect', 'review', 'intervention']} />
      <Select label="Mission" clearable searchable value={missionId} onChange={setMissionId} data={(data?.missions || []).map((mission) => ({ value: mission.mission_id, label: mission.title }))} />
    </Group></Paper>
    <Paper withBorder p="lg">
      {query.isLoading ? <LoadingPanel /> : query.isError ? <ErrorPanel message="The durable activity index could not be loaded. No operational action was attempted." /> : data?.events.length ? <Timeline active={-1} bulletSize={34} lineWidth={2}>{data.events.map((event) => (
        <Timeline.Item key={event.activity_id} bullet={<ThemeIcon color={activityColor(event.severity)} variant="light" radius="xl" size={32}>{activityIcon(event)}</ThemeIcon>} title={event.title}>
          <Paper withBorder={selectedActivityId === event.activity_id} p={selectedActivityId === event.activity_id ? 'sm' : 0} mt={4} bg={selectedActivityId === event.activity_id ? 'var(--mantine-color-violet-0)' : undefined}>
            {event.detail && <Text size="sm">{event.detail}</Text>}
            <Group gap="xs" mt={7}><Badge color={activityColor(event.severity)} variant="light">{event.severity}</Badge><Badge variant="light" color="gray">{event.category}</Badge><Text size="xs" c="dimmed">{event.mission.title}</Text><Text size="xs" c="dimmed">· {relativeTime(event.at)}</Text></Group>
            {event.reason_code && <Text size="xs" c="dimmed" mt={6}>Reason: <Code>{event.reason_code}</Code></Text>}
            <EvidenceLinks links={{ Mission: event.links.mission, Stage: event.links.stage, Agent: event.links.agent, Workflow: event.links.workflow }} />
          </Paper>
        </Timeline.Item>
      ))}</Timeline> : <Text c="dimmed" ta="center" py="xl">No matching durable activity.</Text>}
    </Paper>
  </Stack>;
}

function priorityColor(priority: string) {
  if (priority === 'critical') return 'red';
  if (priority === 'high') return 'orange';
  if (priority === 'normal') return 'violet';
  return 'gray';
}

function NotificationDetail({ notification, markRead, acknowledge, pending }: {
  notification: OperatorNotification;
  markRead: () => void;
  acknowledge: () => void;
  pending: boolean;
}) {
  return <Paper withBorder p="lg"><Stack gap="md">
    <Group justify="space-between" align="flex-start"><Box><Title order={3}>{notification.title}</Title><Text size="sm" c="dimmed" mt={4}>{notification.mission.title} · {relativeTime(notification.at)}</Text></Box><Group gap="xs"><Badge color={priorityColor(notification.priority)}>{notification.priority}</Badge><Badge variant="light">{notification.operator_state.state}</Badge></Group></Group>
    {notification.detail && <Text>{notification.detail}</Text>}
    <SimpleGrid cols={{ base: 1, sm: 2 }}><Paper withBorder p="sm"><Text size="xs" c="dimmed">Notification type</Text><Code>{notification.notification_type}</Code></Paper><Paper withBorder p="sm"><Text size="xs" c="dimmed">Activity ID</Text><Code>{notification.activity_id}</Code></Paper></SimpleGrid>
    {notification.reason_code && <Text size="sm">Reason: <Code>{notification.reason_code}</Code></Text>}
    {notification.operator_state.acknowledgement_reason && <Alert color="teal" title="Acknowledged">{notification.operator_state.acknowledgement_reason}</Alert>}
    <EvidenceLinks links={{ Mission: notification.links.mission, Stage: notification.links.stage, Agent: notification.links.agent, Workflow: notification.links.workflow, Activity: `${notification.links.activity || '/activity'}?activity=${encodeURIComponent(notification.activity_id)}` , 'Needs Human': '/interventions' }} />
    <Group justify="flex-end"><Button variant="default" disabled={notification.operator_state.state !== 'unread' || pending} onClick={markRead}>Mark read</Button><Button disabled={notification.operator_state.state === 'acknowledged' || pending} onClick={acknowledge}>Acknowledge</Button></Group>
  </Stack></Paper>;
}

function NotificationsPanel({ selectedId, selectNotification }: { selectedId: string | null; selectNotification: (id: string | null) => void }) {
  const auth = useOperatorAuth();
  const queryClient = useQueryClient();
  const [stateFilter, setStateFilter] = useState<OperatorNotificationStateName | 'all'>('all');
  const [ackOpened, setAckOpened] = useState(false);
  const [ackReason, setAckReason] = useState('');
  const listQuery = useQuery({
    queryKey: ['operator-notifications', stateFilter],
    queryFn: () => operatorNotificationsApi.list({ state: stateFilter, limit: 300 }),
    enabled: auth.mode === 'session',
    refetchInterval: 10_000,
    retry: false,
  });
  const detailQuery = useQuery({
    queryKey: ['operator-notifications', 'detail', selectedId],
    queryFn: () => operatorNotificationsApi.detail(selectedId || ''),
    enabled: auth.mode === 'session' && Boolean(selectedId),
    retry: false,
  });
  const invalidate = async () => {
    await queryClient.invalidateQueries({ queryKey: ['operator-notifications'] });
  };
  const readMutation = useMutation({
    mutationFn: (notificationId: string) => operatorNotificationsApi.markRead({ notificationId, csrfToken: auth.session?.csrf_token || '', idempotencyKey: createNotificationIdempotencyKey('read') }),
    onSuccess: async () => { await invalidate(); toast.show({ color: 'teal', title: 'Notification updated', message: 'The notification is marked as read.' }); },
    onError: (error) => toast.show({ color: 'red', title: 'Unable to mark notification read', message: error instanceof Error ? error.message : 'Notification update failed.' }),
  });
  const acknowledgeMutation = useMutation({
    mutationFn: ({ notificationId, reason }: { notificationId: string; reason: string }) => operatorNotificationsApi.acknowledge({ notificationId, reason, csrfToken: auth.session?.csrf_token || '', idempotencyKey: createNotificationIdempotencyKey('acknowledge') }),
    onSuccess: async () => { setAckOpened(false); setAckReason(''); await invalidate(); toast.show({ color: 'teal', title: 'Notification acknowledged', message: 'The acknowledgement and audit evidence were recorded.' }); },
    onError: (error) => toast.show({ color: 'red', title: 'Unable to acknowledge notification', message: error instanceof Error ? error.message : 'Notification acknowledgement failed.' }),
  });

  if (auth.mode !== 'session') return <Alert color="orange" icon={<IconLock size={18} />} title="Human session required">Per-operator notification state is unavailable in dashboard-token mode. Sign in through the governed operator session flow.</Alert>;
  const selected = detailQuery.data?.notification || listQuery.data?.notifications.find((item) => item.notification_id === selectedId) || null;
  const sources = listQuery.data?.sources;
  const degraded = sources && (sources.operator_state !== 'available' || sources.activity.missions !== 'available' || sources.activity.mission_rooms !== 'available');

  return <Stack gap="lg">
    <Alert color="violet" variant="light" icon={<IconBell size={18} />} title="Per-operator notification inbox">Notification content is a deterministic projection of durable Mission activity. Only your read and acknowledgement state is persisted.</Alert>
    {degraded && <Alert color="orange" icon={<IconAlertTriangle size={18} />} title="Notification evidence is degraded">Activity and operator-state health are reported independently. Existing durable notification state is retained and no duplicate event content is created.</Alert>}
    <SimpleGrid cols={{ base: 2, md: 4 }}><Paper withBorder p="md"><Text size="xs" c="dimmed">Total</Text><Text fz={26} fw={700}>{listQuery.data?.summary.total || 0}</Text></Paper><Paper withBorder p="md"><Text size="xs" c="dimmed">Unread</Text><Text fz={26} fw={700}>{listQuery.data?.summary.unread || 0}</Text></Paper><Paper withBorder p="md"><Text size="xs" c="dimmed">Acknowledged</Text><Text fz={26} fw={700}>{listQuery.data?.summary.acknowledged || 0}</Text></Paper><Paper withBorder p="md"><Text size="xs" c="dimmed">Critical</Text><Text fz={26} fw={700}>{listQuery.data?.summary.critical || 0}</Text></Paper></SimpleGrid>
    <SegmentedControl value={stateFilter} onChange={(value) => setStateFilter(value as OperatorNotificationStateName | 'all')} data={[{ label: 'All', value: 'all' }, { label: 'Unread', value: 'unread' }, { label: 'Read', value: 'read' }, { label: 'Acknowledged', value: 'acknowledged' }]} />
    <SimpleGrid cols={{ base: 1, lg: 2 }} spacing="lg"><Paper withBorder p="md">{listQuery.isLoading ? <LoadingPanel /> : listQuery.isError ? <ErrorPanel message="The authenticated notification inbox could not be loaded." /> : listQuery.data?.notifications.length ? <Stack gap="xs">{listQuery.data.notifications.map((notification) => <Button key={notification.notification_id} variant={selectedId === notification.notification_id ? 'light' : 'subtle'} color={priorityColor(notification.priority)} fullWidth justify="space-between" onClick={() => selectNotification(notification.notification_id)} rightSection={<Badge variant="light">{notification.operator_state.state}</Badge>}><Box ta="left"><Text size="sm" fw={600} lineClamp={1}>{notification.title}</Text><Text size="xs" c="dimmed" lineClamp={1}>{notification.mission.title} · {relativeTime(notification.at)}</Text></Box></Button>)}</Stack> : <Text c="dimmed" ta="center" py="xl">No matching notifications.</Text>}</Paper><Box>{selected ? <NotificationDetail notification={selected} pending={readMutation.isPending || acknowledgeMutation.isPending} markRead={() => readMutation.mutate(selected.notification_id)} acknowledge={() => setAckOpened(true)} /> : <Paper withBorder p="xl"><Text c="dimmed" ta="center">Select a notification for exact durable evidence and governed state actions.</Text></Paper>}</Box></SimpleGrid>
    <Modal opened={ackOpened} onClose={() => setAckOpened(false)} title="Acknowledge notification" centered><Stack><Textarea label="Acknowledgement reason" description="Recorded in your durable operator state and audit evidence." value={ackReason} onChange={(event) => setAckReason(event.currentTarget.value)} minRows={3} maxLength={500} required /><Group justify="flex-end"><Button variant="default" onClick={() => setAckOpened(false)}>Cancel</Button><Button disabled={!ackReason.trim() || !selected} loading={acknowledgeMutation.isPending} onClick={() => selected && acknowledgeMutation.mutate({ notificationId: selected.notification_id, reason: ackReason.trim() })}>Acknowledge</Button></Group></Stack></Modal>
  </Stack>;
}

export function ActivityPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const view = searchParams.get('view') === 'notifications' ? 'notifications' : 'activity';
  const selectedNotificationId = searchParams.get('notification');
  const selectedActivityId = searchParams.get('activity');
  const setView = (next: string) => {
    const params = new URLSearchParams(searchParams);
    params.set('view', next);
    if (next !== 'notifications') params.delete('notification');
    setSearchParams(params);
  };
  const selectNotification = (id: string | null) => {
    const params = new URLSearchParams(searchParams);
    params.set('view', 'notifications');
    if (id) params.set('notification', id); else params.delete('notification');
    setSearchParams(params);
  };

  return <Stack gap="lg">
    <PageHeader title="Activity and notifications" description="Durable Mission evidence and governed per-operator attention state." action={<Badge variant="light" color="violet" leftSection={<IconShieldCheck size={12} />}>Server-owned contracts</Badge>} />
    <SegmentedControl value={view} onChange={setView} data={[{ label: 'Activity', value: 'activity' }, { label: 'Notifications', value: 'notifications' }]} />
    {view === 'activity' ? <DurableActivityPanel selectedActivityId={selectedActivityId} /> : <NotificationsPanel selectedId={selectedNotificationId} selectNotification={selectNotification} />}
  </Stack>;
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
  const dockerStatus = data?.instances.docker?.available === true ? 'available' : data?.instances.docker?.available === false ? 'degraded' : 'not reported';

  return <Stack gap="lg">
    <PageHeader title="Settings" description="A read-only summary of runtime bindings, integrations, and the current safety boundary." />
    <Alert color="teal" variant="light" icon={<IconShieldCheck size={18} />} title="Execution flow remains unchanged">No configuration editing, lifecycle action, secret value, shell command, or policy mutation is exposed on this page.</Alert>
    {query.isLoading ? <LoadingPanel /> : query.isError || !data ? <ErrorPanel /> : <>
      <SimpleGrid cols={{ base: 1, md: 3 }}><Paper withBorder p="lg"><Text size="sm" c="dimmed">Runtime fleet</Text><Text fz={28} fw={700} mt={4}>{runningAgents.length}/{agents.length}</Text><Text size="xs" c="dimmed" mt="md">Backends: {backendSummary(agents)}</Text></Paper><Paper withBorder p="lg"><Text size="sm" c="dimmed">GitHub polling</Text><Text fz={28} fw={700} mt={4}>{pollingAgents.length}/{agents.length}</Text><Text size="xs" c="dimmed" mt="md">Existing GitHub task source and webhook flow</Text></Paper><Paper withBorder p="lg"><Text size="sm" c="dimmed">Runtime checks</Text><Text fz={28} fw={700} mt={4}>{commands.length ? `${availableCommands}/${commands.length}` : '—'}</Text><Text size="xs" c="dimmed" mt="md">Control plane status: {data.health.status || 'unknown'}</Text></Paper></SimpleGrid>
      <Paper withBorder p="lg"><Group justify="space-between" mb="md"><Box><Title order={3}>Agent runtime bindings</Title><Text size="sm" c="dimmed" mt={3}>Presence and status only; raw configuration and secret values are not displayed.</Text></Box><Badge variant="dot" color={dockerStatus === 'available' ? 'teal' : dockerStatus === 'degraded' ? 'orange' : 'gray'}>Docker {dockerStatus}</Badge></Group><Table.ScrollContainer minWidth={760}><Table verticalSpacing="md" highlightOnHover><Table.Thead><Table.Tr><Table.Th>Agent</Table.Th><Table.Th>Backend</Table.Th><Table.Th>Runtime</Table.Th><Table.Th>GitHub polling</Table.Th><Table.Th>Config binding</Table.Th><Table.Th>Data binding</Table.Th></Table.Tr></Table.Thead><Table.Tbody>{agents.map((agent) => <Table.Tr key={agent.agent}><Table.Td><Group gap="sm" wrap="nowrap"><ThemeIcon variant="light" color="violet"><IconRobot size={17} /></ThemeIcon><Box><Text size="sm" fw={600}>{agent.display_name || agent.agent}</Text><Text size="xs" c="dimmed">{agent.service || agent.container_name || 'No service reported'}</Text></Box></Group></Table.Td><Table.Td><Code>{agent.backend || 'unknown'}</Code></Table.Td><Table.Td><StatusBadge status={agent.runtime?.status} /></Table.Td><Table.Td><Badge variant="dot" color={agent.github_polling_enabled ? 'teal' : 'gray'}>{agent.github_polling_enabled ? 'enabled' : 'disabled'}</Badge></Table.Td><Table.Td><Badge variant="light" color={agent.config_path ? 'teal' : 'gray'}>{agent.config_path ? 'configured' : 'not reported'}</Badge></Table.Td><Table.Td><Badge variant="light" color={agent.data_dir ? 'teal' : 'gray'}>{agent.data_dir ? 'configured' : 'not reported'}</Badge></Table.Td></Table.Tr>)}</Table.Tbody></Table></Table.ScrollContainer></Paper>
      <SimpleGrid cols={{ base: 1, md: 2 }}><Paper withBorder p="lg"><Group gap="sm" mb="md"><ThemeIcon variant="light" color="teal"><IconShieldCheck size={18} /></ThemeIcon><Title order={4}>Current safety boundary</Title></Group><Stack gap="sm"><Group justify="space-between"><Text size="sm">Dashboard controls</Text><Badge color="gray" variant="light">Read only</Badge></Group><Group justify="space-between"><Text size="sm">Secret values</Text><Badge color="teal" variant="light">Hidden</Badge></Group><Group justify="space-between"><Text size="sm">Task execution flow</Text><Badge color="teal" variant="light">Unchanged</Badge></Group><Group justify="space-between"><Text size="sm">Lifecycle mutations</Text><Badge color="gray" variant="light">Disabled</Badge></Group></Stack></Paper><Paper withBorder p="lg"><Group gap="sm" mb="md"><ThemeIcon variant="light" color="violet"><IconSettings size={18} /></ThemeIcon><Title order={4}>Future controlled operations</Title></Group><Text size="sm" c="dimmed">Start, drain, stop, retry, cancellation, policy editing, and secret references remain outside this read-only enhancement. They should only be enabled with authentication, RBAC, audit records, confirmation, and lease-aware safeguards.</Text></Paper></SimpleGrid>
    </>}
  </Stack>;
}
