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
  Select,
  Stack,
  Table,
  Text,
  Textarea,
  TextInput,
  ThemeIcon,
  Title,
} from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { useQueryClient } from '@tanstack/react-query';
import {
  IconAlertTriangle,
  IconBolt,
  IconGitBranch,
  IconShieldCheck,
  IconTrash,
} from '@tabler/icons-react';
import { useMemo, useState } from 'react';

import type { MissionRoom, MissionRoomStage } from '../api/missions';
import {
  createInvestigationIdempotencyKey,
  deriveInvestigationActions,
  OperatorInvestigationApiError,
  operatorInvestigationsApi,
  rolesAllowInvestigationAction,
  type InvestigationActionOption,
  type InvestigationBrowserAction,
} from '../api/operator-investigations';
import { useOperatorAuth } from '../operator-auth';

interface PendingInvestigationAction {
  stage: MissionRoomStage;
  option: InvestigationActionOption;
  idempotencyKey: string;
}

function label(value: string | null | undefined) {
  return String(value || 'unavailable').replaceAll('_', ' ');
}

function actionIcon(action: InvestigationBrowserAction) {
  if (action.startsWith('effect_')) return <IconBolt size={15} />;
  if (action === 'workspace_cleanup') return <IconTrash size={15} />;
  return <IconGitBranch size={15} />;
}

function defaultOutput(stage: MissionRoomStage) {
  return stage.workspace?.resolved_sha || stage.output_sha || '';
}

function defaultResult(stage: MissionRoomStage) {
  return stage.stage === 'review' ? 'review.approved' : 'ok';
}

