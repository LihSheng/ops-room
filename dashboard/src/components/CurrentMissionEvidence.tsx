import {
  Alert,
  Badge,
  Box,
  Code,
  Group,
  Paper,
  SimpleGrid,
  Stack,
  Text,
  ThemeIcon,
} from '@mantine/core';
import { IconAlertTriangle, IconRoute } from '@tabler/icons-react';

import type { AgentFleetMission } from '../api/agent-fleet';

function stateColor(state?: string | null) {
  if (state === 'active' || state === 'completed') return 'teal';
  if (state === 'needs_human') return 'orange';
  if (state === 'paused' || state === 'planned') return 'blue';
  if (state === 'cancelled' || state === 'failed') return 'red';
  return 'gray';
}

function evidenceLabel(value: string) {
  return value.replaceAll('_', ' ');
}

function shortSha(value: string | null) {
  return value ? value.slice(0, 12) : 'unavailable';
}

export function CurrentMissionEvidence({
  mission,
  compact = false,
}: {
  mission: AgentFleetMission | null;
  compact?: boolean;
}) {
  if (!mission) {
    return compact ? (
      <Paper withBorder p="sm" bg="gray.0">
        <Text size="xs" c="dimmed" fw={600}>Current mission</Text>
        <Text size="sm" c="dimmed" mt={3}>No non-terminal mission assigned</Text>
      </Paper>
    ) : (
      <Alert color="gray" variant="light" icon={<IconRoute size={17} />} title="No current mission">
        This agent is not a participant in a planned, active, paused, or needs-human mission.
      </Alert>
    );
  }

  const evidenceDegraded = !['available', 'mission_only'].includes(mission.evidence_status);
  const stageLabel = mission.stage
    ? `${mission.stage.replaceAll('_', ' ')} · ${String(mission.stage_state || 'unknown').replaceAll('_', ' ')}`
    : 'Current workflow stage unavailable';

  if (compact) {
    return (
      <Paper withBorder p="sm" bg={evidenceDegraded ? 'orange.0' : 'violet.0'}>
        <Stack gap={7}>
          <Group justify="space-between" align="flex-start" wrap="nowrap">
            <Box style={{ minWidth: 0 }}>
              <Text size="xs" c="dimmed" fw={600}>Current mission</Text>
              <Text size="sm" fw={700} mt={2} lineClamp={1}>{mission.title}</Text>
            </Box>
            <Badge size="xs" color={stateColor(mission.state)} variant="light">
              {mission.state.replaceAll('_', ' ')}
            </Badge>
          </Group>

          <Group gap={5}>
            {mission.participant_roles.slice(0, 2).map((role) => (
              <Badge key={role} size="xs" variant="outline" color="violet">{role}</Badge>
            ))}
            {mission.current_agent_is_stage_owner && (
              <Badge size="xs" color="teal" variant="light">current stage owner</Badge>
            )}
          </Group>

          <Text size="xs" c="dimmed" lineClamp={1}>
            {stageLabel}{mission.stage_owner ? ` · ${mission.stage_owner}` : ''}
          </Text>

          <Group justify="space-between" gap="xs">
            <Text size="xs" ff="monospace" c="dimmed" lineClamp={1}>
              {mission.repository_id || 'repository unavailable'}
            </Text>
            {mission.additional_mission_count > 0 && (
              <Badge size="xs" variant="light" color="gray">+{mission.additional_mission_count} more</Badge>
            )}
          </Group>

          {evidenceDegraded && (
            <Badge size="xs" color="orange" variant="light" w="fit-content">
              {evidenceLabel(mission.evidence_status)}
            </Badge>
          )}
        </Stack>
      </Paper>
    );
  }

  return (
    <Stack gap="sm">
      <Paper withBorder p="md" bg={evidenceDegraded ? 'orange.0' : 'violet.0'}>
        <Stack gap="md">
          <Group justify="space-between" align="flex-start" wrap="wrap">
            <Group gap="sm" align="flex-start">
              <ThemeIcon variant="light" color={evidenceDegraded ? 'orange' : 'violet'} size={34} radius="md">
                {evidenceDegraded ? <IconAlertTriangle size={18} /> : <IconRoute size={18} />}
              </ThemeIcon>
              <Box>
                <Text size="xs" c="dimmed" fw={700}>Current mission</Text>
                <Text fw={700} mt={2}>{mission.title}</Text>
                <Text size="xs" c="dimmed" ff="monospace" mt={3}>{mission.mission_id}</Text>
              </Box>
            </Group>
            <Group gap={6}>
              <Badge color={stateColor(mission.state)} variant="light">{mission.state.replaceAll('_', ' ')}</Badge>
              <Badge color={mission.current_agent_is_stage_owner ? 'teal' : 'gray'} variant="light">
                {mission.current_agent_is_stage_owner ? 'Current stage owner' : 'Participant'}
              </Badge>
            </Group>
          </Group>

          <Group gap={6}>
            {mission.participant_roles.map((role) => (
              <Badge key={role} size="sm" variant="outline" color="violet">{role}</Badge>
            ))}
            {mission.priority && <Badge size="sm" variant="light" color="blue">{mission.priority} priority</Badge>}
            {mission.additional_mission_count > 0 && (
              <Badge size="sm" variant="light" color="gray">{mission.additional_mission_count} additional mission{mission.additional_mission_count === 1 ? '' : 's'}</Badge>
            )}
          </Group>

          <SimpleGrid cols={{ base: 1, sm: 2, lg: 4 }} spacing="sm">
            <Box>
              <Text size="xs" c="dimmed">Workflow</Text>
              <Text size="sm" fw={600} mt={3}>{mission.workflow_state || 'Unavailable'}</Text>
              <Text size="xs" c="dimmed" ff="monospace" lineClamp={1}>{mission.workflow_id || 'Not bound'}</Text>
            </Box>
            <Box>
              <Text size="xs" c="dimmed">Current stage</Text>
              <Text size="sm" fw={600} mt={3}>{stageLabel}</Text>
              <Text size="xs" c="dimmed">Owner: {mission.stage_owner || 'unavailable'}{mission.iteration ? ` · iteration ${mission.iteration}` : ''}</Text>
            </Box>
            <Box>
              <Text size="xs" c="dimmed">Repository</Text>
              <Text size="sm" fw={600} ff="monospace" mt={3}>{mission.repository_id || 'Unavailable'}</Text>
              <Text size="xs" c="dimmed">{mission.starting_branch || 'branch unavailable'} · <Code>{shortSha(mission.starting_sha)}</Code></Text>
            </Box>
            <Box>
              <Text size="xs" c="dimmed">Evidence</Text>
              <Text size="sm" fw={600} mt={3}>{evidenceLabel(mission.evidence_status)}</Text>
              <Text size="xs" c="dimmed">Mission and workflow remain separate authorities.</Text>
            </Box>
          </SimpleGrid>
        </Stack>
      </Paper>

      {mission.attention_required && (
        <Alert color="orange" variant="light" icon={<IconAlertTriangle size={17} />} title="Mission evidence needs attention">
          {evidenceLabel(mission.attention_reason_code || mission.evidence_status)}. No missing state has been inferred.
        </Alert>
      )}
    </Stack>
  );
}
