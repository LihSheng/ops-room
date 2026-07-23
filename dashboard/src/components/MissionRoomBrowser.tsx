import {
  Alert,
  Badge,
  Box,
  Button,
  Code,
  Group,
  Modal,
  Paper,
  Skeleton,
  Stack,
  Table,
  Text,
  ThemeIcon,
  Title,
} from '@mantine/core';
import { useQuery } from '@tanstack/react-query';
import {
  IconAlertTriangle,
  IconEye,
  IconRoute,
  IconShieldCheck,
} from '@tabler/icons-react';
import { useState } from 'react';

import { missionsApi, type MissionRecord } from '../api/missions';
import { MissionRoomTimeline } from './MissionRoomTimeline';

function stateColor(state: MissionRecord['state']) {
  if (state === 'active' || state === 'completed') return 'teal';
  if (state === 'needs_human') return 'orange';
  if (state === 'paused' || state === 'planned') return 'blue';
  if (state === 'cancelled') return 'red';
  return 'gray';
}

function shortSha(value: string | null) {
  return value ? value.slice(0, 12) : 'unavailable';
}

function label(value: string | null | undefined) {
  return String(value || 'unavailable').replaceAll('_', ' ');
}

export function MissionRoomBrowser() {
  const [selected, setSelected] = useState<MissionRecord | null>(null);
  const missionsQuery = useQuery({
    queryKey: ['missions'],
    queryFn: missionsApi.listMissions,
    refetchInterval: 10_000,
  });
  const roomQuery = useQuery({
    queryKey: ['mission-room', selected?.mission_id],
    queryFn: () => missionsApi.getMission(selected!.mission_id),
    enabled: Boolean(selected),
    refetchInterval: selected ? 10_000 : false,
  });
  const missions = missionsQuery.data?.missions.filter((mission) => !mission.unavailable) || [];

  return (
    <Paper withBorder p="lg">
      <Stack gap="md">
        <Group justify="space-between" align="flex-start" wrap="wrap">
          <Group gap="sm" align="flex-start">
            <ThemeIcon variant="light" color="violet" size={38} radius="md">
              <IconRoute size={20} />
            </ThemeIcon>
            <Box>
              <Title order={3}>Mission Rooms</Title>
              <Text size="sm" c="dimmed" mt={3}>
                Inspect the durable Mission and its exact Professor → Tokyo → Professor → Berlin workflow timeline.
              </Text>
            </Box>
          </Group>
          <Badge variant="light" color="violet">{missions.length} missions</Badge>
        </Group>

        <Alert color="blue" variant="light" icon={<IconShieldCheck size={18} />} title="Read-only evidence boundary">
          Mission Rooms join existing Mission, Workflow, workspace, and provider-effect records. They do not dispatch agents, invoke providers, mutate Git, or replay uncertain effects.
        </Alert>

        {missionsQuery.isLoading ? (
          <Skeleton height={170} radius="md" />
        ) : missionsQuery.isError ? (
          <Alert color="red" icon={<IconAlertTriangle size={18} />} title="Mission list unavailable">
            The authenticated Mission read contract could not be loaded.
          </Alert>
        ) : missions.length ? (
          <Table.ScrollContainer minWidth={850}>
            <Table verticalSpacing="md" highlightOnHover>
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>Mission</Table.Th>
                  <Table.Th>Status</Table.Th>
                  <Table.Th>Repository</Table.Th>
                  <Table.Th>Starting point</Table.Th>
                  <Table.Th>Workflow</Table.Th>
                  <Table.Th />
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {missions.map((mission) => (
                  <Table.Tr key={mission.mission_id}>
                    <Table.Td>
                      <Text size="sm" fw={700}>{mission.title}</Text>
                      <Text size="xs" c="dimmed" lineClamp={1}>{mission.objective}</Text>
                    </Table.Td>
                    <Table.Td><Badge color={stateColor(mission.state)} variant="light">{label(mission.state)}</Badge></Table.Td>
                    <Table.Td><Text size="sm" ff="monospace">{mission.repository_id || 'Unavailable'}</Text></Table.Td>
                    <Table.Td>
                      <Text size="sm">{mission.starting_branch || 'Unavailable'}</Text>
                      <Code>{shortSha(mission.starting_sha)}</Code>
                    </Table.Td>
                    <Table.Td>
                      <Text size="sm">{mission.workflow_id ? 'Bound' : 'Not started'}</Text>
                      <Text size="xs" c="dimmed" ff="monospace" lineClamp={1}>{mission.workflow_id || 'No workflow ID'}</Text>
                    </Table.Td>
                    <Table.Td>
                      <Button
                        variant="light"
                        size="compact-sm"
                        leftSection={<IconEye size={14} />}
                        onClick={() => setSelected(mission)}
                      >
                        Open room
                      </Button>
                    </Table.Td>
                  </Table.Tr>
                ))}
              </Table.Tbody>
            </Table>
          </Table.ScrollContainer>
        ) : (
          <Stack align="center" gap="xs" py="lg" ta="center">
            <ThemeIcon size={42} radius="xl" variant="light" color="gray"><IconRoute size={21} /></ThemeIcon>
            <Text fw={600}>No missions recorded</Text>
            <Text size="sm" c="dimmed">Create a mission to establish the first Mission Room.</Text>
          </Stack>
        )}
      </Stack>

      <Modal
        opened={Boolean(selected)}
        onClose={() => setSelected(null)}
        title="Mission Room"
        size="calc(100vw - 80px)"
        centered
      >
        {roomQuery.isLoading ? (
          <Stack gap="md"><Skeleton height={110} /><Skeleton height={360} /></Stack>
        ) : roomQuery.isError ? (
          <Alert color="red" icon={<IconAlertTriangle size={18} />} title="Mission Room unavailable">
            The bounded Mission Room read contract could not be loaded.
          </Alert>
        ) : roomQuery.data?.room ? (
          <Stack gap="lg">
            <Paper withBorder p="lg">
              <Group justify="space-between" align="flex-start" wrap="wrap">
                <Box>
                  <Group gap="sm">
                    <Title order={2}>{roomQuery.data.room.mission.title}</Title>
                    <Badge color={stateColor(roomQuery.data.room.mission.state)} size="lg">
                      {label(roomQuery.data.room.mission.state)}
                    </Badge>
                  </Group>
                  <Text c="dimmed" mt={6}>{roomQuery.data.room.mission.objective}</Text>
                </Box>
                <Group gap={6}>
                  {Object.entries(roomQuery.data.room.sources).map(([source, status]) => (
                    <Badge
                      key={source}
                      variant="light"
                      color={status === 'available' ? 'teal' : status === 'not_applicable' ? 'gray' : 'orange'}
                    >
                      {source}: {label(status)}
                    </Badge>
                  ))}
                </Group>
              </Group>

              <Group gap="xl" mt="lg" align="flex-start" wrap="wrap">
                <Box><Text size="xs" c="dimmed">Repository</Text><Text size="sm" fw={600} ff="monospace">{roomQuery.data.room.mission.repository_id || 'Unavailable'}</Text></Box>
                <Box><Text size="xs" c="dimmed">Starting point</Text><Text size="sm" fw={600}>{roomQuery.data.room.mission.starting_branch || 'Unavailable'} · <Code>{shortSha(roomQuery.data.room.mission.starting_sha)}</Code></Text></Box>
                <Box><Text size="xs" c="dimmed">Workflow</Text><Text size="sm" fw={600}>{roomQuery.data.room.workflow ? label(roomQuery.data.room.workflow.state) : 'Not bound'}</Text></Box>
                <Box><Text size="xs" c="dimmed">Participants</Text><Text size="sm" fw={600}>{roomQuery.data.room.mission.participants.map((participant) => participant.agent_id).join(', ')}</Text></Box>
              </Group>
            </Paper>

            {roomQuery.data.room.summary.attention_required && (
              <Alert color="orange" variant="light" icon={<IconAlertTriangle size={18} />} title="Mission Room needs attention">
                One or more durable authorities report needs-human, conflicting, missing, or degraded evidence.
              </Alert>
            )}

            <MissionRoomTimeline room={roomQuery.data.room} />
          </Stack>
        ) : (
          <Alert color="orange" icon={<IconAlertTriangle size={18} />} title="Mission Room evidence unavailable">
            {label(roomQuery.data?.room_error_code || 'mission_room_unavailable')}. The Mission record remains readable, but missing workflow evidence was not inferred.
          </Alert>
        )}
      </Modal>
    </Paper>
  );
}
