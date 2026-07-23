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
  Stack,
  Table,
  Text,
  Textarea,
  ThemeIcon,
  Title,
} from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { useQueryClient } from '@tanstack/react-query';
import {
  IconAlertTriangle,
  IconPlayerPlay,
  IconRefresh,
  IconShieldCheck,
} from '@tabler/icons-react';
import { useMemo, useState } from 'react';

import {
  createWorkflowActionIdempotencyKey,
  deriveWorkflowStageActions,
  OperatorWorkflowApiError,
  operatorWorkflowsApi,
  rolesAllowWorkflowAction,
  type WorkflowActionOption,
  type WorkflowBrowserAction,
} from '../api/operator-workflows';
import type { MissionRoom, MissionRoomStage } from '../api/missions';
import { useOperatorAuth } from '../operator-auth';

interface PendingWorkflowAction {
  stage: MissionRoomStage;
  option: WorkflowActionOption;
  idempotencyKey: string;
}

function stateLabel(value: string | null | undefined) {
  return String(value || 'unavailable').replaceAll('_', ' ');
}

function actionIcon(action: WorkflowBrowserAction) {
  if (action === 'retry') return <IconRefresh size={15} />;
  if (action === 'resume') return <IconPlayerPlay size={15} />;
  return <IconShieldCheck size={15} />;
}

