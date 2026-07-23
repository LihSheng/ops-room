import {
  Alert,
  Badge,
  Box,
  Button,
  Checkbox,
  Code,
  Group,
  Modal,
  Paper,
  SegmentedControl,
  Skeleton,
  Stack,
  Table,
  Text,
  Textarea,
  ThemeIcon,
  Title,
} from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  IconAlertTriangle,
  IconListCheck,
  IconPlayerPause,
  IconPlayerPlay,
  IconRefresh,
  IconShieldCheck,
  IconX,
} from '@tabler/icons-react';
import { useMemo, useState } from 'react';

import {
  availableReviewTaskActions,
  createTaskActionIdempotencyKey,
  normalizeReviewTaskState,
  OperatorTaskApiError,
  operatorTasksApi,
  reviewTaskId,
  type OperatorTaskAction,
  type ReviewTaskRecord,
} from '../api/operator-tasks';
import { useOperatorAuth } from '../operator-auth';

type TaskFilter = 'actionable' | 'queued' | 'recoverable' | 'all';

type PendingAction = {
  task: ReviewTaskRecord;
  action: OperatorTaskAction;
  idempotencyKey: string;
};

const ACTION_META: Record<OperatorTaskAction, {
  label: string;
  color: string;
  description: string;
  consequence: string;
}> = {
  pause: {
    label: 'Pause',
    color: 'yellow',
    description: 'Prevent queued work from being claimed until an operator resumes it.',
    consequence: 'The task transitions to PAUSED and will not dispatch.',
  },
  resume: {
    label: 'Resume',
    color: 'teal',
    description: 'Return paused work to its accepted queue state and request dispatch.',
    consequence: 'The task returns to QUEUED or FIX_QUEUED and dispatch is requested once.',
  },
  cancel: {
    label: 'Cancel',
    color: 'red',
    description: 'Cancel queued work immediately or request cooperative cancellation for running work.',
    consequence: 'Queued work becomes CANCELLED; active work becomes CANCEL_REQUESTED.',
  },
  retry: {
    label: 'Retry',
    color: 'violet',
    description: 'Requeue a recoverable terminal task using the existing retry budget and fencing rules.',
    consequence: 'The attempt count increases and dispatch is requested once if the server accepts the retry.',
  },
};

function taskTitle(task: ReviewTaskRecord) {
  return String(task.task_text || reviewTaskId(task) || 'Untitled review task');
}

function relativeTime(value: string | undefined) {
  if (!value) return 'time unavailable';
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  const seconds = Math.round((parsed.getTime() - Date.now()) / 1000);
  const formatter = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
  const ranges: Array<[Intl.RelativeTimeFormatUnit, number]> = [
    ['day', 86_400],
    ['hour', 3_600],
    ['minute', 60],
  ];
  for (const [unit, amount] of ranges) {
    if (Math.abs(seconds) >= amount) return formatter.format(Math.round(seconds / amount), unit);
  }
  return formatter.format(seconds, 'second');
}

function matchesFilter(task: ReviewTaskRecord, filter: TaskFilter) {
  const state = normalizeReviewTaskState(task.state);
  const actions = availableReviewTaskActions(state);
  if (filter === 'actionable') return actions.length > 0;
  if (filter === 'queued') return ['QUEUED', 'FIX_QUEUED', 'PAUSED', 'CLAIMED', 'RUNNING', 'FIXING'].includes(state);
  if (filter === 'recoverable') return ['ERROR', 'NEEDS_HUMAN', 'SUPERSEDED', 'CANCELLED'].includes(state);
  return true;
}

function rolesCanManageTasks(roles: string[]) {
  return roles.includes('operator') || roles.includes('administrator');
}

function actionIcon(action: OperatorTaskAction) {
  if (action === 'pause') return <IconPlayerPause size={14} />;
  if (action === 'resume') return <IconPlayerPlay size={14} />;
  if (action === 'retry') return <IconRefresh size={14} />;
  return <IconX size={14} />;
}

