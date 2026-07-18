import {
  ActionIcon,
  Alert,
  AppShell,
  Avatar,
  Badge,
  Box,
  Burger,
  Button,
  Card,
  Center,
  Code,
  Divider,
  Drawer,
  Grid,
  Group,
  Indicator,
  Loader,
  Modal,
  NavLink,
  Paper,
  Progress,
  ScrollArea,
  SegmentedControl,
  SimpleGrid,
  Skeleton,
  Stack,
  Table,
  Text,
  ThemeIcon,
  Title,
  Tooltip,
  UnstyledButton,
} from '@mantine/core';
import { useDisclosure } from '@mantine/hooks';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  IconActivity,
  IconAlertTriangle,
  IconBook2,
  IconBrandGithub,
  IconCheck,
  IconChevronRight,
  IconCode,
  IconDashboard,
  IconDatabase,
  IconFileText,
  IconGitPullRequest,
  IconListCheck,
  IconRefresh,
  IconRobot,
  IconRoute,
  IconServer,
  IconSettings,
  IconSparkles,
  IconTerminal2,
  IconUsers,
} from '@tabler/icons-react';
import { useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { Navigate, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { opsApi } from './api';
import { useAgentProfiles } from './hooks/use-agent-profiles';
import { joinProfileRuntime } from './lib/join-profile-runtime';
import { ActivityPage, SettingsPage, WorkflowsPage } from './operational-pages';
import { AgentDetailPage } from './pages/AgentDetailPage';
import { SkillsPage } from './pages/SkillsPage';
import { MemorySpacesPage } from './pages/MemorySpacesPage';
import type { AgentInstance, OpsTask } from './types';
import type { PublicAgentProfile } from './api/agent-profiles';

const ACTIVE_STATES = new Set([
  'PENDING', 'QUEUED', 'CLAIMED', 'RUNNING', 'IN_PROGRESS', 'REVIEWING', 'FIX_QUEUED', 'FIXING', 'CANCELLING',
]);
const ATTENTION_STATES = new Set([
  'ERROR', 'FAILED', 'CHANGES_REQUESTED', 'NEEDS_HUMAN', 'BLOCKED', 'CANCELLED', 'STALE',
]);
const SUCCESS_STATES = new Set(['PASSED', 'SUCCESS', 'COMPLETED', 'DONE', 'FIX_PUSHED', 'APPROVED']);

function normalizeState(task: OpsTask): string {
  return String(task.status || task.state || 'UNKNOWN').toUpperCase();
}

function taskId(task: OpsTask): string {
  return String(task.task_id || task.id || task.file || `${task.agent}-${task.received_at}`);
}

function taskTitle(task: OpsTask): string {
  return String(task.issue_title || task.task_text || task.task || taskId(task) || 'Untitled task');
}

function taskTimestamp(task: OpsTask): string | undefined {
  return task.updated_at || task.received_at || task.created_at || task.completed_at;
}

function relativeTime(value?: string): string {
  if (!value) return 'Unknown time';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  const seconds = Math.round((date.getTime() - Date.now()) / 1000);
  const formatter = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
  const ranges: Array<[Intl.RelativeTimeFormatUnit, number]> = [
    ['year', 31_536_000], ['month', 2_592_000], ['week', 604_800], ['day', 86_400], ['hour', 3_600], ['minute', 60],
  ];
  for (const [unit, amount] of ranges) {
    if (Math.abs(seconds) >= amount) return formatter.format(Math.round(seconds / amount), unit);
  }
  return formatter.format(seconds, 'second');
}

function duration(seconds?: number): string {
  if (!seconds) return '0m';
  const days = Math.floor(seconds / 86_400);
  const hours = Math.floor((seconds % 86_400) / 3_600);
  const minutes = Math.floor((seconds % 3_600) / 60);
  if (days) return `${days}d ${hours}h`;
  if (hours) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

function statusColor(status?: string): string {
  const value = String(status || 'unknown').toUpperCase();
  if (SUCCESS_STATES.has(value) || value === 'RUNNING' || value === 'HEALTHY') return 'teal';
  if (ATTENTION_STATES.has(value) || value === 'UNHEALTHY' || value === 'RESTARTING') return value === 'ERROR' || value === 'FAILED' ? 'red' : 'orange';
  if (ACTIVE_STATES.has(value)) return 'violet';
  return 'gray';
}

function StatusBadge({ status }: { status?: string }) {
  const label = String(status || 'unknown').replaceAll('_', ' ').toLowerCase();
  return <Badge color={statusColor(status)} variant="light">{label}</Badge>;
}

function EmptyState({ icon, title, description }: { icon: ReactNode; title: string; description: string }) {
  return (
    <Center py={48}>
      <Stack align="center" gap={8} maw={360} ta="center">
        <ThemeIcon size={44} radius="xl" variant="light" color="gray">{icon}</ThemeIcon>
        <Text fw={600}>{title}</Text>
        <Text size="sm" c="dimmed">{description}</Text>
      </Stack>
    </Center>
  );
}

function SectionHeading({ title, description, action }: { title: string; description?: string; action?: ReactNode }) {
  return (
    <Group justify="space-between" align="flex-end" mb="md">
      <Box>
        <Title order={3}>{title}</Title>
        {description && <Text size="sm" c="dimmed" mt={3}>{description}</Text>}
      </Box>
      {action}
    </Group>
  );
}

function MetricCard({ label, value, helper, icon, color = 'violet', progress }: {
  label: string; value: string | number; helper: string; icon: ReactNode; color?: string; progress?: number;
}) {
  return (
    <Paper withBorder p="lg" className="metric-card">
      <Group justify="space-between" align="flex-start">
        <Box>
          <Text size="sm" c="dimmed">{label}</Text>
          <Text fz={30} fw={700} lh={1.2} mt={6}>{value}</Text>
        </Box>
        <ThemeIcon variant="light" color={color} size={38} radius="md">{icon}</ThemeIcon>
      </Group>
      <Text size="xs" c="dimmed" mt="md">{helper}</Text>
      {progress !== undefined && <Progress value={progress} color={color} mt="sm" size="sm" radius="xl" />}
    </Paper>
  );
}

interface DashboardData {
  health: Awaited<ReturnType<typeof opsApi.health>>;
  instances: Awaited<ReturnType<typeof opsApi.instances>>;
  tasks: Awaited<ReturnType<typeof opsApi.tasks>>;
}

export function useDashboardData() {
  return useQuery({
    queryKey: ['ops-dashboard'],
    queryFn: async (): Promise<DashboardData> => {
      const [health, tasks] = await Promise.all([
        opsApi.health(), opsApi.tasks(),
      ]);
      // Instances are fetched independently so health/tasks failures don't
      // collapse the fleet table or the command center.
      let instances: Awaited<ReturnType<typeof opsApi.instances>> = { instances: [] };
      try {
        instances = await opsApi.instances();
      } catch {
        // Silently degrade — fleet table uses its own standalone query.
      }
      return { health, instances, tasks };
    },
    refetchInterval: 10_000,
  });
}

function DashboardPage({ openAgent, openLogs }: {
  openAgent: (agent: AgentInstance) => void;
  openLogs: (agent: AgentInstance) => void;
}) {
  const query = useDashboardData();
  const profilesQuery = useAgentProfiles();
  const fleetInstancesQuery = useQuery({
    queryKey: ['openab-instances'],
    queryFn: () => opsApi.instances(),
    refetchInterval: 10_000,
  });
  const navigate = useNavigate();
  const data = query.data;
  const fleetAgents = fleetInstancesQuery.data?.instances || [];
  const profiles = profilesQuery.data?.profiles || [];
  const tasks = data?.tasks.tasks || [];
  const activeTasks = tasks.filter((task) => ACTIVE_STATES.has(normalizeState(task)));
  const attentionTasks = tasks.filter((task) => ATTENTION_STATES.has(normalizeState(task)));
  const runningAgents = fleetAgents.filter((agent) => String(agent.runtime?.status).toLowerCase() === 'running');
  const capacity = fleetAgents.length ? Math.round((runningAgents.length / fleetAgents.length) * 100) : 0;

  if (query.isLoading) {
    return <Stack gap="lg">{Array.from({ length: 4 }).map((_, index) => <Skeleton key={index} height={120} radius="lg" />)}</Stack>;
  }

  if (query.isError || !data) {
    return <Alert color="red" title="Dashboard unavailable" icon={<IconAlertTriangle size={18} />}>The Ops Room APIs could not be loaded. Check the server logs and API routes.</Alert>;
  }

  return (
    <Stack gap={28}>
      <Box>
        <Group justify="space-between" align="flex-start" wrap="nowrap">
          <Box>
            <Title order={1} className="page-title">Command center</Title>
            <Text c="dimmed" mt={6}>Monitor agent capacity, active work, review loops, and operator intervention.</Text>
          </Box>
          <Button variant="default" leftSection={<IconRefresh size={16} />} loading={query.isFetching} onClick={() => query.refetch()}>Refresh</Button>
        </Group>
      </Box>

      <SimpleGrid cols={{ base: 1, sm: 2, xl: 4 }} spacing="md">
        <MetricCard label="Fleet online" value={`${runningAgents.length}/${fleetAgents.length}`} helper={`${capacity}% runtime capacity available`} icon={<IconRobot size={20} />} color="teal" progress={capacity} />
        <MetricCard label="Active work" value={activeTasks.length} helper="Tasks currently queued or executing" icon={<IconActivity size={20} />} />
        <MetricCard label="Needs attention" value={attentionTasks.length} helper="Human decisions, failed runs, or requested changes" icon={<IconAlertTriangle size={20} />} color={attentionTasks.length ? 'orange' : 'gray'} />
        <MetricCard label="Control plane" value={data.health.status || 'unknown'} helper={`Uptime ${duration(data.health.uptime_seconds)} · ${data.health.version || 'version unknown'}`} icon={<IconServer size={20} />} color={data.health.status === 'ok' ? 'teal' : 'orange'} />
      </SimpleGrid>

      <Grid gap="lg">
        <Grid.Col span={{ base: 12, lg: 8 }}>
          <Paper withBorder p="lg" h="100%">
            <SectionHeading title="Work in progress" description="The most recent tasks across all connected agents." action={<Button variant="subtle" size="compact-sm" rightSection={<IconChevronRight size={14} />} onClick={() => navigate('/tasks')}>All tasks</Button>} />
            <TaskTable tasks={[...activeTasks, ...tasks.filter((task) => !ACTIVE_STATES.has(normalizeState(task)))].slice(0, 7)} compact />
          </Paper>
        </Grid.Col>
        <Grid.Col span={{ base: 12, lg: 4 }}>
          <Paper withBorder p="lg" h="100%">
            <SectionHeading title="Operator queue" description="Items that should not continue unattended." />
            {attentionTasks.length ? (
              <Stack gap="sm">
                {attentionTasks.slice(0, 5).map((task) => (
                  <UnstyledButton key={taskId(task)} className="attention-row" onClick={() => navigate('/tasks')}>
                    <Group align="flex-start" wrap="nowrap">
                      <ThemeIcon color={statusColor(normalizeState(task))} variant="light" size={32}><IconAlertTriangle size={17} /></ThemeIcon>
                      <Box style={{ flex: 1, minWidth: 0 }}>
                        <Text size="sm" fw={600} lineClamp={2}>{taskTitle(task)}</Text>
                        <Group gap={6} mt={6}><StatusBadge status={normalizeState(task)} /><Text size="xs" c="dimmed">{task.agent || 'unassigned'}</Text></Group>
                      </Box>
                    </Group>
                  </UnstyledButton>
                ))}
              </Stack>
            ) : <EmptyState icon={<IconCheck size={20} />} title="No intervention needed" description="All known tasks can continue without an operator decision." />}
          </Paper>
        </Grid.Col>
      </Grid>

      <Paper withBorder p="lg">
        <SectionHeading title="Agent fleet" description="Runtime health, responsibility, and current assignment for each OpenAB instance." action={<Button variant="subtle" size="compact-sm" rightSection={<IconChevronRight size={14} />} onClick={() => navigate('/agents')}>Manage fleet</Button>} />
        <AgentTable
          agents={fleetAgents}
          profiles={profiles}
          tasks={tasks}
          openAgent={openAgent}
          openLogs={openLogs}
          profilesLoading={profilesQuery.isLoading}
          profilesError={profilesQuery.isError}
          runtimeError={fleetInstancesQuery.isError}
        />
        {fleetInstancesQuery.data?.docker && !fleetInstancesQuery.data.docker.available && (
          <Alert mt="md" color="orange" variant="light" icon={<IconAlertTriangle size={17} />} title="Docker inspection unavailable">
            {fleetInstancesQuery.data.docker.error || 'Runtime metadata is degraded, but configured agents are still listed.'}
          </Alert>
        )}
      </Paper>
    </Stack>
  );
}

function AgentTable({ agents, profiles, tasks, openAgent, openLogs, profilesLoading, profilesError, runtimeError }: {
  agents: AgentInstance[]; profiles: PublicAgentProfile[]; tasks: OpsTask[];
  openAgent: (agent: AgentInstance) => void; openLogs: (agent: AgentInstance) => void;
  profilesLoading?: boolean; profilesError?: boolean; runtimeError?: boolean;
}) {
  const navigate = useNavigate();
  const joined = useMemo(() => joinProfileRuntime(profiles, agents), [profiles, agents]);

  if (joined.length === 0 && !profilesLoading) {
    return <EmptyState icon={<IconRobot size={20} />} title="No agents configured" description="Add agents to the server registry before they can appear here." />;
  }

  const showProfileColumn = profiles.length > 0 || profilesLoading || profilesError;

  function ProfileCell({ profile, id }: { profile: PublicAgentProfile | null; id: string }) {
    if (profilesLoading) return <Skeleton height={22} width={90} radius="sm" />;
    if (profilesError) {
      // Only flag missing profiles when runtime exists and we know the API
      // succeeded but didn't include this agent. Otherwise show error state.
      return <Badge color="red" variant="light" size="sm">Profile API error</Badge>;
    }
    if (profile) {
      return (
        <Stack gap={4}>
          <Badge color={profile.enabled ? 'teal' : 'red'} variant="light" size="sm">{profile.enabled ? 'Enabled' : 'Disabled'}</Badge>
          <Text size="xs" c="dimmed">{profile.profile_version}</Text>
        </Stack>
      );
    }
    return <Badge color="orange" variant="light" size="sm">Profile unavailable</Badge>;
  }

  function ProfileDataCell({ profile }: { profile: PublicAgentProfile | null }) {
    if (profilesLoading) return <Skeleton height={16} width={60} />;
    if (profilesError) return <Text size="xs" c="dimmed">—</Text>;
    if (profile) return null; // caller renders profile data
    return <Text size="xs" c="dimmed">—</Text>;
  }

  return (
    <Table.ScrollContainer minWidth={1200}>
      <Table verticalSpacing="md" highlightOnHover>
        <Table.Thead>
          <Table.Tr>
            <Table.Th>Agent</Table.Th>
            <Table.Th>Profile</Table.Th>
            <Table.Th>Runtime</Table.Th>
            <Table.Th>Role</Table.Th>
            <Table.Th>Mission</Table.Th>
            <Table.Th>Skills</Table.Th>
            <Table.Th>Memory</Table.Th>
            <Table.Th>Repos</Table.Th>
            <Table.Th>Current work</Table.Th>
            <Table.Th>Polling</Table.Th>
            <Table.Th />
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {joined.map(({ id, profile, runtime: agent }) => {
            const current = agent ? tasks.find((task) => task.agent?.toLowerCase() === agent.agent.toLowerCase() && ACTIVE_STATES.has(normalizeState(task))) : undefined;
            const displayName = profile?.display_name || agent?.display_name || id;
            const role = agent?.role || profile?.runtime?.backend || '—';
            const description = agent?.description || '';
            return (
              <Table.Tr key={id}>
                <Table.Td>
                  <UnstyledButton onClick={() => navigate(`/agents/${id}`)}>
                    <Group gap="sm" wrap="nowrap">
                      <Indicator color={agent ? statusColor(agent.runtime?.status) : 'gray'} size={9} offset={4} position="bottom-end" withBorder>
                        <Avatar radius="md" color="violet" variant="light">{displayName.slice(0, 2).toUpperCase()}</Avatar>
                      </Indicator>
                      <Box>
                        <Text fw={600} size="sm">{displayName}</Text>
                        <Text size="xs" c="dimmed" ff="monospace">{id}</Text>
                      </Box>
                    </Group>
                  </UnstyledButton>
                </Table.Td>
                <Table.Td><ProfileCell profile={profile} id={id} /></Table.Td>
                <Table.Td>
                  {runtimeError ? (
                    <Badge color="red" variant="light" size="sm">Runtime API error</Badge>
                  ) : agent ? (
                    <Stack gap={4}>
                      <StatusBadge status={agent.runtime?.status} />
                      <Text size="xs" c="dimmed">{agent.runtime?.restart_count || 0} restarts</Text>
                    </Stack>
                  ) : (
                    <Badge color="gray" variant="light" size="sm">Runtime unavailable</Badge>
                  )}
                </Table.Td>
                <Table.Td>
                  <Text size="sm" fw={500}>{role}</Text>
                  {description && <Text size="xs" c="dimmed" lineClamp={1}>{description}</Text>}
                </Table.Td>
                <Table.Td>
                  {profile ? (
                    <Text size="xs" lineClamp={2} maw={160}>{profile.mission}</Text>
                  ) : (
                    <ProfileDataCell profile={profile} />
                  )}
                </Table.Td>
                <Table.Td>
                  {profile ? (
                    <Badge variant="light" color="violet">{profile.skills.length}</Badge>
                  ) : (
                    <ProfileDataCell profile={profile} />
                  )}
                </Table.Td>
                <Table.Td>
                  {profile ? (
                    <Group gap={4}>
                      <Badge variant="light" color="blue" size="sm">{profile.memory.read.length}r</Badge>
                      <Badge variant="light" color="orange" size="sm">{profile.memory.write.length}w</Badge>
                    </Group>
                  ) : (
                    <ProfileDataCell profile={profile} />
                  )}
                </Table.Td>
                <Table.Td>
                  {profile ? (
                    <Badge variant="light" color="gray">{profile.repositories.length}</Badge>
                  ) : (
                    <ProfileDataCell profile={profile} />
                  )}
                </Table.Td>
                <Table.Td>
                  {current ? (
                    <Box style={{ minWidth: 0 }}>
                      <Text size="sm" fw={500} lineClamp={1}>{taskTitle(current)}</Text>
                      <Text size="xs" c="dimmed">{relativeTime(taskTimestamp(current))}</Text>
                    </Box>
                  ) : (
                    <Text size="sm" c="dimmed">Idle</Text>
                  )}
                </Table.Td>
                <Table.Td>
                  <Badge variant="dot" color={agent?.github_polling_enabled ? 'teal' : 'gray'}>
                    {agent?.github_polling_enabled ? 'enabled' : 'disabled'}
                  </Badge>
                </Table.Td>
                <Table.Td>
                  <Group gap={4} justify="flex-end" wrap="nowrap">
                    {agent && (
                      <>
                        <Tooltip label="View logs">
                          <ActionIcon variant="subtle" color="gray" onClick={(e) => { e.stopPropagation(); openLogs(agent); }}>
                            <IconTerminal2 size={17} />
                          </ActionIcon>
                        </Tooltip>
                        <Tooltip label="Agent details">
                          <ActionIcon variant="subtle" color="gray" onClick={(e) => { e.stopPropagation(); openAgent(agent); }}>
                            <IconChevronRight size={17} />
                          </ActionIcon>
                        </Tooltip>
                      </>
                    )}
                  </Group>
                </Table.Td>
              </Table.Tr>
            );
          })}
        </Table.Tbody>
      </Table>
    </Table.ScrollContainer>
  );
}

function TaskTable({ tasks, compact = false }: { tasks: OpsTask[]; compact?: boolean }) {
  if (!tasks.length) return <EmptyState icon={<IconListCheck size={20} />} title="No tasks found" description="New GitHub, review, or workflow tasks will appear here." />;
  return (
    <Table.ScrollContainer minWidth={compact ? 620 : 820}>
      <Table verticalSpacing={compact ? 'sm' : 'md'} highlightOnHover>
        <Table.Thead><Table.Tr><Table.Th>Task</Table.Th><Table.Th>Status</Table.Th><Table.Th>Agent</Table.Th>{!compact && <Table.Th>Source</Table.Th>}<Table.Th>Updated</Table.Th></Table.Tr></Table.Thead>
        <Table.Tbody>{tasks.map((task) => (
          <Table.Tr key={taskId(task)}>
            <Table.Td><Group gap="sm" wrap="nowrap"><ThemeIcon variant="light" color="gray" size={30}>{task.pr || task.issue_number ? <IconGitPullRequest size={16} /> : <IconFileText size={16} />}</ThemeIcon><Box style={{ minWidth: 0 }}><Text size="sm" fw={600} lineClamp={1}>{taskTitle(task)}</Text><Text size="xs" c="dimmed">{task.repository || task.trigger || taskId(task)}</Text></Box></Group></Table.Td>
            <Table.Td><StatusBadge status={normalizeState(task)} /></Table.Td>
            <Table.Td><Text size="sm">{task.agent || 'unassigned'}</Text></Table.Td>
            {!compact && <Table.Td><Text size="sm">{task.task_type || task.taskType || task.trigger || 'task'}</Text></Table.Td>}
            <Table.Td><Text size="sm" c="dimmed" style={{ whiteSpace: 'nowrap' }}>{relativeTime(taskTimestamp(task))}</Text></Table.Td>
          </Table.Tr>
        ))}</Table.Tbody>
      </Table>
    </Table.ScrollContainer>
  );
}

function AgentsPage({ openAgent, openLogs }: { openAgent: (agent: AgentInstance) => void; openLogs: (agent: AgentInstance) => void }) {
  const profilesQuery = useAgentProfiles();
  const fleetInstancesQuery = useQuery({
    queryKey: ['openab-instances'],
    queryFn: () => opsApi.instances(),
    refetchInterval: 10_000,
  });
  const tasksQuery = useQuery({
    queryKey: ['ops-tasks'],
    queryFn: () => opsApi.tasks(),
    refetchInterval: 10_000,
  });
  return (
    <Stack gap="lg">
      <Box>
        <Title order={1} className="page-title">Agents</Title>
        <Text c="dimmed" mt={6}>The runtime fleet and each agent's operational responsibility, joined with Git-backed profile policy.</Text>
      </Box>
      <Paper withBorder p="lg">
        {fleetInstancesQuery.isLoading && profilesQuery.isLoading ? <Skeleton height={360} /> : (
          <AgentTable
            agents={fleetInstancesQuery.data?.instances || []}
            profiles={profilesQuery.data?.profiles || []}
            tasks={tasksQuery.data?.tasks || []}
            openAgent={openAgent}
            openLogs={openLogs}
            profilesLoading={profilesQuery.isLoading}
            profilesError={profilesQuery.isError}
            runtimeError={fleetInstancesQuery.isError}
          />
        )}
      </Paper>
    </Stack>
  );
}

function TasksPage() {
  const query = useDashboardData();
  const [filter, setFilter] = useState('all');
  const tasks = query.data?.tasks.tasks || [];
  const filtered = tasks.filter((task) => filter === 'all' || (filter === 'active' && ACTIVE_STATES.has(normalizeState(task))) || (filter === 'attention' && ATTENTION_STATES.has(normalizeState(task))) || (filter === 'completed' && SUCCESS_STATES.has(normalizeState(task))));
  return (
    <Stack gap="lg">
      <Group justify="space-between" align="flex-end"><Box><Title order={1} className="page-title">Tasks</Title><Text c="dimmed" mt={6}>Work received from GitHub and future workflow integrations.</Text></Box><SegmentedControl value={filter} onChange={setFilter} data={[{ label: 'All', value: 'all' }, { label: 'Active', value: 'active' }, { label: 'Attention', value: 'attention' }, { label: 'Completed', value: 'completed' }]} /></Group>
      <Paper withBorder p="lg">{query.isLoading ? <Skeleton height={360} /> : <TaskTable tasks={filtered} />}</Paper>
    </Stack>
  );
}

function AgentDrawer({ agent, opened, close, openLogs }: { agent: AgentInstance | null; opened: boolean; close: () => void; openLogs: (agent: AgentInstance) => void }) {
  if (!agent) return null;
  const role = agent.role || agent.backend || 'Agent';
  const description = agent.description || 'OpenAB runtime agent.';
  const rows = [
    ['Desired state', agent.desired_state || 'unmanaged'], ['Observed state', agent.observed_state || agent.runtime?.status || 'unknown'], ['Health', agent.runtime?.health || 'unknown'], ['Role', role], ['Backend', agent.backend || '-'], ['Service', agent.service || '-'], ['Container', agent.container_name || '-'], ['GitHub polling', agent.github_polling_enabled ? 'Enabled' : 'Disabled'], ['Restarts', String(agent.runtime?.restart_count || 0)], ['Config', agent.config_path || '-'], ['Data directory', agent.data_dir || '-'],
  ];
  return (
    <Drawer opened={opened} onClose={close} title="Agent details" position="right" size="lg">
      <Stack gap="lg">
        <Group><Avatar size={54} radius="lg" color="violet" variant="light">{(agent.display_name || agent.agent).slice(0, 2).toUpperCase()}</Avatar><Box><Title order={3}>{agent.display_name || agent.agent}</Title><Text size="sm" c="dimmed">{description}</Text></Box></Group>
        <Group><StatusBadge status={agent.runtime?.status} /><StatusBadge status={agent.runtime?.health} /></Group>
        <Divider />
        <Stack gap={0}>{rows.map(([label, value]) => <Group key={label} justify="space-between" py="sm" className="detail-row"><Text size="sm" c="dimmed">{label}</Text><Code>{value}</Code></Group>)}</Stack>
        <Button leftSection={<IconTerminal2 size={16} />} onClick={() => openLogs(agent)}>Open log tail</Button>
      </Stack>
    </Drawer>
  );
}

function LogsModal({ agent, opened, close }: { agent: AgentInstance | null; opened: boolean; close: () => void }) {
  const query = useQuery({ queryKey: ['agent-logs', agent?.agent], queryFn: () => opsApi.logs(agent?.agent || '', agent?.links?.logs), enabled: opened && Boolean(agent) });
  const logs = query.data?.logs || [];
  return (
    <Modal opened={opened} onClose={close} title={`${agent?.display_name || agent?.agent || 'Agent'} logs`} size="xl" centered>
      {query.isLoading && <Center py={40}><Loader /></Center>}
      {query.isError && <Alert color="red">Failed to load logs for this agent.</Alert>}
      {!query.isLoading && !query.isError && !logs.length && <EmptyState icon={<IconTerminal2 size={20} />} title="No logs available" description="The agent has not produced an accessible log file yet." />}
      <Stack>{logs.map((log) => <Box key={log.file}><Group justify="space-between" mb={6}><Text size="sm" fw={600}>{log.file || 'Log file'}</Text><Text size="xs" c="dimmed">{log.lines?.length || 0} lines</Text></Group><ScrollArea h={280} className="log-viewer"><Code block>{(log.lines || []).join('\n')}</Code></ScrollArea></Box>)}</Stack>
    </Modal>
  );
}

const navigation = [
  { label: 'Dashboard', path: '/', icon: IconDashboard },
  { label: 'Agents', path: '/agents', icon: IconUsers },
  { label: 'Tasks', path: '/tasks', icon: IconListCheck },
  { label: 'Workflows', path: '/workflows', icon: IconRoute },
  { label: 'Activity', path: '/activity', icon: IconActivity },
  { label: 'Skills', path: '/skills', icon: IconCode },
  { label: 'Memory', path: '/memory', icon: IconDatabase },
  { label: 'Settings', path: '/settings', icon: IconSettings },
];

function AppNavigation({ closeMobile }: { closeMobile: () => void }) {
  const location = useLocation();
  const navigate = useNavigate();
  return (
    <Stack gap={4}>
      {navigation.map((item) => <NavLink key={item.path} label={item.label} leftSection={<item.icon size={18} stroke={1.8} />} active={location.pathname === item.path} onClick={() => { navigate(item.path); closeMobile(); }} />)}
    </Stack>
  );
}

export default function App() {
  const [mobileOpened, mobile] = useDisclosure(false);
  const [agentOpened, agentDrawer] = useDisclosure(false);
  const [logsOpened, logsModal] = useDisclosure(false);
  const [selectedAgent, setSelectedAgent] = useState<AgentInstance | null>(null);
  const queryClient = useQueryClient();
  const location = useLocation();
  const pageName = navigation.find((item) => item.path === location.pathname)?.label || 'Ops Room';

  const openAgent = (agent: AgentInstance) => { setSelectedAgent(agent); agentDrawer.open(); };
  const openLogs = (agent: AgentInstance) => { setSelectedAgent(agent); logsModal.open(); };
  const lastUpdated = useMemo(() => new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }), [queryClient.getQueryState(['ops-dashboard'])?.dataUpdatedAt]);

  return (
    <AppShell header={{ height: 64 }} navbar={{ width: 248, breakpoint: 'md', collapsed: { mobile: !mobileOpened } }} padding={{ base: 'md', sm: 'xl' }}>
      <AppShell.Header className="app-header">
        <Group h="100%" px="lg" justify="space-between">
          <Group gap="sm"><Burger opened={mobileOpened} onClick={mobile.toggle} hiddenFrom="md" size="sm" /><ThemeIcon size={34} radius="md" variant="gradient" gradient={{ from: 'violet', to: 'indigo' }}><IconSparkles size={19} /></ThemeIcon><Box><Text fw={700} lh={1.1}>Ops Room</Text><Text size="xs" c="dimmed">Agent control plane</Text></Box></Group>
          <Group gap="md"><Group gap={6} visibleFrom="sm"><Badge variant="dot" color="teal">Live</Badge><Text size="xs" c="dimmed">Updated {lastUpdated}</Text></Group><Tooltip label="Refresh all data"><ActionIcon variant="default" size="lg" onClick={() => { queryClient.invalidateQueries({ queryKey: ['ops-dashboard'] }); queryClient.invalidateQueries({ queryKey: ['agent-profiles'] }); queryClient.invalidateQueries({ queryKey: ['agent-profile'] }); queryClient.invalidateQueries({ queryKey: ['skills-catalog'] }); queryClient.invalidateQueries({ queryKey: ['memory-spaces'] }); queryClient.invalidateQueries({ queryKey: ['openab-instances'] }); }}><IconRefresh size={17} /></ActionIcon></Tooltip></Group>
        </Group>
      </AppShell.Header>
      <AppShell.Navbar p="md" className="app-navbar">
        <AppShell.Section grow component={ScrollArea}><Text size="xs" fw={700} c="dimmed" tt="uppercase" lts={0.8} px="sm" mb="sm">Workspace</Text><AppNavigation closeMobile={mobile.close} /></AppShell.Section>
        <AppShell.Section><Divider mb="md" /><Card withBorder padding="md"><Group gap="sm"><ThemeIcon variant="light" color="teal"><IconBrandGithub size={17} /></ThemeIcon><Box><Text size="sm" fw={600}>GitHub connected</Text><Text size="xs" c="dimmed">Task source</Text></Box></Group></Card></AppShell.Section>
      </AppShell.Navbar>
      <AppShell.Main><Box maw={1480} mx="auto" className="main-content"><Text size="xs" c="dimmed" mb="md">Ops Room / {pageName}</Text><Routes>
        <Route path="/" element={<DashboardPage openAgent={openAgent} openLogs={openLogs} />} />
        <Route path="/agents" element={<AgentsPage openAgent={openAgent} openLogs={openLogs} />} />
        <Route path="/agents/:id" element={<AgentDetailPage />} />
        <Route path="/tasks" element={<TasksPage />} />
        <Route path="/workflows" element={<WorkflowsPage />} />
        <Route path="/activity" element={<ActivityPage />} />
        <Route path="/skills" element={<SkillsPage />} />
        <Route path="/memory" element={<MemorySpacesPage />} />
        <Route path="/settings" element={<SettingsPage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes></Box></AppShell.Main>
      <AgentDrawer agent={selectedAgent} opened={agentOpened} close={agentDrawer.close} openLogs={(agent) => { agentDrawer.close(); openLogs(agent); }} />
      <LogsModal agent={selectedAgent} opened={logsOpened} close={logsModal.close} />
    </AppShell>
  );
}
