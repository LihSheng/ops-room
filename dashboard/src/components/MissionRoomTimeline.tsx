import {
  Alert,
  Badge,
  Box,
  Code,
  Divider,
  Group,
  Paper,
  SimpleGrid,
  Stack,
  Text,
  ThemeIcon,
  Timeline,
  Title,
  UnstyledButton,
} from '@mantine/core';
import {
  IconAlertTriangle,
  IconBolt,
  IconCheck,
  IconClock,
  IconGitBranch,
  IconRoute,
  IconRobot,
} from '@tabler/icons-react';
import { useEffect, useMemo, useState } from 'react';
import { useLocation } from 'react-router-dom';

import type { MissionRoom, MissionRoomStage } from '../api/missions';

function label(value: string | null | undefined) {
  return String(value || 'unavailable').replaceAll('_', ' ');
}

function shortSha(value: string | null) {
  return value ? value.slice(0, 12) : 'unavailable';
}

function duration(value: number | null) {
  if (value == null) return 'Not complete';
  if (value < 60) return `${value}s`;
  const minutes = Math.floor(value / 60);
  const seconds = value % 60;
  if (minutes < 60) return `${minutes}m ${seconds}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

function stateColor(state: string) {
  if (state === 'completed') return 'teal';
  if (state === 'active') return 'violet';
  if (state === 'pending') return 'blue';
  if (state === 'needs_human' || state === 'failed') return 'orange';
  if (state === 'cancelled') return 'red';
  return 'gray';
}

function verificationColor(status: string) {
  if (status === 'verified') return 'teal';
  if (status === 'attention') return 'orange';
  if (status === 'degraded' || status === 'unavailable') return 'yellow';
  if (status === 'in_progress') return 'violet';
  if (status === 'pending') return 'blue';
  return 'gray';
}

function stageAnchor(stage: MissionRoomStage) {
  return `stage-${stage.iteration}-${stage.stage}`;
}

function stageKeyFromHash(hash: string) {
  const match = hash.match(/^#stage-(\d+)-(implementation|test|integration|review)$/);
  return match ? `${Number(match[1])}:${match[2]}` : null;
}

function StageDetail({ stage }: { stage: MissionRoomStage }) {
  return (
    <Paper withBorder p="lg" id="stage-detail">
      <Stack gap="md">
        <Group justify="space-between" align="flex-start" wrap="wrap">
          <Group gap="sm">
            <ThemeIcon variant="light" color={stateColor(stage.state)} size={38} radius="md">
              <IconRobot size={20} />
            </ThemeIcon>
            <Box>
              <Text size="xs" c="dimmed" fw={700}>Iteration {stage.iteration}</Text>
              <Title order={4}>{label(stage.stage)}</Title>
              <Text size="sm" c="dimmed">Owner: {stage.owner_agent}</Text>
            </Box>
          </Group>
          <Group gap={6}>
            <Badge color={stateColor(stage.state)} variant="light">{label(stage.state)}</Badge>
            <Badge color={verificationColor(stage.verification.status)} variant="light">
              {label(stage.verification.status)}
            </Badge>
          </Group>
        </Group>

        {stage.verification.reason && (
          <Alert color={verificationColor(stage.verification.status)} variant="light" icon={<IconAlertTriangle size={17} />} title="Evidence result">
            {label(stage.verification.reason)}
          </Alert>
        )}

        <SimpleGrid cols={{ base: 1, sm: 2, lg: 4 }} spacing="sm">
          <Box><Text size="xs" c="dimmed">Input SHA</Text><Code mt={4}>{shortSha(stage.input_sha)}</Code></Box>
          <Box><Text size="xs" c="dimmed">Output SHA</Text><Code mt={4}>{shortSha(stage.output_sha)}</Code></Box>
          <Box><Text size="xs" c="dimmed">Attempt</Text><Text size="sm" fw={600} mt={4}>{stage.attempt || 0} · {stage.retry_count} retries</Text></Box>
          <Box><Text size="xs" c="dimmed">Duration</Text><Text size="sm" fw={600} mt={4}>{duration(stage.duration_seconds)}</Text></Box>
        </SimpleGrid>

        <Divider />

        <SimpleGrid cols={{ base: 1, md: 2 }} spacing="md">
          <Paper withBorder p="md" bg="gray.0">
            <Group gap="sm" mb="sm">
              <ThemeIcon variant="light" color={stage.workspace?.held_for_investigation ? 'orange' : 'blue'} size={30}>
                <IconGitBranch size={16} />
              </ThemeIcon>
              <Box><Text size="sm" fw={700}>Workspace evidence</Text><Text size="xs" c="dimmed">{label(stage.evidence.workspace)}</Text></Box>
            </Group>
            {stage.workspace ? (
              <Stack gap={5}>
                <Text size="sm" ff="monospace">{stage.workspace.workspace_id}</Text>
                <Text size="xs" c="dimmed">{stage.workspace.mode || 'mode unavailable'} · {label(stage.workspace.state)}</Text>
                <Text size="xs" c="dimmed">Branch: {stage.workspace.branch || 'detached or unavailable'}</Text>
                <Text size="xs" c="dimmed">HEAD: {shortSha(stage.workspace.resolved_sha)}</Text>
                <Group gap={5}>
                  {stage.workspace.held_for_investigation && <Badge size="xs" color="orange">investigation hold</Badge>}
                  {stage.workspace.cleanup_requested && <Badge size="xs" color="blue">cleanup requested</Badge>}
                  {stage.workspace.unavailable && <Badge size="xs" color="orange">unavailable</Badge>}
                </Group>
              </Stack>
            ) : <Text size="sm" c="dimmed">No durable workspace evidence is available for this stage.</Text>}
          </Paper>

          <Paper withBorder p="md" bg="gray.0">
            <Group gap="sm" mb="sm">
              <ThemeIcon variant="light" color={stage.provider_effect?.state === 'completed' ? 'teal' : 'orange'} size={30}>
                <IconBolt size={16} />
              </ThemeIcon>
              <Box><Text size="sm" fw={700}>Provider-effect evidence</Text><Text size="xs" c="dimmed">{label(stage.evidence.provider_effect)}</Text></Box>
            </Group>
            {stage.provider_effect ? (
              <Stack gap={5}>
                <Text size="sm" ff="monospace">{stage.provider_effect.effect_id}</Text>
                <Text size="xs" c="dimmed">{stage.provider_effect.effect_type || 'type unavailable'} · {label(stage.provider_effect.state)}</Text>
                <Text size="xs" c="dimmed">Result: {label(stage.provider_effect.result_code)}</Text>
                <Text size="xs" c="dimmed">Output: {shortSha(stage.provider_effect.output_sha)}</Text>
                {stage.provider_effect_count > 1 && <Badge size="xs" variant="light" color="gray" w="fit-content">{stage.provider_effect_count} effect records</Badge>}
              </Stack>
            ) : <Text size="sm" c="dimmed">No durable provider effect is available. No external success has been inferred.</Text>}
          </Paper>
        </SimpleGrid>

        {(stage.review_decision || stage.last_error) && (
          <Alert
            color={stage.review_decision === 'approved' ? 'teal' : 'orange'}
            variant="light"
            title={stage.review_decision ? `Review: ${label(stage.review_decision)}` : 'Bounded failure reason'}
          >
            {label(stage.review_reason || stage.last_error)}
          </Alert>
        )}

        {stage.retry_history.length > 0 && (
          <Box>
            <Text size="sm" fw={700} mb={6}>Bounded stage history</Text>
            <Stack gap={4}>
              {stage.retry_history.map((entry, index) => (
                <Group key={`${entry.event}:${entry.at}:${index}`} justify="space-between" wrap="nowrap">
                  <Text size="xs">
                    {entry.from || entry.to ? `${label(entry.from || 'new')} → ${label(entry.to || stage.state)}` : label(entry.event)}
                    {entry.reason ? ` · ${label(entry.reason)}` : ''}
                  </Text>
                  <Text size="xs" c="dimmed">{entry.at || 'time unavailable'}</Text>
                </Group>
              ))}
            </Stack>
          </Box>
        )}
      </Stack>
    </Paper>
  );
}

export function MissionRoomTimeline({ room }: { room: MissionRoom }) {
  const location = useLocation();
  const initialKey = stageKeyFromHash(location.hash) || room.summary.current_stage_key || room.timeline[0]?.key || null;
  const [selectedKey, setSelectedKey] = useState<string | null>(initialKey);
  const selected = useMemo(
    () => room.timeline.find((stage) => stage.key === selectedKey) || room.timeline[0] || null,
    [room.timeline, selectedKey],
  );
  const iterations = useMemo(
    () => Array.from(new Set(room.timeline.map((stage) => stage.iteration))),
    [room.timeline],
  );

  useEffect(() => {
    const key = stageKeyFromHash(location.hash);
    if (!key || !room.timeline.some((stage) => stage.key === key)) return;
    setSelectedKey(key);
    const targetId = location.hash.slice(1);
    const timer = window.setTimeout(() => {
      document.getElementById(targetId)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }, 0);
    return () => window.clearTimeout(timer);
  }, [location.hash, room.timeline]);

  return (
    <Stack gap="lg" id="workflow-timeline">
      <Group justify="space-between" align="flex-start" wrap="wrap">
        <Group gap="sm">
          <ThemeIcon variant="light" color="violet" size={40} radius="md"><IconRoute size={22} /></ThemeIcon>
          <Box><Title order={3}>Deterministic workflow timeline</Title><Text size="sm" c="dimmed">Professor → Tokyo → Professor → Berlin, using durable workflow evidence only.</Text></Box>
        </Group>
        <Group gap={6}>
          <Badge variant="light" color="violet">{room.summary.iterations} iteration{room.summary.iterations === 1 ? '' : 's'}</Badge>
          <Badge variant="light" color="teal">{room.summary.completed_stages} completed</Badge>
          {room.summary.degraded_stages > 0 && <Badge variant="light" color="yellow">{room.summary.degraded_stages} degraded</Badge>}
          {room.summary.attention_stages > 0 && <Badge variant="light" color="orange">{room.summary.attention_stages} attention</Badge>}
        </Group>
      </Group>

      {iterations.map((iteration) => {
        const stages = room.timeline.filter((stage) => stage.iteration === iteration);
        const activeIndex = Math.max(0, stages.findIndex((stage) => ['pending', 'active', 'needs_human', 'failed'].includes(stage.state)));
        return (
          <Paper key={iteration} withBorder p="lg">
            <Text size="xs" fw={700} c="dimmed" mb="md">ITERATION {iteration}</Text>
            <Timeline active={activeIndex} bulletSize={30} lineWidth={2}>
              {stages.map((stage) => (
                <Timeline.Item
                  id={stageAnchor(stage)}
                  key={stage.key}
                  bullet={stage.state === 'completed' ? <IconCheck size={15} /> : stage.state === 'not_created' ? <IconClock size={15} /> : <IconRobot size={15} />}
                  color={stateColor(stage.state)}
                  title={(
                    <UnstyledButton onClick={() => setSelectedKey(stage.key)} w="100%">
                      <Group justify="space-between" align="flex-start" wrap="wrap">
                        <Box><Text fw={700}>{label(stage.stage)}</Text><Text size="xs" c="dimmed">{stage.owner_agent} · attempt {stage.attempt || 0}</Text></Box>
                        <Group gap={5}><Badge size="xs" color={stateColor(stage.state)}>{label(stage.state)}</Badge><Badge size="xs" color={verificationColor(stage.verification.status)} variant="light">{label(stage.verification.status)}</Badge></Group>
                      </Group>
                    </UnstyledButton>
                  )}
                >
                  <Text size="xs" c="dimmed">Input {shortSha(stage.input_sha)} → Output {shortSha(stage.output_sha)}</Text>
                </Timeline.Item>
              ))}
            </Timeline>
          </Paper>
        );
      })}

      {selected && <StageDetail stage={selected} />}
    </Stack>
  );
}