export function TaskControlDesk() {
  const auth = useOperatorAuth();
  const queryClient = useQueryClient();
  const [filter, setFilter] = useState<TaskFilter>('actionable');
  const [pending, setPending] = useState<PendingAction | null>(null);
  const [reason, setReason] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [uncertainDelivery, setUncertainDelivery] = useState<string | null>(null);

  const query = useQuery({
    queryKey: ['review-tasks'],
    queryFn: () => operatorTasksApi.list(100),
    refetchInterval: 10_000,
  });

  const canManage = auth.mode === 'session'
    && Boolean(auth.session)
    && rolesCanManageTasks(auth.session?.session.roles || []);

  const visibleTasks = useMemo(
    () => (query.data?.tasks || []).filter((task) => matchesFilter(task, filter)),
    [filter, query.data?.tasks],
  );

  const openAction = (task: ReviewTaskRecord, action: OperatorTaskAction) => {
    setPending({ task, action, idempotencyKey: createTaskActionIdempotencyKey() });
    setReason('');
    setConfirmed(false);
    setUncertainDelivery(null);
  };

  const closeAction = () => {
    if (submitting) return;
    setPending(null);
    setReason('');
    setConfirmed(false);
    setUncertainDelivery(null);
  };

  const refreshAffectedQueries = async () => {
    for (const queryKey of [
      ['review-tasks'],
      ['interventions'],
      ['ops-dashboard'],
      ['mission-room'],
      ['agent-fleet'],
    ]) {
      await queryClient.invalidateQueries({ queryKey });
    }
  };

  const submitAction = async () => {
    if (!pending || !auth.session || !confirmed || !reason.trim()) return;
    setSubmitting(true);
    setUncertainDelivery(null);
    try {
      const result = await operatorTasksApi.act({
        taskId: reviewTaskId(pending.task),
        action: pending.action,
        reason: reason.trim(),
        idempotencyKey: pending.idempotencyKey,
        csrfToken: auth.session.csrf_token,
      });
      await refreshAffectedQueries();
      notifications.show({
        color: 'teal',
        title: result.idempotent_replay ? 'Action already accepted' : `${ACTION_META[pending.action].label} accepted`,
        message: `${result.task.id} is now ${result.task.state}. Audit ${result.audit_event_id}.`,
      });
      setPending(null);
      setReason('');
      setConfirmed(false);
    } catch (error) {
      if (error instanceof OperatorTaskApiError) {
        await refreshAffectedQueries();
        const details = [error.errorCode, error.auditEventId ? `audit ${error.auditEventId}` : null]
          .filter(Boolean)
          .join(' · ');
        notifications.show({
          color: 'red',
          title: 'Task action rejected',
          message: `${error.message}${details ? ` (${details})` : ''}`,
        });
        setPending(null);
        setReason('');
        setConfirmed(false);
      } else {
        setUncertainDelivery(
          'The browser did not receive a definite server response. The same idempotency key is retained; retrying this dialog cannot duplicate an accepted transition.',
        );
      }
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Paper withBorder p="lg">
      <Stack gap="lg">
        <Group justify="space-between" align="flex-start" wrap="wrap">
          <Group gap="sm" align="flex-start">
            <ThemeIcon variant="light" color="violet" size={40} radius="md"><IconListCheck size={21} /></ThemeIcon>
            <Box>
              <Title order={3}>Task control desk</Title>
              <Text size="sm" c="dimmed" mt={3}>
                Governed pause, resume, cancel, and retry actions backed by the existing review-task mutation contract.
              </Text>
            </Box>
          </Group>
          <Group gap="sm">
            <SegmentedControl
              value={filter}
              onChange={(value) => setFilter(value as TaskFilter)}
              data={[
                { label: 'Actionable', value: 'actionable' },
                { label: 'Queued', value: 'queued' },
                { label: 'Recoverable', value: 'recoverable' },
                { label: 'All', value: 'all' },
              ]}
            />
            <Button variant="default" size="sm" leftSection={<IconRefresh size={15} />} loading={query.isFetching} onClick={() => query.refetch()}>
              Refresh
            </Button>
          </Group>
        </Group>

        {auth.mode === 'legacy' && (
          <Alert color="orange" icon={<IconAlertTriangle size={17} />} title="Human session required">
            Dashboard-token mode remains read only. Sign in through the human operator session endpoint before using task controls.
          </Alert>
        )}

        {auth.mode === 'session' && !canManage && (
          <Alert color="orange" icon={<IconAlertTriangle size={17} />} title="Task management permission required">
            Your current roles do not include <Code>task.manage</Code>. The server remains authoritative and will reject unauthorized mutations.
          </Alert>
        )}

        <Alert color="blue" variant="light" icon={<IconShieldCheck size={17} />} title="Server-authoritative controls">
          Every request carries the session CSRF token, a human-readable reason, and one idempotency key. The server enforces RBAC, legal transitions, retry budget, locking, dispatch, emergency read-only mode, and durable audit.
        </Alert>

        {query.isLoading ? (
          <Skeleton height={260} />
        ) : query.isError ? (
          <Alert color="red" icon={<IconAlertTriangle size={17} />} title="Review tasks unavailable">
            The authenticated review-task read contract could not be loaded. No mutation was attempted.
          </Alert>
        ) : visibleTasks.length === 0 ? (
          <Stack align="center" gap="xs" py="xl" ta="center">
            <ThemeIcon size={42} radius="xl" variant="light" color="teal"><IconShieldCheck size={21} /></ThemeIcon>
            <Text fw={700}>No tasks match this control view</Text>
            <Text size="sm" c="dimmed">Only states with accepted browser actions appear in the Actionable view.</Text>
          </Stack>
        ) : (
          <Table.ScrollContainer minWidth={900}>
            <Table verticalSpacing="md" highlightOnHover>
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>Task</Table.Th>
                  <Table.Th>State</Table.Th>
                  <Table.Th>Attempt</Table.Th>
                  <Table.Th>Updated</Table.Th>
                  <Table.Th>Accepted actions</Table.Th>
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {visibleTasks.map((task) => {
                  const id = reviewTaskId(task);
                  const state = normalizeReviewTaskState(task.state);
                  const actions = availableReviewTaskActions(state);
                  return (
                    <Table.Tr key={id}>
                      <Table.Td>
                        <Box maw={420}>
                          <Text fw={600} size="sm" lineClamp={2}>{taskTitle(task)}</Text>
                          <Text size="xs" c="dimmed" ff="monospace" lineClamp={1}>{id}</Text>
                          <Text size="xs" c="dimmed">{task.repository || 'repository unavailable'} · {task.agent || 'agent unavailable'}</Text>
                        </Box>
                      </Table.Td>
                      <Table.Td><Badge variant="light" color={actions.length ? 'violet' : 'gray'}>{state.replaceAll('_', ' ')}</Badge></Table.Td>
                      <Table.Td>
                        <Text size="sm">{Number(task.attempt || 0)}</Text>
                        {Number.isFinite(Number(task.policy?.retry_budget)) && (
                          <Text size="xs" c="dimmed">budget {task.policy?.retry_budget}</Text>
                        )}
                      </Table.Td>
                      <Table.Td><Text size="sm" c="dimmed">{relativeTime(task.updated_at || task.created_at)}</Text></Table.Td>
                      <Table.Td>
                        <Group gap={6} wrap="wrap">
                          {actions.length ? actions.map((action) => (
                            <Button
                              key={action}
                              size="compact-sm"
                              variant={action === 'cancel' ? 'light' : 'default'}
                              color={ACTION_META[action].color}
                              leftSection={actionIcon(action)}
                              disabled={!canManage || submitting}
                              onClick={() => openAction(task, action)}
                            >
                              {ACTION_META[action].label}
                            </Button>
                          )) : <Text size="xs" c="dimmed">No legal browser action</Text>}
                        </Group>
                      </Table.Td>
                    </Table.Tr>
                  );
                })}
              </Table.Tbody>
            </Table>
          </Table.ScrollContainer>
        )}
      </Stack>

      <Modal
        opened={Boolean(pending)}
        onClose={closeAction}
        title={pending ? `${ACTION_META[pending.action].label} review task` : 'Review task action'}
        centered
        size="lg"
        closeOnClickOutside={!submitting}
        closeOnEscape={!submitting}
      >
        {pending && (
          <Stack gap="md">
            <Alert color={ACTION_META[pending.action].color} variant="light" title={ACTION_META[pending.action].description}>
              {ACTION_META[pending.action].consequence}
            </Alert>

            <Paper withBorder p="sm">
              <Stack gap={5}>
                <Text size="sm" fw={700}>{taskTitle(pending.task)}</Text>
                <Text size="xs" c="dimmed" ff="monospace">{reviewTaskId(pending.task)}</Text>
                <Group gap={6}>
                  <Badge variant="light" color="gray">{normalizeReviewTaskState(pending.task.state)}</Badge>
                  <Text size="xs" c="dimmed">Attempt {Number(pending.task.attempt || 0)}</Text>
                </Group>
              </Stack>
            </Paper>

            {uncertainDelivery && (
              <Alert color="orange" icon={<IconAlertTriangle size={17} />} title="Delivery status uncertain">
                {uncertainDelivery}
              </Alert>
            )}

            <Textarea
              label="Operator reason"
              description="Required for durable actor-attributed audit. Maximum 500 characters."
              placeholder="Explain why this state transition is necessary..."
              value={reason}
              onChange={(event) => setReason(event.currentTarget.value.slice(0, 500))}
              minRows={3}
              maxLength={500}
              disabled={submitting}
              required
            />

            <Checkbox
              checked={confirmed}
              onChange={(event) => setConfirmed(event.currentTarget.checked)}
              disabled={submitting}
              label={`I confirm the ${ACTION_META[pending.action].label.toLowerCase()} action for this exact task and understand the stated consequence.`}
            />

            <Text size="xs" c="dimmed">
              Request key <Code>{pending.idempotencyKey}</Code>. It remains unchanged if the browser must retry an uncertain delivery.
            </Text>

            <Group justify="flex-end">
              <Button variant="default" onClick={closeAction} disabled={submitting}>Back</Button>
              <Button
                color={ACTION_META[pending.action].color}
                loading={submitting}
                disabled={!confirmed || !reason.trim() || reason.trim().length > 500}
                onClick={() => { void submitAction(); }}
              >
                Confirm {ACTION_META[pending.action].label.toLowerCase()}
              </Button>
            </Group>
          </Stack>
        )}
      </Modal>
    </Paper>
  );
}
