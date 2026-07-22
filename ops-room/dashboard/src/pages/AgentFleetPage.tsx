import {
  Alert,
  Avatar,
  Badge,
  Box,
  Button,
  Card,
  Group,
  Paper,
  SegmentedControl,
  SimpleGrid,
  Skeleton,
  Stack,
  Text,
  TextInput,
  ThemeIcon,
  Title,
} from '@mantine/core';
import {
  IconActivity,
  IconAlertTriangle,
  IconChevronRight,
  IconGitBranch,
  IconRefresh,
  IconRobot,
  IconSearch,
  IconServer,
  IconUsers,
} from '@tabler/icons-react';
import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';

import type { AgentFleetItem, AgentFleetState } from '../api/agent-fleet';
import { useAgentFleet } from '../hooks/use-agent-fleet';

type FleetFilter = 'all' | 'working' | 'attention' | 'offline';

const WORKING_STATES = new Set<AgentFleetState>(['working', 'waiting']);
const OFFLINE_STATES = new Set<AgentFleetState>(['offline', 'unavailable']);

function stateColor(state: AgentFleetState | string | null | undefined) {
  switch (state) {
    case 'idle':
    case 'running':
    case 'healthy':
      return 'teal';
    case 'working':
      return 'violet';
    case 'waiting':
      return 'blue';
    case 'paused':
      return 'yellow';
    case 'needs_human':
      return 'orange';
    case 'offline':
    case 'unavailable':
    case 'failed':
    case 'error':
    case 'unhealthy':
      return 'red';
    default:
      return 'gray';
  }
}

function stateLabel(state: string | null | undefined) {
  return String(state || 'unknown').replaceAll('_', ' ');
}

function relativeTime(value: string | null) {
  if (!value) return 'No activity recorded';
  const timestamp = new Date(value).getTime();
  if (!Number.isFinite(timestamp)) return value;

  const seconds = Math.round((timestamp - Date.now()) / 1000);
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
    if (Math.abs(seconds) >= amount) {
      return formatter.format(Math.round(seconds / amount), unit);
    }
  }

  return formatter.format(seconds, 'second');
}

function matchesFilter(agent: AgentFleetItem, filter: FleetFilter) {
  if (filter === 'working') return WORKING_STATES.has(agent.state);
  if (filter === 'attention') return agent.attention.required || agent.state === 'needs_human';
  if (filter === 'offline') return OFFLINE_STATES.has(agent.state);
  return true;
}

function matchesSearch(agent: AgentFleetItem, search: string) {
  const normalized = search.trim().toLowerCase();
  if (!normalized) return true;

  const values = [
    agent.id,
    agent.display_name,
    agent.role,
    agent.description,
    agent.responsibility,
    agent.current_task?.title,
    agent.current_task?.repository,
    ...agent.repositories,
  ];

  return values.some((value) => String(value || '').toLowerCase().includes(normalized));
}

function FleetMetric({ label, value, helper, icon, color }: {
  label: string;
  value: number;
  helper: string;
  icon: React.ReactNode;
  color: string;
}) {
  return (
    <Paper withBorder p="md" className="fleet-metric">
      <Group justify="space-between" align="flex-start" wrap="nowrap">
        <Box>
          <Text size="xs" c="dimmed" fw={600}>{label}</Text>
          <Text fz={28} fw={700} mt={4}>{value}</Text>
          <Text size="xs" c="dimmed" mt={4}>{helper}</Text>
        </Box>
        <ThemeIcon variant="light" color={color} size={36} radius="md">{icon}</ThemeIcon>
      </Group>
    </Paper>
  );
}

