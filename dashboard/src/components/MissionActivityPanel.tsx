import {
  Alert,
  Anchor,
  Badge,
  Box,
  Button,
  Code,
  Group,
  Paper,
  SegmentedControl,
  SimpleGrid,
  Stack,
  Text,
  ThemeIcon,
  Timeline,
  Title,
} from '@mantine/core';
import {
  IconActivity,
  IconAlertTriangle,
  IconBolt,
  IconCheck,
  IconGitBranch,
  IconRobot,
  IconRoute,
  IconShieldCheck,
} from '@tabler/icons-react';
import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';

import type {
  MissionActivityCategory,
  MissionActivityEvent,
  MissionActivitySeverity,
  MissionRoom,
} from '../api/missions';

type ActivityFilter = 'all' | 'attention' | 'review' | 'effect' | 'workspace';

function label(value: string | null | undefined) {
  return String(value || 'unavailable').replaceAll('_', ' ');
}

function severityColor(severity: MissionActivitySeverity) {
  if (severity === 'success') return 'teal';
  if (severity === 'warning') return 'yellow';
  if (severity === 'attention') return 'orange';
  if (severity === 'error') return 'red';
  return 'blue';
}

function categoryIcon(category: MissionActivityCategory) {
  if (category === 'workspace') return <IconGitBranch size={15} />;
  if (category === 'effect') return <IconBolt size={15} />;
  if (category === 'stage' || category === 'review') return <IconRobot size={15} />;
  if (category === 'intervention') return <IconAlertTriangle size={15} />;
  if (category === 'mission') return <IconRoute size={15} />;
  return <IconActivity size={15} />;
}

function shortSha(value: string | null) {
  return value ? value.slice(0, 12) : null;
}

function relativeTime(value: string) {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  const seconds = Math.round((parsed.getTime() - Date.now()) / 1000);
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
    if (Math.abs(seconds) >= amount) return formatter.format(Math.round(seconds / amount), unit);
  }
  return formatter.format(seconds, 'second');
}

function matchesFilter(event: MissionActivityEvent, filter: ActivityFilter) {
  if (filter === 'attention') return event.severity === 'attention' || event.severity === 'error';
  if (filter === 'review') return event.category === 'review' || event.event_type.startsWith('review.');
  if (filter === 'effect') return event.source === 'provider_effect';
  if (filter === 'workspace') return event.source === 'workspace';
  return true;
}

function EvidenceLinks({ event }: { event: MissionActivityEvent }) {
  return (
    <Group gap={6} mt="xs">
      {event.links.stage && (
        <Button component={Link} to={event.links.stage} variant="subtle" size="compact-xs" leftSection={<IconRoute size={13} />}>
          Stage evidence
        </Button>
      )}
      {event.links.agent && (
        <Button component={Link} to={event.links.agent} variant="subtle" size="compact-xs" leftSection={<IconRobot size={13} />}>
          {event.owner_agent || 'Agent'}
        </Button>
      )}
      {event.links.workflow && (
        <Button component={Link} to={event.links.workflow} variant="subtle" size="compact-xs" leftSection={<IconActivity size={13} />}>
          Workflow summary
        </Button>
      )}
    </Group>
  );
}

function ActivityEntry({ event }: { event: MissionActivityEvent }) {
  const outputSha = shortSha(event.output_sha);
  const inputSha = shortSha(event.input_sha);
  return (
    <Timeline.Item
      bullet={categoryIcon(event.category)}
      color={severityColor(event.severity)}
      title={(
        <Group justify="space-between" align="flex-start" wrap="wrap" gap="xs">
          <Box>
            <Text size="sm" fw={700}>{event.title}</Text>
            <Text size="xs" c="dimmed">{relativeTime(event.at)} · {event.at}</Text>
          </Box>
          <Group gap={5}>
            <Badge size="xs" variant="light" color={severityColor(event.severity)}>{label(event.severity)}</Badge>
            <Badge size="xs" variant="outline" color="gray">{label(event.category)}</Badge>
          </Group>
        </Group>
      )}
    >
      <Stack gap={5} mt={4}>
        {event.detail && <Text size="sm">{event.detail}</Text>}
        <Group gap={8} wrap="wrap">
          {event.stage_key && <Text size="xs" c="dimmed">Iteration {event.iteration} · {label(event.stage)} · {event.owner_agent}</Text>}
          {event.state && <Badge size="xs" variant="light" color="gray">{label(event.state)}</Badge>}
          {event.attempt != null && <Text size="xs" c="dimmed">Attempt {event.attempt}</Text>}
          {event.reason_code && <Code>{label(event.reason_code)}</Code>}
        </Group>
        {(inputSha || outputSha) && (
          <Group gap={8} wrap="wrap">
            {inputSha && <Text size="xs" c="dimmed">Input <Code>{inputSha}</Code></Text>}
            {outputSha && <Text size="xs" c="dimmed">Output <Code>{outputSha}</Code></Text>}
          </Group>
        )}
        <EvidenceLinks event={event} />
      </Stack>
    </Timeline.Item>
  );
}

