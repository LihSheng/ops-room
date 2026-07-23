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
  Text,
  TextInput,
  ThemeIcon,
  Timeline,
  Title,
} from '@mantine/core';
import { useQuery } from '@tanstack/react-query';
import {
  IconAlertTriangle,
  IconBolt,
  IconBrandGithub,
  IconGitBranch,
  IconMessageCircle2,
  IconRefresh,
  IconRobot,
  IconRoute,
  IconSearch,
  IconShieldCheck,
} from '@tabler/icons-react';
import { useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';

import {
  interventionsApi,
  type InterventionCategory,
  type InterventionItem,
  type InterventionSeverity,
  type RetryAssessment,
} from '../api/interventions';
import { ChatInterventionPanel } from '../components/ChatInterventionPanel';
import { TaskControlDesk } from '../components/TaskControlDesk';
import { WorkflowControlDesk } from '../components/WorkflowControlDesk';
import { ChatSessionsPage } from './ChatSessionsPage';

type InboxFilter = 'all' | 'errors' | 'blocked' | 'unknown' | 'effects';
type InterventionWorkspaceView = 'inbox' | 'chat';

function label(value: string | null | undefined) {
  return String(value || 'unavailable').replaceAll('_', ' ');
}

function severityColor(severity: InterventionSeverity) {
  if (severity === 'error') return 'red';
  if (severity === 'attention') return 'orange';
  return 'yellow';
}

function retryColor(assessment: RetryAssessment) {
  if (assessment === 'safe') return 'teal';
  if (assessment === 'blocked' || assessment === 'unsafe') return 'red';
  if (assessment === 'unknown') return 'orange';
  return 'gray';
}

function categoryIcon(category: InterventionCategory) {
  if (category === 'agent') return <IconRobot size={15} />;
  if (category === 'workspace') return <IconGitBranch size={15} />;
  if (category === 'effect') return <IconBolt size={15} />;
  if (category === 'mission' || category === 'workflow' || category === 'stage') return <IconRoute size={15} />;
  if (category === 'review') return <IconBrandGithub size={15} />;
  return <IconAlertTriangle size={15} />;
}

function matchesFilter(item: InterventionItem, filter: InboxFilter) {
  if (filter === 'errors') return item.severity === 'error';
  if (filter === 'blocked') return item.retry.assessment === 'blocked' || item.retry.assessment === 'unsafe';
  if (filter === 'unknown') return item.retry.assessment === 'unknown';
  if (filter === 'effects') return item.category === 'effect' || item.external_effect.assessment === 'possible';
  return true;
}

function matchesSearch(item: InterventionItem, search: string) {
  const normalized = search.trim().toLowerCase();
  if (!normalized) return true;
  return [
    item.title,
    item.what_happened,
    item.problem_code,
    item.mission_title,
    item.mission_id,
    item.workflow_id,
    item.agent_id,
    item.task_id,
    item.workspace_id,
    item.repository_id,
    item.recommended_response,
  ].some((value) => String(value || '').toLowerCase().includes(normalized));
}

function relativeTime(value: string | null) {
  if (!value) return 'time unavailable';
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  const seconds = Math.round((parsed.getTime() - Date.now()) / 1000);
  const formatter = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
  const ranges: Array<[Intl.RelativeTimeFormatUnit, number]> = [
    ['day', 86_400],
    ['hour', 3_600],
    ['minute', 60],
  ];
  for (const [unit, amount] of ranges) {
    if (Math.abs(seconds) >= amount) return formatter.format(Math.round(seconds / amount), unit);
  }
  return formatter.format(seconds, 'second');
}

function Metric({ label: metricLabel, value, helper, color }: { label: string; value: number; helper: string; color: string }) {
  return (
    <Paper withBorder p="md">
      <Text size="xs" c="dimmed" fw={700}>{metricLabel}</Text>
      <Text fz={28} fw={700} mt={3} c={color}>{value}</Text>
      <Text size="xs" c="dimmed" mt={3}>{helper}</Text>
    </Paper>
  );
}

function SourceHealth({ sources }: { sources: Record<string, string> }) {
  return (
    <Group gap={5} wrap="wrap">
      {Object.entries(sources).map(([source, state]) => (
        <Badge
          key={source}
          variant="light"
          color={state === 'available' ? 'teal' : state === 'not_applicable' ? 'gray' : 'orange'}
        >
          {label(source)}: {label(state)}
        </Badge>
      ))}
    </Group>
  );
}

function EvidenceLinks({ item }: { item: InterventionItem }) {
  return (
    <Group gap={6} mt="xs" wrap="wrap">
      {item.links.stage && <Button component={Link} to={item.links.stage} variant="subtle" size="compact-xs">Stage evidence</Button>}
      {!item.links.stage && item.links.mission && <Button component={Link} to={item.links.mission} variant="subtle" size="compact-xs">Mission Room</Button>}
      {item.links.agent && <Button component={Link} to={item.links.agent} variant="subtle" size="compact-xs">Agent Detail</Button>}
      {item.links.tasks && <Button component={Link} to={item.links.tasks} variant="subtle" size="compact-xs">Tasks</Button>}
      {item.links.workflow && <Button component={Link} to={item.links.workflow} variant="subtle" size="compact-xs">Workflows</Button>}
    </Group>
  );
}

function InterventionEntry({ item }: { item: InterventionItem }) {
  return (
    <Timeline.Item
      bullet={categoryIcon(item.category)}
      color={severityColor(item.severity)}
      title={(
        <Group justify="space-between" align="flex-start" wrap="wrap" gap="xs">
          <Box maw={860}>
            <Text fw={700}>{item.title}</Text>
            <Text size="xs" c="dimmed">{relativeTime(item.occurred_at)}{item.occurred_at ? ` · ${item.occurred_at}` : ''}</Text>
          </Box>
          <Group gap={5}>
            <Badge color={severityColor(item.severity)} variant="light">{label(item.severity)}</Badge>
            <Badge color="gray" variant="outline">{label(item.category)}</Badge>
          </Group>
        </Group>
      )}
    >
      <Paper withBorder p="md" mt="xs">
        <Stack gap="md">
          <Text size="sm">{item.what_happened}</Text>

          <Group gap={8} wrap="wrap">
            {item.problem_code && <Code>{label(item.problem_code)}</Code>}
            {item.mission_title && <Badge variant="light" color="violet">{item.mission_title}</Badge>}
            {item.agent_id && <Badge variant="outline" color="blue">{item.agent_id}</Badge>}
            {item.repository_id && <Text size="xs" c="dimmed" ff="monospace">{item.repository_id}</Text>}
          </Group>

          <SimpleGrid cols={{ base: 1, md: 2 }} spacing="sm">
            <Paper withBorder p="sm" bg="gray.0">
              <Text size="xs" c="dimmed" fw={700}>Could an external effect have occurred?</Text>
              <Badge mt={6} color={item.external_effect.assessment === 'possible' ? 'orange' : item.external_effect.assessment === 'completed' ? 'teal' : 'gray'} variant="light">
                {label(item.external_effect.assessment)}
              </Badge>
              <Text size="sm" mt={6}>{item.external_effect.explanation}</Text>
            </Paper>
            <Paper withBorder p="sm" bg="gray.0">
              <Text size="xs" c="dimmed" fw={700}>Retry assessment</Text>
              <Badge mt={6} color={retryColor(item.retry.assessment)} variant="light">{label(item.retry.assessment)}</Badge>
              <Text size="sm" mt={6}>{item.retry.reason}</Text>
            </Paper>
          </SimpleGrid>

          {item.blocked_reason && (
            <Alert color="orange" variant="light" icon={<IconAlertTriangle size={17} />} title="Why action is blocked">
              {item.blocked_reason}
            </Alert>
          )}

          <Box>
            <Text size="xs" c="dimmed" fw={700}>Recommended operator response</Text>
            <Text size="sm" mt={4} fw={600}>{item.recommended_response}</Text>
          </Box>

          <EvidenceLinks item={item} />
        </Stack>
      </Paper>
    </Timeline.Item>
  );
}

function InterventionInboxView() {
  const [filter, setFilter] = useState<InboxFilter>('all');
  const [search, setSearch] = useState('');
  const query = useQuery({
    queryKey: ['interventions'],
    queryFn: interventionsApi.list,
    refetchInterval: 15_000,
  });
  const visible = useMemo(
    () => (query.data?.interventions || []).filter((item) => matchesFilter(item, filter) && matchesSearch(item, search)),
    [filter, query.data?.interventions, search],
  );

  return (
    <Stack gap="lg">
      <Group justify="space-between" align="flex-start" wrap="wrap">
        <Group gap="sm" align="flex-start">
          <ThemeIcon variant="light" color="orange" size={44} radius="md"><IconAlertTriangle size={24} /></ThemeIcon>
          <Box>
            <Title order={1} className="page-title">Needs Human</Title>
            <Text c="dimmed" mt={4}>Durable intervention evidence and governed operator controls for accepted recovery paths.</Text>
          </Box>
        </Group>
        <Button variant="default" leftSection={<IconRefresh size={16} />} loading={query.isFetching} onClick={() => query.refetch()}>
          Refresh evidence
        </Button>
      </Group>

      <Alert color="blue" variant="light" icon={<IconShieldCheck size={18} />} title="Governed task, workflow, effect, workspace, and chat evidence">
        Review-task controls, exact Workflow recovery and Berlin decisions, explicit effect resolution, workspace investigation, and bounded chat-session attention evidence use authenticated server contracts. Provider replay and physical workspace deletion remain unavailable.
      </Alert>

      <TaskControlDesk />
      <WorkflowControlDesk />
      <ChatInterventionPanel />

      {query.isLoading ? (
        <Stack gap="md"><Skeleton height={110} /><Skeleton height={420} /></Stack>
      ) : query.isError || !query.data ? (
        <Alert color="red" icon={<IconAlertTriangle size={18} />} title="Intervention evidence unavailable">
          The accepted authenticated read contracts could not be composed. Mutation controls remain independently server-authorized.
        </Alert>
      ) : (
        <>
          <SimpleGrid cols={{ base: 2, lg: 4 }} spacing="md">
            <Metric label="Open items" value={query.data.summary.total} helper="Durable conditions requiring review" color="orange" />
            <Metric label="Errors" value={query.data.summary.errors} helper="Highest-severity evidence" color="red" />
            <Metric label="Retry blocked" value={query.data.summary.blocked} helper="Unsafe or unresolved effect boundary" color="red" />
            <Metric label="Retry unknown" value={query.data.summary.unknown_retry} helper="Evidence is insufficient for a safe decision" color="orange" />
          </SimpleGrid>

          <Paper withBorder p="lg">
            <Stack gap="md">
              <Group justify="space-between" align="flex-end" wrap="wrap">
                <TextInput
                  label="Search intervention evidence"
                  placeholder="Mission, agent, task, workspace, code..."
                  leftSection={<IconSearch size={16} />}
                  value={search}
                  onChange={(event) => setSearch(event.currentTarget.value)}
                  style={{ flex: 1, minWidth: 280 }}
                />
                <SegmentedControl
                  value={filter}
                  onChange={(value) => setFilter(value as InboxFilter)}
                  data={[
                    { label: 'All', value: 'all' },
                    { label: 'Errors', value: 'errors' },
                    { label: 'Blocked', value: 'blocked' },
                    { label: 'Unknown', value: 'unknown' },
                    { label: 'Effects', value: 'effects' },
                  ]}
                />
              </Group>
              <SourceHealth sources={query.data.sources} />
            </Stack>
          </Paper>

          {visible.length ? (
            <Timeline bulletSize={30} lineWidth={2} active={visible.length}>
              {visible.map((item) => <InterventionEntry key={item.intervention_id} item={item} />)}
            </Timeline>
          ) : (
            <Paper withBorder p="xl">
              <Stack align="center" gap="xs" ta="center">
                <ThemeIcon size={44} radius="xl" variant="light" color="teal"><IconShieldCheck size={22} /></ThemeIcon>
                <Text fw={700}>No intervention items match this view</Text>
                <Text size="sm" c="dimmed">Adjust the filters, or continue operating from the Mission Room and Agent Fleet.</Text>
              </Stack>
            </Paper>
          )}
        </>
      )}
    </Stack>
  );
}

export function InterventionsPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const view = searchParams.get('view') === 'chat' ? 'chat' : 'inbox';
  const setView = (next: InterventionWorkspaceView) => {
    const updated = new URLSearchParams(searchParams);
    if (next === 'chat') updated.set('view', 'chat');
    else {
      updated.delete('view');
      updated.delete('session');
    }
    setSearchParams(updated);
  };

  return (
    <Stack gap="lg">
      <Paper withBorder p="xs" style={{ alignSelf: 'flex-start' }}>
        <SegmentedControl
          value={view}
          onChange={(value) => setView(value as InterventionWorkspaceView)}
          data={[
            { label: 'Needs Human', value: 'inbox' },
            { label: 'Chat Sessions', value: 'chat' },
          ]}
          leftSection={view === 'chat' ? <IconMessageCircle2 size={15} /> : undefined}
        />
      </Paper>
      {view === 'chat' ? <ChatSessionsPage /> : <InterventionInboxView />}
    </Stack>
  );
}