function FleetCard({ agent }: { agent: AgentFleetItem }) {
  const navigate = useNavigate();
  const task = agent.current_task;
  const workspace = task?.workspace;
  const repositories = task?.repository ? [task.repository] : agent.repositories;

  return (
    <Card withBorder padding="lg" className="fleet-card">
      <Stack gap="md" h="100%">
        <Group justify="space-between" align="flex-start" wrap="nowrap">
          <Group gap="sm" wrap="nowrap" style={{ minWidth: 0 }}>
            <Avatar size={46} radius="md" color={stateColor(agent.state)} variant="light">
              {agent.display_name.slice(0, 2).toUpperCase()}
            </Avatar>
            <Box style={{ minWidth: 0 }}>
              <Text fw={700} lineClamp={1}>{agent.display_name}</Text>
              <Text size="xs" c="dimmed" ff="monospace" lineClamp={1}>{agent.id}</Text>
            </Box>
          </Group>
          <Badge color={stateColor(agent.state)} variant="light">{stateLabel(agent.state)}</Badge>
        </Group>

        <Box>
          <Text size="sm" fw={600}>{agent.role || agent.profile.runtime_backend || 'Agent'}</Text>
          <Text size="xs" c="dimmed" mt={3} lineClamp={2}>
            {agent.responsibility || agent.description || 'No operational responsibility declared.'}
          </Text>
        </Box>

        {agent.attention.required && (
          <Alert color="orange" variant="light" icon={<IconAlertTriangle size={16} />} title="Needs operator attention">
            <Text size="xs" lineClamp={2}>
              {agent.attention.summary || agent.attention.reason_code || 'An unresolved condition requires review.'}
            </Text>
          </Alert>
        )}

        <Paper withBorder p="sm" bg="gray.0">
          <Group justify="space-between" align="flex-start" wrap="nowrap">
            <Box style={{ minWidth: 0 }}>
              <Text size="xs" c="dimmed" fw={600}>Current work</Text>
              <Text size="sm" fw={600} mt={3} lineClamp={2}>{task?.title || 'No current task'}</Text>
              {task && (
                <Group gap={6} mt={6}>
                  <Badge size="xs" color={stateColor(task.status.toLowerCase())} variant="light">{stateLabel(task.status)}</Badge>
                  {task.task_type && <Text size="xs" c="dimmed">{task.task_type}</Text>}
                </Group>
              )}
            </Box>
            <ThemeIcon color={task ? 'violet' : 'gray'} variant="light" size={30}>
              <IconActivity size={16} />
            </ThemeIcon>
          </Group>
        </Paper>

        <SimpleGrid cols={2} spacing="sm">
          <Box>
            <Text size="xs" c="dimmed">Runtime</Text>
            <Group gap={5} mt={4}>
              <Badge size="xs" color={stateColor(agent.runtime.status)} variant="light">{stateLabel(agent.runtime.status)}</Badge>
              {agent.runtime.health && <Badge size="xs" color={stateColor(agent.runtime.health)} variant="outline">{stateLabel(agent.runtime.health)}</Badge>}
            </Group>
          </Box>
          <Box>
            <Text size="xs" c="dimmed">Last activity</Text>
            <Text size="sm" fw={500} mt={4}>{relativeTime(agent.last_activity_at)}</Text>
          </Box>
        </SimpleGrid>

        <Box>
          <Text size="xs" c="dimmed">Repositories</Text>
          <Group gap={5} mt={5}>
            {repositories.length ? repositories.slice(0, 2).map((repository) => (
              <Badge key={repository} size="sm" variant="outline" color="gray" leftSection={<IconGitBranch size={11} />}>
                {repository}
              </Badge>
            )) : <Text size="sm" c="dimmed">No repository assigned</Text>}
            {repositories.length > 2 && <Badge size="sm" variant="light" color="gray">+{repositories.length - 2}</Badge>}
          </Group>
        </Box>

        {workspace && (
          <Group gap={6}>
            <Badge size="sm" color="blue" variant="light">workspace {stateLabel(workspace.state)}</Badge>
            {workspace.held_for_investigation && <Badge size="sm" color="orange" variant="light">investigation hold</Badge>}
          </Group>
        )}

        <Group justify="space-between" mt="auto">
          <Group gap={5}>
            <Badge size="sm" variant="dot" color={agent.profile.available ? 'teal' : 'gray'}>profile</Badge>
            <Badge size="sm" variant="dot" color={agent.runtime.available ? 'teal' : 'gray'}>runtime</Badge>
          </Group>
          <Button
            variant="subtle"
            size="compact-sm"
            rightSection={<IconChevronRight size={14} />}
            onClick={() => navigate(`/agents/${encodeURIComponent(agent.id)}`)}
          >
            View details
          </Button>
        </Group>
      </Stack>
    </Card>
  );
}

