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
  Title,
} from '@mantine/core';
import { IconAlertTriangle } from '@tabler/icons-react';

import type { MissionRecord, MissionRoom } from '../api/missions';
import { InvestigationControlPanel } from './InvestigationControlPanel';
import { MissionActivityPanel } from './MissionActivityPanel';
import { MissionParticipantChatPanel } from './MissionParticipantChatPanel';
import { MissionRoomTimeline } from './MissionRoomTimeline';
import { WorkflowControlPanel } from './WorkflowControlPanel';

export function missionStateColor(state: MissionRecord['state']) {
  if (state === 'active' || state === 'completed') return 'teal';
  if (state === 'needs_human') return 'orange';
  if (state === 'paused' || state === 'planned') return 'blue';
  if (state === 'cancelled') return 'red';
  return 'gray';
}

export function missionLabel(value: string | null | undefined) {
  return String(value || 'unavailable').replaceAll('_', ' ');
}

function shortSha(value: string | null) {
  return value ? value.slice(0, 12) : 'unavailable';
}

export function MissionRoomContent({ room }: { room: MissionRoom }) {
  return (
    <Stack gap="lg">
      <Paper withBorder p="lg" id="workflow-summary">
        <Group justify="space-between" align="flex-start" wrap="wrap">
          <Box maw={900}>
            <Group gap="sm" align="center">
              <Title order={2}>{room.mission.title}</Title>
              <Badge color={missionStateColor(room.mission.state)} size="lg">
                {missionLabel(room.mission.state)}
              </Badge>
            </Group>
            <Text c="dimmed" mt={6}>{room.mission.objective}</Text>
          </Box>
          <Group gap={6} justify="flex-end">
            {Object.entries(room.sources).map(([source, status]) => (
              <Badge
                key={source}
                variant="light"
                color={status === 'available' ? 'teal' : status === 'not_applicable' ? 'gray' : 'orange'}
              >
                {source}: {missionLabel(status)}
              </Badge>
            ))}
          </Group>
        </Group>

        <Group gap="xl" mt="lg" align="flex-start" wrap="wrap">
          <Box>
            <Text size="xs" c="dimmed">Mission ID</Text>
            <Text size="sm" fw={600} ff="monospace">{room.mission.mission_id}</Text>
          </Box>
          <Box>
            <Text size="xs" c="dimmed">Repository</Text>
            <Text size="sm" fw={600} ff="monospace">{room.mission.repository_id || 'Unavailable'}</Text>
          </Box>
          <Box>
            <Text size="xs" c="dimmed">Starting point</Text>
            <Text size="sm" fw={600}>
              {room.mission.starting_branch || 'Unavailable'} · <Code>{shortSha(room.mission.starting_sha)}</Code>
            </Text>
          </Box>
          <Box>
            <Text size="xs" c="dimmed">Workflow</Text>
            <Text size="sm" fw={600}>{room.workflow ? missionLabel(room.workflow.state) : 'Not bound'}</Text>
            <Text size="xs" c="dimmed" ff="monospace">{room.workflow?.workflow_id || 'No workflow ID'}</Text>
          </Box>
          <Box>
            <Text size="xs" c="dimmed">Participants</Text>
            <Text size="sm" fw={600}>{room.mission.participants.map((participant) => participant.agent_id).join(', ')}</Text>
          </Box>
        </Group>

        <SimpleGrid cols={{ base: 2, sm: 3, lg: 6 }} spacing="sm" mt="lg">
          <Box><Text size="xs" c="dimmed">Activity events</Text><Text fz={22} fw={700}>{room.activity_summary.total}</Text></Box>
          <Box><Text size="xs" c="dimmed">Attention events</Text><Text fz={22} fw={700}>{room.activity_summary.attention}</Text></Box>
          <Box><Text size="xs" c="dimmed">Reviews</Text><Text fz={22} fw={700}>{room.activity_summary.reviews}</Text></Box>
          <Box><Text size="xs" c="dimmed">Retries</Text><Text fz={22} fw={700}>{room.activity_summary.retries}</Text></Box>
          <Box><Text size="xs" c="dimmed">Effect events</Text><Text fz={22} fw={700}>{room.activity_summary.effects}</Text></Box>
          <Box><Text size="xs" c="dimmed">Created stages</Text><Text fz={22} fw={700}>{room.summary.created_stages}</Text></Box>
        </SimpleGrid>
      </Paper>

      {room.summary.attention_required && (
        <Alert color="orange" variant="light" icon={<IconAlertTriangle size={18} />} title="Mission Room needs attention">
          One or more durable authorities report needs-human, conflicting, missing, or degraded evidence. No missing state has been inferred.
        </Alert>
      )}

      <WorkflowControlPanel room={room} />
      <InvestigationControlPanel room={room} />
      <MissionParticipantChatPanel room={room} />
      <MissionActivityPanel room={room} />
      <MissionRoomTimeline room={room} />
    </Stack>
  );
}
