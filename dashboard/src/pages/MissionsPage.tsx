import {
  Alert,
  Badge,
  Box,
  Button,
  Code,
  Group,
  Paper,
  SegmentedControl,
  SimpleGrid,
  Skeleton,
  Stack,
  Table,
  Text,
  TextInput,
  ThemeIcon,
  Title,
} from '@mantine/core';
import { useQuery } from '@tanstack/react-query';
import {
  IconAlertTriangle,
  IconChevronRight,
  IconRefresh,
  IconRoute,
  IconSearch,
  IconShieldCheck,
} from '@tabler/icons-react';
import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';

import { missionsApi, type MissionRecord } from '../api/missions';
import { missionLabel, missionStateColor } from '../components/MissionRoomContent';

type MissionFilter = 'all' | 'planned' | 'active' | 'attention' | 'completed';

function shortSha(value: string | null) {
  return value ? value.slice(0, 12) : 'unavailable';
}

function matchesFilter(mission: MissionRecord, filter: MissionFilter) {
  if (filter === 'planned') return mission.state === 'planned';
  if (filter === 'active') return mission.state === 'active' || mission.state === 'paused';
  if (filter === 'attention') return mission.state === 'needs_human';
  if (filter === 'completed') return mission.state === 'completed' || mission.state === 'cancelled';
  return true;
}

function matchesSearch(mission: MissionRecord, search: string) {
  const normalized = search.trim().toLowerCase();
  if (!normalized) return true;
  return [
    mission.mission_id,
    mission.title,
    mission.objective,
    mission.repository_id,
    mission.starting_branch,
    mission.starting_sha,
    mission.workflow_id,
    mission.priority,
    mission.github_issue,
    ...mission.participants.map((participant) => participant.agent_id),
  ].some((value) => String(value || '').toLowerCase().includes(normalized));
}

function Metric({ label, value, helper, color }: { label: string; value: number; helper: string; color: string }) {
  return (
    <Paper withBorder p="md">
      <Text size="xs" c="dimmed" fw={700}>{label}</Text>
      <Text fz={28} fw={700} mt={3} c={color}>{value}</Text>
      <Text size="xs" c="dimmed" mt={3}>{helper}</Text>
    </Paper>
  );
}