export function AgentFleetPage() {
  const query = useAgentFleet();
  const [filter, setFilter] = useState<FleetFilter>('all');
  const [search, setSearch] = useState('');
  const fleet = query.data?.fleet || [];

  const workingCount = fleet.filter((agent) => WORKING_STATES.has(agent.state)).length;
  const attentionCount = fleet.filter((agent) => agent.attention.required || agent.state === 'needs_human').length;
  const offlineCount = fleet.filter((agent) => OFFLINE_STATES.has(agent.state)).length;

  const filteredFleet = useMemo(
    () => fleet.filter((agent) => matchesFilter(agent, filter) && matchesSearch(agent, search)),
    [fleet, filter, search],
  );

  const unavailableSources = query.data
    ? Object.entries(query.data.sources)
      .filter(([source, state]) => source !== 'missions' && state === 'unavailable')
      .map(([source]) => source)
    : [];

  if (query.isLoading) {
    return (
      <Stack gap="lg">
        <Skeleton height={74} radius="lg" />
        <SimpleGrid cols={{ base: 1, sm: 2, xl: 4 }}>{Array.from({ length: 4 }).map((_, index) => <Skeleton key={index} height={120} radius="lg" />)}</SimpleGrid>
        <SimpleGrid cols={{ base: 1, md: 2, xl: 3 }}>{Array.from({ length: 6 }).map((_, index) => <Skeleton key={index} height={360} radius="lg" />)}</SimpleGrid>
      </Stack>
    );
  }

  if (query.isError || !query.data) {
    return (
      <Stack gap="lg">
        <Box>
          <Title order={1} className="page-title">Agent Fleet</Title>
          <Text c="dimmed" mt={6}>Operational visibility across all governed agents.</Text>
        </Box>
        <Alert color="red" icon={<IconAlertTriangle size={18} />} title="Agent Fleet unavailable">
          The authenticated fleet contract could not be loaded. No agent controls are available from this page.
        </Alert>
      </Stack>
    );
  }

  return (
    <Stack gap="lg">
      <Group justify="space-between" align="flex-start" wrap="wrap">
        <Box>
          <Group gap="sm">
            <Title order={1} className="page-title">Agent Fleet</Title>
            <Badge variant="light" color="gray">Read only</Badge>
          </Group>
          <Text c="dimmed" mt={6}>Canonical state, current work, runtime health, and operator attention across the multi-agent fleet.</Text>
        </Box>
        <Button variant="default" leftSection={<IconRefresh size={16} />} loading={query.isFetching} onClick={() => query.refetch()}>
          Refresh fleet
        </Button>
      </Group>

      <SimpleGrid cols={{ base: 1, sm: 2, xl: 4 }} spacing="md">
        <FleetMetric label="Registered agents" value={fleet.length} helper="Validated fleet records" icon={<IconUsers size={19} />} color="blue" />
        <FleetMetric label="Working" value={workingCount} helper="Executing or waiting on work" icon={<IconActivity size={19} />} color="violet" />
        <FleetMetric label="Needs attention" value={attentionCount} helper="Operator review required" icon={<IconAlertTriangle size={19} />} color={attentionCount ? 'orange' : 'gray'} />
        <FleetMetric label="Offline or unavailable" value={offlineCount} helper="No healthy operating evidence" icon={<IconServer size={19} />} color={offlineCount ? 'red' : 'teal'} />
      </SimpleGrid>

      {unavailableSources.length > 0 && (
        <Alert color="orange" variant="light" icon={<IconAlertTriangle size={18} />} title="Fleet evidence is degraded">
          Unavailable sources: {unavailableSources.join(', ')}. Cards show only the bounded evidence currently available.
        </Alert>
      )}

      <Paper withBorder p="md">
        <Group justify="space-between" align="flex-end" wrap="wrap">
          <TextInput
            label="Find an agent"
            placeholder="Name, role, repository, or task"
            leftSection={<IconSearch size={16} />}
            value={search}
            onChange={(event) => setSearch(event.currentTarget.value)}
            w={{ base: '100%', sm: 360 }}
          />
          <SegmentedControl
            value={filter}
            onChange={(value) => setFilter(value as FleetFilter)}
            data={[
              { label: `All ${fleet.length}`, value: 'all' },
              { label: `Working ${workingCount}`, value: 'working' },
              { label: `Attention ${attentionCount}`, value: 'attention' },
              { label: `Offline ${offlineCount}`, value: 'offline' },
            ]}
          />
        </Group>
      </Paper>

      {filteredFleet.length ? (
        <SimpleGrid cols={{ base: 1, md: 2, xl: 3 }} spacing="lg">
          {filteredFleet.map((agent) => <FleetCard key={agent.id} agent={agent} />)}
        </SimpleGrid>
      ) : (
        <Paper withBorder p={48}>
          <Stack align="center" gap="sm" ta="center">
            <ThemeIcon size={48} radius="xl" variant="light" color="gray"><IconRobot size={24} /></ThemeIcon>
            <Text fw={600}>No agents match this view</Text>
            <Text size="sm" c="dimmed">Change the state filter or search text to restore fleet results.</Text>
          </Stack>
        </Paper>
      )}
    </Stack>
  );
}