export function InvestigationControlPanel({ room, compact = false }: { room: MissionRoom; compact?: boolean }) {
  const auth = useOperatorAuth();
  const queryClient = useQueryClient();
  const [pending, setPending] = useState<PendingInvestigationAction | null>(null);
  const [reason, setReason] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const [outputSha, setOutputSha] = useState('');
  const [resultCode, setResultCode] = useState('ok');
  const [submitting, setSubmitting] = useState(false);
  const [uncertainDelivery, setUncertainDelivery] = useState(false);

  const roles = auth.session?.session.roles || [];
  const actionable = useMemo(
    () => room.timeline
      .map((stage) => ({ stage, actions: deriveInvestigationActions(room, stage) }))
      .filter((entry) => entry.actions.length > 0),
    [room],
  );

  const openAction = (stage: MissionRoomStage, option: InvestigationActionOption) => {
    setPending({ stage, option, idempotencyKey: createInvestigationIdempotencyKey() });
    setReason('');
    setConfirmed(false);
    setOutputSha(defaultOutput(stage));
    setResultCode(defaultResult(stage));
    setUncertainDelivery(false);
  };

  const closeAction = () => {
    if (submitting) return;
    setPending(null);
    setReason('');
    setConfirmed(false);
    setOutputSha('');
    setResultCode('ok');
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
      const stage = pending.stage;
      const result = await operatorInvestigationsApi.act({
        workflowId: room.workflow.workflow_id,
        childId: stage.child_id || '',
        effectId: stage.provider_effect?.effect_id || null,
        workspaceId: stage.workspace?.workspace_id || null,
        expectedAttempt: stage.attempt,
        expectedState: stage.workspace?.state || null,
        expectedHeadSha: stage.state === 'completed' && stage.output_sha ? stage.output_sha : stage.input_sha,
        action: pending.option.action,
        reason: reason.trim(),
        idempotencyKey: pending.idempotencyKey,
        csrfToken: auth.session.csrf_token,
        outputSha: pending.option.requiresOutput ? outputSha.trim() : null,
        resultCode: pending.option.requiresResultCode ? resultCode.trim() : null,
      });
      await refreshAffectedQueries();
      notifications.show({
        color: 'teal',
        title: result.idempotent_replay ? 'Investigation action already accepted' : `${pending.option.label} accepted`,
        message: `${result.operation} recorded. Audit ${result.audit_event_id}.`,
      });
      closeAction();
    } catch (error) {
      if (error instanceof OperatorInvestigationApiError) {
        await refreshAffectedQueries();
        const details = [error.errorCode, error.auditEventId ? `audit ${error.auditEventId}` : null]
          .filter(Boolean)
          .join(' · ');
        notifications.show({
          color: 'red',
          title: 'Investigation action rejected',
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
            <ThemeIcon variant="light" color="orange" size={compact ? 34 : 40} radius="md">
              <IconAlertTriangle size={compact ? 18 : 21} />
            </ThemeIcon>
            <Box>
              <Title order={compact ? 4 : 3}>Effect and workspace investigation</Title>
              <Text size="sm" c="dimmed" mt={3}>
                Resolve uncertain provider evidence and govern workspace holds without replaying providers or deleting files from the browser.
              </Text>
            </Box>
          </Group>
          <Badge variant="light" color="orange">{actionable.length} actionable stage{actionable.length === 1 ? '' : 's'}</Badge>
        </Group>

        {auth.mode === 'legacy' && (
          <Alert color="orange" icon={<IconAlertTriangle size={17} />} title="Human session required">
            Dashboard-token mode remains read only. Investigation mutations require an authenticated human operator session.
          </Alert>
        )}

        <Alert color="blue" variant="light" icon={<IconShieldCheck size={17} />} title="Uncertain effects are never replayed">
          A needs-human effect must first be verified as completed or safe to retry. Workspace cleanup is only requested here; physical deletion remains a separate server-owned operation.
        </Alert>

        {actionable.length === 0 ? (
          <Text size="sm" c="dimmed">No effect-resolution or workspace-investigation action is suggested by the current bounded evidence.</Text>
        ) : (
          <Table.ScrollContainer minWidth={820}>
            <Table verticalSpacing="sm" highlightOnHover>
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>Stage</Table.Th>
                  <Table.Th>Evidence</Table.Th>
                  <Table.Th>Investigation actions</Table.Th>
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {actionable.map(({ stage, actions }) => (
                  <Table.Tr key={stage.key}>
                    <Table.Td>
                      <Text fw={700} size="sm">Iteration {stage.iteration} · {label(stage.stage)}</Text>
                      <Text size="xs" c="dimmed">{stage.owner_agent} · attempt {stage.attempt}</Text>
                      <Text size="xs" ff="monospace" c="dimmed">{stage.child_id}</Text>
                    </Table.Td>
                    <Table.Td>
                      <Stack gap={3}>
                        <Text size="xs">Effect <Code>{label(stage.provider_effect?.state)}</Code></Text>
                        <Text size="xs" ff="monospace">{stage.provider_effect?.effect_id || 'no effect'}</Text>
                        <Text size="xs">Workspace <Code>{label(stage.workspace?.state)}</Code></Text>
                        <Text size="xs" ff="monospace">{stage.workspace?.workspace_id || 'no workspace'}</Text>
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
                            disabled={auth.mode !== 'session' || !rolesAllowInvestigationAction(roles) || submitting}
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
        title={pending?.option.label || 'Investigation action'}
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
              <Text size="sm" fw={700}>Iteration {pending.stage.iteration} · {label(pending.stage.stage)} · attempt {pending.stage.attempt}</Text>
              <Text size="xs" ff="monospace" c="dimmed">{room.workflow?.workflow_id}</Text>
              <Text size="xs" ff="monospace" c="dimmed">{pending.stage.child_id}</Text>
              {pending.stage.provider_effect?.effect_id && <Text size="xs" ff="monospace" c="dimmed">{pending.stage.provider_effect.effect_id}</Text>}
              {pending.stage.workspace?.workspace_id && <Text size="xs" ff="monospace" c="dimmed">{pending.stage.workspace.workspace_id}</Text>}
            </Paper>

            {pending.option.requiresOutput && (
              <TextInput
                label="Verified output SHA"
                description="Must be the exact 40-character workspace HEAD observed by the server."
                value={outputSha}
                onChange={(event) => setOutputSha(event.currentTarget.value)}
                maxLength={40}
                disabled={submitting}
                required
              />
            )}

            {pending.option.requiresResultCode && pending.stage.stage === 'review' ? (
              <Select
                label="Verified review result"
                value={resultCode}
                onChange={(value) => setResultCode(value || 'review.approved')}
                data={[
                  { value: 'review.approved', label: 'Berlin approved' },
                  { value: 'review.changes_requested:operator_verified', label: 'Berlin requested changes' },
                ]}
                disabled={submitting}
              />
            ) : pending.option.requiresResultCode ? (
              <TextInput label="Verified result code" value="ok" disabled />
            ) : null}

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
                The same request key is retained. Retrying this open dialog cannot duplicate a previously accepted mutation.
              </Alert>
            )}

            <Group justify="flex-end">
              <Button variant="default" onClick={closeAction} disabled={submitting}>Cancel</Button>
              <Button
                color={pending.option.color}
                loading={submitting}
                disabled={!reason.trim() || !confirmed || (pending.option.requiresOutput && outputSha.trim().length !== 40)}
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