export function MissionActivityPanel({ room }: { room: MissionRoom }) {
  const [filter, setFilter] = useState<ActivityFilter>('all');
  const events = useMemo(
    () => room.activity.filter((event) => matchesFilter(event, filter)),
    [filter, room.activity],
  );

  return (
    <Paper withBorder p="lg" id="mission-activity">
      <Stack gap="lg">
        <Group justify="space-between" align="flex-start" wrap="wrap">
          <Group gap="sm" align="flex-start">
            <ThemeIcon variant="light" color="blue" size={40} radius="md"><IconActivity size={21} /></ThemeIcon>
            <Box>
              <Title order={3}>Mission activity</Title>
              <Text size="sm" c="dimmed" mt={3}>
                Correlated from bounded Mission, Workflow, stage, workspace, provider-effect, review, and intervention evidence.
              </Text>
            </Box>
          </Group>
          <SegmentedControl
            value={filter}
            onChange={(value) => setFilter(value as ActivityFilter)}
            data={[
              { label: 'All', value: 'all' },
              { label: 'Attention', value: 'attention' },
              { label: 'Reviews', value: 'review' },
              { label: 'Effects', value: 'effect' },
              { label: 'Workspaces', value: 'workspace' },
            ]}
          />
        </Group>

        <Alert color="blue" variant="light" icon={<IconShieldCheck size={18} />} title="Durable evidence only">
          Events are derived from accepted records and stable timestamps. Missing sources do not produce inferred activity, and duplicate history representations are collapsed deterministically.
        </Alert>

        <SimpleGrid cols={{ base: 2, sm: 3, lg: 6 }} spacing="sm">
          <Box><Text size="xs" c="dimmed">Events</Text><Text fz={24} fw={700}>{room.activity_summary.total}</Text></Box>
          <Box><Text size="xs" c="dimmed">Attention</Text><Text fz={24} fw={700}>{room.activity_summary.attention}</Text></Box>
          <Box><Text size="xs" c="dimmed">Reviews</Text><Text fz={24} fw={700}>{room.activity_summary.reviews}</Text></Box>
          <Box><Text size="xs" c="dimmed">Retries</Text><Text fz={24} fw={700}>{room.activity_summary.retries}</Text></Box>
          <Box><Text size="xs" c="dimmed">Effect events</Text><Text fz={24} fw={700}>{room.activity_summary.effects}</Text></Box>
          <Box><Text size="xs" c="dimmed">Latest</Text><Text size="sm" fw={700} mt={5}>{room.activity_summary.latest_at ? relativeTime(room.activity_summary.latest_at) : 'None'}</Text></Box>
        </SimpleGrid>

        {events.length ? (
          <Timeline bulletSize={30} lineWidth={2} active={events.length}>
            {events.map((event) => <ActivityEntry key={event.event_id} event={event} />)}
          </Timeline>
        ) : (
          <Stack align="center" py="xl" gap="xs">
            <ThemeIcon variant="light" color="gray" size={42} radius="xl"><IconCheck size={20} /></ThemeIcon>
            <Text fw={700}>No matching activity</Text>
            <Text size="sm" c="dimmed">No durable events match the selected filter.</Text>
          </Stack>
        )}

        <Text size="xs" c="dimmed">
          Source identifiers remain bounded. <Anchor component={Link} to="#workflow-summary">View workflow evidence</Anchor>.
        </Text>
      </Stack>
    </Paper>
  );
}
