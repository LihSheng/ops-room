import {
  Alert,
  Badge,
  Box,
  Divider,
  Grid,
  Group,
  Paper,
  Skeleton,
  Stack,
  Text,
  ThemeIcon,
  Title,
} from '@mantine/core';
import { IconActivity, IconAlertTriangle, IconGitBranch } from '@tabler/icons-react';

import type { AgentFleetItem } from '../api/agent-fleet';

function stateColor(status?: string | null) {
  switch (status) {
    case 'idle':
    case 'running':
    case 'healthy':
    case 'active':
      return 'teal';
    case 'working':
      return 'violet';
    case 'waiting':
      return 'blue';
    case 'paused':
      return 'yellow';
    case 'needs_human':
      return 'orange';
    case 'unavailable':
    case 'failed':
    case 'error':
    case 'missing':
    case 'exited':
      return 'red';
    default:
      return 'gray';
  }
}

function StateBadge({ status }: { status?: string | null }) {
  return (
    <Badge color={stateColor(status)} variant="light">
      {String(status || 'unknown').replaceAll('_', ' ')}
    </Badge>
  );
}

function activityLabel(value: string | null) {
  if (!value) return 'No activity recorded';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

export function AgentOperationalSummary({
  fleet,
  loading,
  error,
}: {
  fleet: AgentFleetItem | null;
  loading: boolean;
  error: boolean;
}) {
  if (loading) {
    return (
      <Paper withBorder p="lg">
        <Group mb="md">
          <Skeleton height={28} width={28} radius="xl" />
          <Skeleton height={22} width={180} />
        </Group>
        <Skeleton height={130} />
      </Paper>
    );
  }

  if (error) {
    return (
      <Paper withBorder p="lg">
        <Alert color="red" icon={<IconAlertTriangle size={18} />} title="Fleet summary unavailable">
          Validated profile and runtime sections remain independently available.
        </Alert>
      </Paper>
    );
  }

  if (!fleet) {
    return (
      <Paper withBorder p="lg">
        <Alert color="gray" icon={<IconActivity size={18} />} title="No normalized fleet evidence">
          This agent is not present in the current fleet snapshot.
        </Alert>
      </Paper>
    );
  }

  const task = fleet.current_task;
  const workspace = task?.workspace;
  const repositories: string[] = task?.repository ? [task.repository] : fleet.repositories;

  return (
    <Paper withBorder p="lg">
      <Group justify="space-between" align="flex-start" mb="md">
        <Group gap="sm">
          <ThemeIcon variant="light" color={stateColor(fleet.state)} size={30}>
            <IconActivity size={17} />
          </ThemeIcon>
          <Box>
            <Title order={4}>Operational Summary</Title>
            <Text size="xs" c="dimmed">
              Normalized profile, runtime, lifecycle, and current-work evidence.
            </Text>
          </Box>
        </Group>
        <Badge color={stateColor(fleet.state)} size="lg" variant="light">
          {fleet.state.replaceAll('_', ' ')}
        </Badge>
      </Group>

      {fleet.attention.required && (
        <Alert
          color="orange"
          variant="light"
          mb="md"
          icon={<IconAlertTriangle size={17} />}
          title="Operator attention required"
        >
          {fleet.attention.summary || fleet.attention.reason_code || 'The fleet contract reports an unresolved condition.'}
        </Alert>
      )}

      <Grid gutter="md">
        <Grid.Col span={{ base: 12, sm: 6 }}>
          <Text size="xs" fw={700} c="dimmed">Current work</Text>
          <Text size="sm" fw={600} mt={4}>{task?.title || 'No current task'}</Text>
          <Group gap={6} mt={6}>
            {task ? <StateBadge status={task.status.toLowerCase()} /> : <Badge variant="light" color="gray">idle</Badge>}
            {task?.task_type && <Text size="xs" c="dimmed">{task.task_type}</Text>}
          </Group>
        </Grid.Col>

        <Grid.Col span={{ base: 12, sm: 6 }}>
          <Text size="xs" fw={700} c="dimmed">Runtime</Text>
          <Group gap={6} mt={4}>
            <StateBadge status={fleet.runtime.status} />
            {fleet.runtime.health && <StateBadge status={fleet.runtime.health} />}
          </Group>
          <Text size="xs" c="dimmed" mt={6}>
            {fleet.runtime.restart_count} restart{fleet.runtime.restart_count === 1 ? '' : 's'} · {fleet.profile.runtime_backend || 'backend unknown'}
          </Text>
        </Grid.Col>

        <Grid.Col span={{ base: 12, sm: 6 }}>
          <Text size="xs" fw={700} c="dimmed">Repository</Text>
          {repositories.length ? (
            <Stack gap={2} mt={4}>
              {repositories.slice(0, 3).map((repository) => (
                <Text key={repository} size="sm" ff="monospace">{repository}</Text>
              ))}
            </Stack>
          ) : (
            <Text size="sm" c="dimmed" mt={4}>No repository assigned</Text>
          )}
        </Grid.Col>

        <Grid.Col span={{ base: 12, sm: 6 }}>
          <Text size="xs" fw={700} c="dimmed">Last activity</Text>
          <Text size="sm" fw={600} mt={4}>{activityLabel(fleet.last_activity_at)}</Text>
        </Grid.Col>
      </Grid>

      {workspace && (
        <>
          <Divider my="md" />
          <Group align="flex-start" gap="sm" wrap="nowrap">
            <ThemeIcon variant="light" color={workspace.held_for_investigation ? 'orange' : 'blue'} size={28}>
              <IconGitBranch size={15} />
            </ThemeIcon>
            <Box style={{ flex: 1 }}>
              <Group justify="space-between" align="flex-start">
                <Box>
                  <Text size="sm" fw={600}>Workspace evidence</Text>
                  <Text size="xs" c="dimmed" ff="monospace">{workspace.workspace_id}</Text>
                </Box>
                <StateBadge status={workspace.state} />
              </Group>
              <Group gap="lg" mt="sm">
                <Box><Text size="xs" c="dimmed">Mode</Text><Text size="sm">{workspace.mode || 'unknown'}</Text></Box>
                <Box><Text size="xs" c="dimmed">Branch</Text><Text size="sm" ff="monospace">{workspace.branch || 'detached'}</Text></Box>
                <Box><Text size="xs" c="dimmed">SHA</Text><Text size="sm" ff="monospace">{workspace.resolved_sha?.slice(0, 12) || 'unknown'}</Text></Box>
              </Group>
              {(workspace.held_for_investigation || workspace.cleanup_requested) && (
                <Group gap={6} mt="sm">
                  {workspace.held_for_investigation && <Badge color="orange" variant="light">investigation hold</Badge>}
                  {workspace.cleanup_requested && <Badge color="blue" variant="light">cleanup requested</Badge>}
                </Group>
              )}
            </Box>
          </Group>
        </>
      )}
    </Paper>
  );
}