export function WorkflowControlPanel({ room, compact = false }: { room: MissionRoom; compact?: boolean }) {
  const auth = useOperatorAuth();
  const queryClient = useQueryClient();
  const [pending, setPending] = useState<PendingWorkflowAction | null>(null);
  const [reason, setReason] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [uncertainDelivery, setUncertainDelivery] = useState(false);

  const roles = auth.session?.session.roles || [];
  const actionable = useMemo(
    () => room.timeline
      .map((stage) => ({ stage, actions: deriveWorkflowStageActions(room, stage) }))
      .filter((entry) => entry.actions.length > 0),
    [room],
  );

  const openAction = (stage: MissionRoomStage, option: WorkflowActionOption) => {
    setPending({ stage, option, idempotencyKey: createWorkflowActionIdempotencyKey() });
    setReason('');
    setConfirmed(false);
    setUncertainDelivery(false);
  };

  const closeAction = () => {
    if (submitting) return;
    setPending(null);
    setReason('');
    setConfirmed(false);
    setUncertainDelivery(false);
  };

  const refreshAffectedQueries = async () => {
    const keys: Array<readonly unknown[]> = [
      ['mission-room', room.mission.mission_id],
      ['missions'],
      ['interventions'],
      ['ops-dashboard'],
      ['agent-fleet'],
      ['workflows'],
    ];
    await Promise.all(keys.map((queryKey) => queryClient.invalidateQueries({ queryKey })));
  };

  const submit = async () => {
    if (!pending || !auth.session || !confirmed || !reason.trim() || !room.workflow?.workflow_id) return;
    setSubmitting(true);
    setUncertainDelivery(false);
    try {
      const result = await operatorWorkflowsApi.act({
        workflowId: room.workflow.workflow_id,
        childId: pending.stage.child_id || '',
        expectedAttempt: pending.stage.attempt,
        action: pending.option.action,
        reason: reason.trim(),
        idempotencyKey: pending.idempotencyKey,
        csrfToken: auth.session.csrf_token,
      });
      await refreshAffectedQueries();
      notifications.show({
        color: 'teal',
        title: result.idempotent_replay ? 'Workflow action already accepted' : `${pending.option.label} accepted`,
        message: `${result.workflow.workflow_id} is ${stateLabel(result.workflow.state)}. Audit ${result.audit_event_id}.`,
      });
      setPending(null);
      setReason('');
      setConfirmed(false);
    } catch (error) {
      if (error instanceof OperatorWorkflowApiError) {
        await refreshAffectedQueries();
        const details = [error.errorCode, error.auditEventId ? `audit ${error.auditEventId}` : null]
          .filter(Boolean)
          .join(' · ');
        notifications.show({
          color: 'red',
          title: 'Workflow action rejected',
          message: `${error.message}${details ? ` (${details})` : ''}`,
        });
        setPending(null);
        setReason('');
        setConfirmed(false);
      } else {
        setUncertainDelivery(true);
      }
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Paper withBorder p={compact ? 'md' : 'lg'}>
      <Stack gap="md">
        <Group justify="space-between" align="flex-start" wrap="wrap">
          <Group gap="sm" align="flex-start">
            <ThemeIcon variant="light" color="violet" size={compact ? 34 : 40} radius="md">
              <IconShieldCheck size={compact ? 18 : 21} />
            </ThemeIcon>
            <Box>
              <Title order={compact ? 4 : 3}>Workflow controls</Title>
              <Text size="sm" c="dimmed" mt={3}>
                Exact-stage recovery and Berlin decisions backed by durable workflow, effect, and workspace authority.
              </Text>
            </Box>
          </Group>
          <Group gap={6}>
            <Badge variant="light" color="violet">{actionable.length} actionable stage{actionable.length === 1 ? '' : 's'}</Badge>
            {room.workflow && <Badge variant="outline" color="gray">{stateLabel(room.workflow.state)}</Badge>}
          </Group>
        </Group>

        {auth.mode === 'legacy' && (
          <Alert color="orange" icon={<IconAlertTriangle size={17} />} title="Human session required">
            Dashboard-token mode remains read only. Workflow mutations require an authenticated human operator session.
          </Alert>
        )}

        <Alert color="blue" variant="light" icon={<IconShieldCheck size={17} />} title="Server remains authoritative">
          Browser action availability is only a usability hint. The server re-reads the exact workflow, child, attempt, provider effect, workspace ownership, and SHA before accepting any transition.
        </Alert>

        {!room.workflow?.workflow_id ? (
          <Text size="sm" c="dimmed">This Mission is not bound to a durable workflow.</Text>
        ) : actionable.length === 0 ? (
          <Text size="sm" c="dimmed">No accepted workflow recovery or Berlin decision is suggested by the current bounded evidence.</Text>
        ) : (
          <Table.ScrollContainer minWidth={760}>
            <Table verticalSpacing="sm" highlightOnHover>
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>Stage</Table.Th>
                  <Table.Th>Evidence</Table.Th>
                  <Table.Th>Accepted actions</Table.Th>
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {actionable.map(({ stage, actions }) => (
                  <Table.Tr key={stage.key}>
                    <Table.Td>
                      <Text fw={700} size="sm">Iteration {stage.iteration} · {stateLabel(stage.stage)}</Text>
                      <Text size="xs" c="dimmed">{stage.owner_agent} · attempt {stage.attempt}</Text>
                      <Text size="xs" c="dimmed" ff="monospace">{stage.child_id}</Text>
                    </Table.Td>
                    <Table.Td>
                      <Stack gap={3}>
                        <Text size="xs">Stage <Code>{stateLabel(stage.state)}</Code></Text>
                        <Text size="xs">Effect <Code>{stateLabel(stage.provider_effect?.state)}</Code></Text>
                        <Text size="xs">Workspace <Code>{stateLabel(stage.workspace?.state)}</Code></Text>
                      </Stack>
                    </Table.Td>
                    <Table.Td>
                      <Group gap={6} wrap="wrap">
                        {actions.map((option) => (
                          <Button
                            key={option.action}
                            size="compact-sm"
                            variant="light"
                            color={option.color}
                            leftSection={actionIcon(option.action)}
                            disabled={auth.mode !== 'session' || !rolesAllowWorkflowAction(roles, option.action) || submitting}
                            onClick={() => openAction(stage, option)}
                          >
                            {option.label}
                          </Button>
                        ))}
                      </Group>
                    </Table.Td>
                  </Table.Tr>
                ))}
              </Table.Tbody>
            </Table>
          </Table.ScrollContainer>
        )}
      </Stack>

      <Modal
        opened={Boolean(pending)}
        onClose={closeAction}
        title={pending?.option.label || 'Workflow action'}
        centered
        closeOnClickOutside={!submitting}
        closeOnEscape={!submitting}
      >
        {pending && (
          <Stack gap="md">
            <Alert color={pending.option.color} variant="light" title="Exact consequence">
              <Text size="sm">{pending.option.description}</Text>
              <Text size="sm" fw={700} mt="xs">{pending.option.consequence}</Text>
            </Alert>

            <Paper withBorder p="sm" bg="gray.0">
              <Text size="xs" c="dimmed">Exact target</Text>
              <Text size="sm" fw={700}>Iteration {pending.stage.iteration} · {stateLabel(pending.stage.stage)} · attempt {pending.stage.attempt}</Text>
              <Text size="xs" ff="monospace" c="dimmed">{room.workflow?.workflow_id}</Text>
              <Text size="xs" ff="monospace" c="dimmed">{pending.stage.child_id}</Text>
            </Paper>

            <Textarea
              label="Operator reason"
              description="Required for durable actor-attributed audit evidence. Maximum 500 characters."
              minRows={3}
              maxLength={500}
              value={reason}
              onChange={(event) => setReason(event.currentTarget.value)}
              disabled={submitting}
              required
            />

            <Checkbox
              checked={confirmed}
              onChange={(event) => setConfirmed(event.currentTarget.checked)}
              disabled={submitting}
              label={`I understand: ${pending.option.consequence}`}
            />

            {uncertainDelivery && (
              <Alert color="orange" icon={<IconAlertTriangle size={17} />} title="Server response was not received">
                The same request key is retained. Retrying this open dialog cannot duplicate a previously accepted transition.
              </Alert>
            )}

            <Group justify="flex-end">
              <Button variant="default" onClick={closeAction} disabled={submitting}>Cancel</Button>
              <Button
                color={pending.option.color}
                loading={submitting}
                disabled={!reason.trim() || !confirmed}
                onClick={() => { void submit(); }}
              >
                Confirm {pending.option.label.toLowerCase()}
              </Button>
            </Group>
          </Stack>
        )}
      </Modal>
    </Paper>
  );
}
