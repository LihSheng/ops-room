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
  Skeleton,
  Stack,
  Table,
  Text,
  Textarea,
  ThemeIcon,
  Title,
} from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  IconAlertTriangle,
  IconCheck,
  IconPlayerPlay,
  IconRoute,
  IconShieldCheck,
} from '@tabler/icons-react';
import { useState } from 'react';
import type { FormEvent } from 'react';

import {
  MissionApiError,
  missionsApi,
  type MissionRecord,
  type StartMissionRequest,
} from '../api/missions';
import { useOperatorAuth } from '../operator-auth';
import { MissionRoomBrowser } from './MissionRoomBrowser';

function newRequestKey() {
  const random = globalThis.crypto?.randomUUID?.()
    || `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return `mission-start-${random}`;
}

function shortSha(value: string | null) {
  return value ? value.slice(0, 10) : 'unavailable';
}

function stateColor(state: MissionRecord['state']) {
  if (state === 'active' || state === 'completed') return 'teal';
  if (state === 'needs_human') return 'orange';
  if (state === 'cancelled') return 'red';
  return 'gray';
}

export function MissionStartPanel() {
  const queryClient = useQueryClient();
  const auth = useOperatorAuth();
  const query = useQuery({
    queryKey: ['missions'],
    queryFn: missionsApi.listMissions,
    refetchInterval: 10_000,
  });
  const [selected, setSelected] = useState<MissionRecord | null>(null);
  const [reason, setReason] = useState('');
  const [acknowledged, setAcknowledged] = useState(false);
  const [requestKey, setRequestKey] = useState(newRequestKey);
  const [attempted, setAttempted] = useState(false);
  const [clientError, setClientError] = useState<string | null>(null);

  const roles = auth.session?.session.roles.map((role) => role.toLowerCase()) || [];
  const canStart = auth.mode === 'session'
    && (roles.includes('operator') || roles.includes('administrator'));
  const csrfToken = auth.session?.csrf_token || null;

  const mutation = useMutation({
    mutationFn: ({ mission, request }: { mission: MissionRecord; request: StartMissionRequest }) => {
      if (!csrfToken) throw new Error('A valid human session is required to start a mission.');
      return missionsApi.startMission(mission.mission_id, request, csrfToken);
    },
    onSuccess: async (response) => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['missions'] }),
        queryClient.invalidateQueries({ queryKey: ['agent-fleet'] }),
        queryClient.invalidateQueries({ queryKey: ['ops-dashboard'] }),
      ]);
      notifications.show({
        color: 'teal',
        title: response.idempotent_replay ? 'Mission start already recorded' : 'Mission workflow started',
        message: `${response.mission.title} is active with a pending Professor implementation stage. No provider was invoked.`,
      });
      setSelected(null);
      setReason('');
      setAcknowledged(false);
      setRequestKey(newRequestKey());
      setAttempted(false);
      setClientError(null);
      mutation.reset();
    },
  });

  const resetAttemptIfEdited = () => {
    setClientError(null);
    if (attempted) {
      setAttempted(false);
      setRequestKey(newRequestKey());
      mutation.reset();
    }
  };

  const openStart = (mission: MissionRecord) => {
    setSelected(mission);
    setReason(`Start ${mission.title} from the recorded exact SHA.`);
    setAcknowledged(false);
    setRequestKey(newRequestKey());
    setAttempted(false);
    setClientError(null);
    mutation.reset();
  };

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!selected) return;
    const boundedReason = reason.trim();
    if (!boundedReason || boundedReason.length > 500) {
      setClientError('A start reason is required and must not exceed 500 characters.');
      return;
    }
    if (!acknowledged) {
      setClientError('Confirm that this creates workflow state but does not invoke a provider.');
      return;
    }

    setAttempted(true);
    setClientError(null);
    await mutation.mutateAsync({
      mission: selected,
      request: {
        reason: boundedReason,
        idempotency_key: requestKey,
      },
    }).catch(() => {
      // The bounded error remains visible and the same idempotency key is kept for a safe retry.
    });
  };

  const apiError = mutation.error instanceof MissionApiError ? mutation.error : null;
  const errorMessage = clientError
    || apiError?.message
    || (mutation.error instanceof Error ? mutation.error.message : null);
  const missions = query.data?.missions || [];
  const planned = missions.filter((mission) => mission.state === 'planned' && !mission.unavailable);
  const active = missions.filter((mission) => mission.state === 'active' && !mission.unavailable);

  return (
    <Stack gap="lg">
      <Paper withBorder p="lg">
        <Stack gap="md">
          <Group justify="space-between" align="flex-start" wrap="wrap">
            <Group gap="sm" align="flex-start">
              <ThemeIcon variant="light" color="violet" size={38} radius="md">
                <IconRoute size={20} />
              </ThemeIcon>
              <Box>
                <Title order={3}>Mission workflow queue</Title>
                <Text size="sm" c="dimmed" mt={3}>
                  Bind a planned mission to its deterministic workflow and create the first pending Professor stage.
                </Text>
              </Box>
            </Group>
            <Group gap="xs">
              <Badge color="gray" variant="light">{planned.length} planned</Badge>
              <Badge color="teal" variant="light">{active.length} active</Badge>
            </Group>
          </Group>

          <Alert color="blue" variant="light" icon={<IconShieldCheck size={18} />} title="Explicit start boundary">
            Starting creates durable mission/workflow binding and a pending implementation child. It does not allocate a workspace, dispatch an agent, or invoke a provider.
          </Alert>

          {!canStart && (
            <Alert color="gray" variant="light" title="Mission start requires operator authority">
              A human Operator or Administrator session is required. Legacy dashboard-token mode and other roles remain read-only.
            </Alert>
          )}

          {query.isLoading ? (
            <Skeleton height={130} radius="md" />
          ) : query.isError ? (
            <Alert color="red" icon={<IconAlertTriangle size={18} />} title="Mission queue unavailable">
              The bounded mission read contract could not be loaded. No start operation was attempted.
            </Alert>
          ) : planned.length ? (
            <Table.ScrollContainer minWidth={760}>
              <Table verticalSpacing="md" highlightOnHover>
                <Table.Thead>
                  <Table.Tr>
                    <Table.Th>Mission</Table.Th>
                    <Table.Th>Repository</Table.Th>
                    <Table.Th>Starting point</Table.Th>
                    <Table.Th>Policy</Table.Th>
                    <Table.Th />
                  </Table.Tr>
                </Table.Thead>
                <Table.Tbody>
                  {planned.map((mission) => (
                    <Table.Tr key={mission.mission_id}>
                      <Table.Td>
                        <Text size="sm" fw={600}>{mission.title}</Text>
                        <Text size="xs" c="dimmed" lineClamp={1}>{mission.objective}</Text>
                      </Table.Td>
                      <Table.Td><Text size="sm">{mission.repository_id || 'Unavailable'}</Text></Table.Td>
                      <Table.Td>
                        <Text size="sm">{mission.starting_branch || 'Unavailable'}</Text>
                        <Code>{shortSha(mission.starting_sha)}</Code>
                      </Table.Td>
                      <Table.Td>
                        <Text size="sm">{mission.policy?.max_iterations || 0} iterations</Text>
                        <Text size="xs" c="dimmed">Berlin approval required</Text>
                      </Table.Td>
                      <Table.Td>
                        <Button
                          size="compact-sm"
                          leftSection={<IconPlayerPlay size={14} />}
                          disabled={!canStart}
                          onClick={() => openStart(mission)}
                        >
                          Start
                        </Button>
                      </Table.Td>
                    </Table.Tr>
                  ))}
                </Table.Tbody>
              </Table>
            </Table.ScrollContainer>
          ) : (
            <Stack align="center" gap="xs" py="lg" ta="center">
              <ThemeIcon size={42} radius="xl" variant="light" color="teal"><IconCheck size={21} /></ThemeIcon>
              <Text fw={600}>No planned missions waiting</Text>
              <Text size="sm" c="dimmed">Create a mission first, or inspect active workflows below.</Text>
            </Stack>
          )}

          {active.length > 0 && (
            <Group gap="xs">
              <Text size="xs" c="dimmed">Active bindings:</Text>
              {active.slice(0, 4).map((mission) => (
                <Badge key={mission.mission_id} color={stateColor(mission.state)} variant="light">
                  {mission.title}
                </Badge>
              ))}
              {active.length > 4 && <Badge color="gray" variant="light">+{active.length - 4}</Badge>}
            </Group>
          )}
        </Stack>

        <Modal
          opened={Boolean(selected)}
          onClose={() => { if (!mutation.isPending) setSelected(null); }}
          title="Start mission workflow"
          centered
          size="lg"
          closeOnClickOutside={!mutation.isPending}
          closeOnEscape={!mutation.isPending}
        >
          <form onSubmit={submit}>
            <Stack gap="md">
              {selected && (
                <Paper withBorder p="md">
                  <Text fw={700}>{selected.title}</Text>
                  <Text size="sm" c="dimmed" mt={3}>{selected.repository_id} · {selected.starting_branch}</Text>
                  <Code mt="sm" block>{selected.starting_sha}</Code>
                </Paper>
              )}

              <Alert color="orange" variant="light" icon={<IconAlertTriangle size={18} />} title="Deliberate operation">
                This writes an active mission binding, an active workflow record, and one pending Professor implementation child. Provider execution remains separate.
              </Alert>

              {errorMessage && (
                <Alert color="red" icon={<IconAlertTriangle size={18} />} title="Mission was not started">
                  <Stack gap={4}>
                    <Text size="sm">{errorMessage}</Text>
                    {apiError?.errorCode && <Text size="xs" c="dimmed">Code: {apiError.errorCode}</Text>}
                    {apiError?.auditEventId && <Text size="xs" c="dimmed">Audit event: {apiError.auditEventId}</Text>}
                  </Stack>
                </Alert>
              )}

              <Textarea
                label="Start reason"
                description="Stored in bounded actor-attributed audit evidence."
                minRows={3}
                maxLength={500}
                value={reason}
                onChange={(event) => {
                  setReason(event.currentTarget.value);
                  resetAttemptIfEdited();
                }}
                required
                disabled={mutation.isPending}
              />

              <Checkbox
                checked={acknowledged}
                onChange={(event) => {
                  setAcknowledged(event.currentTarget.checked);
                  resetAttemptIfEdited();
                }}
                label="I understand that this creates workflow state but does not invoke a provider."
                disabled={mutation.isPending}
              />

              <Group justify="flex-end">
                <Button variant="default" onClick={() => setSelected(null)} disabled={mutation.isPending}>Cancel</Button>
                <Button
                  type="submit"
                  color="violet"
                  leftSection={<IconPlayerPlay size={16} />}
                  loading={mutation.isPending}
                  disabled={!reason.trim() || !acknowledged}
                >
                  Start mission
                </Button>
              </Group>
            </Stack>
          </form>
        </Modal>
      </Paper>

      <MissionRoomBrowser />
    </Stack>
  );
}