export function MissionsPage() {
  const navigate = useNavigate();
  const [filter, setFilter] = useState<MissionFilter>('all');
  const [search, setSearch] = useState('');
  const query = useQuery({
    queryKey: ['missions'],
    queryFn: missionsApi.listMissions,
    refetchInterval: 10_000,
  });
  const missions = query.data?.missions || [];
  const available = missions.filter((mission) => !mission.unavailable);
  const visible = useMemo(
    () => available.filter((mission) => matchesFilter(mission, filter) && matchesSearch(mission, search)),
    [available, filter, search],
  );
  const planned = available.filter((mission) => mission.state === 'planned').length;
  const active = available.filter((mission) => mission.state === 'active' || mission.state === 'paused').length;
  const attention = available.filter((mission) => mission.state === 'needs_human').length;
  const completed = available.filter((mission) => mission.state === 'completed').length;

  return (
    <Stack gap="lg">
      <Group justify="space-between" align="flex-start" wrap="wrap">
        <Box>
          <Group gap="sm">
            <ThemeIcon variant="light" color="violet" size={42} radius="md"><IconRoute size={23} /></ThemeIcon>
            <Box>
              <Title order={1} className="page-title">Missions</Title>
              <Text c="dimmed" mt={4}>Operator-defined objectives and their deterministic multi-agent workflows.</Text>
            </Box>
          </Group>
        </Box>
        <Group gap="sm">
          <Button variant="default" onClick={() => navigate('/agents')}>Mission controls</Button>
          <Button variant="default" leftSection={<IconRefresh size={16} />} loading={query.isFetching} onClick={() => query.refetch()}>
            Refresh
          </Button>
        </Group>
      </Group>

      <Alert color="blue" variant="light" icon={<IconShieldCheck size={18} />} title="First-class read-only Mission Rooms">
        This page uses the accepted Mission and Mission Room read contracts. Creation and explicit start remain under Agent Fleet operator controls.
      </Alert>

      <SimpleGrid cols={{ base: 2, md: 4 }} spacing="md">
        <Metric label="Planned" value={planned} helper="Waiting for explicit start" color="gray" />
        <Metric label="Active" value={active} helper="Bound to workflow authority" color="violet" />
        <Metric label="Needs attention" value={attention} helper="Human evidence required" color="orange" />
        <Metric label="Completed" value={completed} helper="Terminal successful Missions" color="teal" />
      </SimpleGrid>

      <Paper withBorder p="lg">
        <Stack gap="md">
          <Group justify="space-between" align="flex-end" wrap="wrap">
            <TextInput
              label="Search Missions"
              placeholder="Title, repository, Mission ID, workflow, participant..."
              leftSection={<IconSearch size={16} />}
              value={search}
              onChange={(event) => setSearch(event.currentTarget.value)}
              style={{ flex: 1, minWidth: 280 }}
            />
            <SegmentedControl
              value={filter}
              onChange={(value) => setFilter(value as MissionFilter)}
              data={[
                { label: 'All', value: 'all' },
                { label: 'Planned', value: 'planned' },
                { label: 'Active', value: 'active' },
                { label: 'Attention', value: 'attention' },
                { label: 'Completed', value: 'completed' },
              ]}
            />
          </Group>

          {query.data && query.data.unavailable_count > 0 && (
            <Alert color="orange" variant="light" icon={<IconAlertTriangle size={17} />} title="Some Mission records are unavailable">
              {query.data.unavailable_count} durable record{query.data.unavailable_count === 1 ? '' : 's'} could not be validated and are excluded from navigation.
            </Alert>
          )}

          {query.isLoading ? (
            <Skeleton height={340} radius="md" />
          ) : query.isError ? (
            <Alert color="red" icon={<IconAlertTriangle size={18} />} title="Mission list unavailable">
              The authenticated Mission read contract could not be loaded.
            </Alert>
          ) : visible.length ? (
            <Table.ScrollContainer minWidth={940}>
              <Table verticalSpacing="md" highlightOnHover>
                <Table.Thead>
                  <Table.Tr>
                    <Table.Th>Mission</Table.Th>
                    <Table.Th>Status</Table.Th>
                    <Table.Th>Repository</Table.Th>
                    <Table.Th>Starting point</Table.Th>
                    <Table.Th>Workflow</Table.Th>
                    <Table.Th>Participants</Table.Th>
                    <Table.Th />
                  </Table.Tr>
                </Table.Thead>
                <Table.Tbody>
                  {visible.map((mission) => (
                    <Table.Tr key={mission.mission_id}>
                      <Table.Td>
                        <Text size="sm" fw={700}>{mission.title}</Text>
                        <Text size="xs" c="dimmed" lineClamp={1}>{mission.objective}</Text>
                        <Text size="xs" c="dimmed" ff="monospace" lineClamp={1}>{mission.mission_id}</Text>
                      </Table.Td>
                      <Table.Td>
                        <Badge color={missionStateColor(mission.state)} variant="light">{missionLabel(mission.state)}</Badge>
                        {mission.priority && <Text size="xs" c="dimmed" mt={4}>{mission.priority} priority</Text>}
                      </Table.Td>
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
                        <Group gap={5}>
                          {mission.participants.map((participant) => (
                            <Badge key={participant.agent_id} size="xs" variant="outline" color="violet">{participant.agent_id}</Badge>
                          ))}
                        </Group>
                      </Table.Td>
                      <Table.Td>
                        <Button
                          variant="subtle"
                          size="compact-sm"
                          rightSection={<IconChevronRight size={14} />}
                          onClick={() => navigate(`/missions/${encodeURIComponent(mission.mission_id)}`)}
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
            <Stack align="center" gap="xs" py="xl" ta="center">
              <ThemeIcon size={44} radius="xl" variant="light" color="gray"><IconRoute size={21} /></ThemeIcon>
              <Text fw={600}>No Missions match this view</Text>
              <Text size="sm" c="dimmed">Adjust the search or state filter. Mission records are never inferred from tasks or workflows.</Text>
            </Stack>
          )}
        </Stack>
      </Paper>
    </Stack>
  );
}
