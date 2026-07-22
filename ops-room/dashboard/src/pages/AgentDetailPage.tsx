import {
  Alert,
  Badge,
  Box,
  Center,
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
import {
  IconActivity,
  IconAlertTriangle,
  IconBan,
  IconBrain,
  IconCheck,
  IconCode,
  IconDatabase,
  IconEye,
  IconFileText,
  IconGitBranch,
  IconPencil,
  IconRobot,
  IconServer,
  IconShieldCheck,
} from '@tabler/icons-react';
import { useQuery } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { useParams } from 'react-router-dom';
import { opsApi } from '../api';
import type { AgentFleetItem, AgentFleetState } from '../api/agent-fleet';
import type { ProfileMemoryAssignment, PublicAgentProfile } from '../api/agent-profiles';
import type { CompatibilityStatus, RequirementStatus } from '../api/skills';
import { useAgentFleet } from '../hooks/use-agent-fleet';
import { useAgentProfile } from '../hooks/use-agent-profile';
import type { AgentInstance } from '../types';

function statusColor(status?: string) {
  if (status === 'running' || status === 'healthy' || status === 'compatible' || status === 'present' || status === 'resolved' || status === 'idle') return 'teal';
  if (status === 'working') return 'violet';
  if (status === 'waiting') return 'blue';
  if (status === 'paused') return 'yellow';
  if (status === 'needs_human') return 'orange';
  if (status === 'exited' || status === 'missing' || status === 'incompatible' || status === 'unavailable') return 'red';
  return 'gray';
}

function StatusBadge({ status }: { status?: string }) {
  return <Badge color={statusColor(status)} variant="light">{String(status || 'unknown').replaceAll('_', ' ')}</Badge>;
}

function ProfileSection({ title, icon, children }: { title: string; icon: ReactNode; children: ReactNode }) {
  return <Paper withBorder p="lg"><Group mb="md" gap="sm"><ThemeIcon variant="light" color="violet" size={28}>{icon}</ThemeIcon><Title order={4}>{title}</Title></Group>{children}</Paper>;
}

function RuntimeSection({ agent }: { agent: AgentInstance }) {
  const role = agent.role || agent.backend || 'Agent';
  return (
    <Paper withBorder p="lg">
      <Group mb="md" gap="sm"><ThemeIcon variant="light" color="teal" size={28}><IconServer size={16} /></ThemeIcon><Title order={4}>Runtime State</Title><Badge variant="light" color="teal" size="sm">Observed</Badge></Group>
      <Stack gap="sm">
        <Group justify="space-between" py="xs" className="detail-row"><Text size="sm" c="dimmed">Observed status</Text><StatusBadge status={agent.runtime?.status} /></Group>
        <Group justify="space-between" py="xs" className="detail-row"><Text size="sm" c="dimmed">Health</Text><Text size="sm">{agent.runtime?.health || 'unknown'}</Text></Group>
        <Group justify="space-between" py="xs" className="detail-row"><Text size="sm" c="dimmed">Role</Text><Text size="sm">{role}</Text></Group>
        <Group justify="space-between" py="xs" className="detail-row"><Text size="sm" c="dimmed">Backend</Text><Text size="sm">{agent.backend || '-'}</Text></Group>
        <Group justify="space-between" py="xs" className="detail-row"><Text size="sm" c="dimmed">Service</Text><Text size="sm">{agent.service || '-'}</Text></Group>
        <Group justify="space-between" py="xs" className="detail-row"><Text size="sm" c="dimmed">Container</Text><Text size="sm">{agent.container_name || '-'}</Text></Group>
        <Group justify="space-between" py="xs" className="detail-row"><Text size="sm" c="dimmed">Restarts</Text><Text size="sm">{agent.runtime?.restart_count ?? 0}</Text></Group>
        <Group justify="space-between" py="xs" className="detail-row"><Text size="sm" c="dimmed">GitHub polling</Text><Badge variant="dot" color={agent.github_polling_enabled ? 'teal' : 'gray'}>{agent.github_polling_enabled ? 'Enabled' : 'Disabled'}</Badge></Group>
      </Stack>
    </Paper>
  );
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
    if (Math.abs(seconds) >= amount) return formatter.format(Math.round(seconds / amount), unit);
  }
  return formatter.format(seconds, 'second');
}

function fleetStateLabel(state: AgentFleetState) {
  return state.replaceAll('_', ' ');
}

function OperationalSummary({ fleet, loading, error }: { fleet: AgentFleetItem | null; loading: boolean; error: boolean }) {
  if (loading) {
    return <Paper withBorder p="lg"><Group mb="md"><Skeleton circle height={28} /><Skeleton height={22} width={180} /></Group><Skeleton height={130} /></Paper>;
  }

  if (error) {
    return <Paper withBorder p="lg"><Alert color="red" icon={<IconAlertTriangle size={18} />} title="Fleet summary unavailable">Validated profile and runtime sections remain independently available.</Alert></Paper>;
  }

  if (!fleet) {
    return <Paper withBorder p="lg"><Alert color="gray" icon={<IconActivity size={18} />} title="No normalized fleet evidence">This agent is not present in the current fleet snapshot.</Alert></Paper>;
  }

  const task = fleet.current_task;
  const workspace = task?.workspace;
  const repositories = task?.repository ? [task.repository] : fleet.repositories;

  return (
    <Paper withBorder p="lg">
      <Group justify="space-between" align="flex-start" mb="md">
        <Group gap="sm">
          <ThemeIcon variant="light" color={statusColor(fleet.state)} size={30}><IconActivity size={17} /></ThemeIcon>
          <Box>
            <Title order={4}>Operational Summary</Title>
            <Text size="xs" c="dimmed">Normalized profile, runtime, lifecycle, and current-work evidence.</Text>
          </Box>
        </Group>
        <Badge color={statusColor(fleet.state)} size="lg" variant="light">{fleetStateLabel(fleet.state)}</Badge>
      </Group>

      {fleet.attention.required && (
        <Alert color="orange" variant="light" mb="md" icon={<IconAlertTriangle size={17} />} title="Operator attention required">
          {fleet.attention.summary || fleet.attention.reason_code || 'The fleet contract reports an unresolved condition.'}
        </Alert>
      )}

      <Grid gutter="md">
        <Grid.Col span={{ base: 12, sm: 6 }}>
          <Text size="xs" fw={700} c="dimmed" tt="uppercase">Current work</Text>
          <Text size="sm" fw={600} mt={4}>{task?.title || 'No current task'}</Text>
          <Group gap={6} mt={6}>
            {task ? <StatusBadge status={task.status.toLowerCase()} /> : <Badge variant="light" color="gray">idle</Badge>}
            {task?.task_type && <Text size="xs" c="dimmed">{task.task_type}</Text>}
          </Group>
        </Grid.Col>
        <Grid.Col span={{ base: 12, sm: 6 }}>
          <Text size="xs" fw={700} c="dimmed" tt="uppercase">Runtime</Text>
          <Group gap={6} mt={4}><StatusBadge status={fleet.runtime.status} />{fleet.runtime.health && <StatusBadge status={fleet.runtime.health} />}</Group>
          <Text size="xs" c="dimmed" mt={6}>{fleet.runtime.restart_count} restart{fleet.runtime.restart_count === 1 ? '' : 's'} · {fleet.profile.runtime_backend || 'backend unknown'}</Text>
        </Grid.Col>
        <Grid.Col span={{ base: 12, sm: 6 }}>
          <Text size="xs" fw={700} c="dimmed" tt="uppercase">Repository</Text>
          {repositories.length ? <Stack gap={2} mt={4}>{repositories.slice(0, 3).map((repository) => <Text key={repository} size="sm" ff="monospace">{repository}</Text>)}</Stack> : <Text size="sm" c="dimmed" mt={4}>No repository assigned</Text>}
        </Grid.Col>
        <Grid.Col span={{ base: 12, sm: 6 }}>
          <Text size="xs" fw={700} c="dimmed" tt="uppercase">Last activity</Text>
          <Text size="sm" fw={600} mt={4}>{relativeTime(fleet.last_activity_at)}</Text>
          {fleet.last_activity_at && <Text size="xs" c="dimmed" mt={2}>{fleet.last_activity_at}</Text>}
        </Grid.Col>
      </Grid>

      {workspace && (
        <>
          <Divider my="md" />
          <Group align="flex-start" gap="sm" wrap="nowrap">
            <ThemeIcon variant="light" color={workspace.held_for_investigation ? 'orange' : 'blue'} size={28}><IconGitBranch size={15} /></ThemeIcon>
            <Box style={{ flex: 1 }}>
              <Group justify="space-between" align="flex-start">
                <Box>
                  <Text size="sm" fw={600}>Workspace evidence</Text>
                  <Text size="xs" c="dimmed" ff="monospace">{workspace.workspace_id}</Text>
                </Box>
                <StatusBadge status={workspace.state || 'unknown'} />
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

function RequirementList({ title, values }: { title: string; values: { label: string; status: RequirementStatus }[] }) {
  return (
    <Box>
      <Text size="xs" fw={600} c="dimmed" mb={4}>{title}</Text>
      {values.length ? <Group gap={4}>{values.map((item) => <Badge key={item.label} variant="outline" color={statusColor(item.status)}>{item.label} · {item.status}</Badge>)}</Group> : <Text size="xs" c="dimmed">None declared</Text>}
    </Box>
  );
}

function compatibilityLabel(status: CompatibilityStatus) {
  return status.charAt(0).toUpperCase() + status.slice(1);
}

function SkillAssignments({ profile }: { profile: PublicAgentProfile }) {
  return (
    <ProfileSection title="Declared Skills" icon={<IconCode size={16} />}>
      <Alert color="violet" variant="light" mb="md" icon={<IconEye size={16} />} title="Declared compatibility only">
        Compatibility indicates declared requirements only. It does not prove that the skill is installed or executable.
      </Alert>
      {profile.skill_assignments.length ? (
        <Stack gap="md">
          {profile.skill_assignments.map((assignment) => (
            <Paper key={`${assignment.key}@${assignment.version}`} withBorder p="md">
              <Stack gap="sm">
                <Group justify="space-between" align="flex-start">
                  <Box><Text fw={600} ff="monospace">{assignment.key}</Text><Text size="xs" c="dimmed">Immutable version {assignment.version}</Text></Box>
                  <Group gap={4}><Badge color={statusColor(assignment.resolution_status)}>{assignment.resolution_status}</Badge><Badge color={statusColor(assignment.compatibility.status)}>{compatibilityLabel(assignment.compatibility.status)}</Badge></Group>
                </Group>
                {assignment.compatibility.reasons.length > 0 && (
                  <Stack gap={3}>{assignment.compatibility.reasons.map((reason) => <Text key={`${reason.code}:${reason.subject || ''}`} size="xs"><Text span fw={600}>{reason.code}</Text>{reason.subject ? ` · ${reason.subject}` : ''} — {reason.message}</Text>)}</Stack>
                )}
                <RequirementList title="Required commands" values={assignment.requirements.commands.map((item) => ({ label: item.name, status: item.status }))} />
                <RequirementList title="Credential references" values={assignment.requirements.credentials.map((item) => ({ label: item.reference, status: item.status }))} />
              </Stack>
            </Paper>
          ))}
        </Stack>
      ) : <Text size="sm" c="dimmed">No skills declared</Text>}
    </ProfileSection>
  );
}

function MemoryAssignmentList({ title, icon, assignments }: { title: string; icon: ReactNode; assignments: ProfileMemoryAssignment[] }) {
  return (
    <Box>
      <Text size="sm" fw={600} mb="sm"><Group gap={6}>{icon}<span>{title}</span></Group></Text>
      {assignments.length ? (
        <Stack gap="sm">
          {assignments.map((assignment) => (
            <Paper key={`${assignment.access}:${assignment.key}`} withBorder p="sm">
              <Group justify="space-between" align="flex-start" wrap="nowrap">
                <Box>
                  <Text size="sm" fw={600}>{assignment.display_name}</Text>
                  <Text size="xs" ff="monospace" c="dimmed">{assignment.key}@{assignment.version}</Text>
                  <Text size="xs" ff="monospace" mt={4}>{assignment.publication_path}</Text>
                </Box>
                <Stack gap={4} align="flex-end">
                  <Badge variant="light" color={assignment.kind === 'private-agent' ? 'orange' : assignment.kind === 'shared' ? 'teal' : 'blue'}>{assignment.kind}</Badge>
                  <Badge variant="outline" color={assignment.write_policy === 'read-only' ? 'gray' : 'orange'}>{assignment.write_policy}</Badge>
                </Stack>
              </Group>
              {assignment.provenance.review_required && (
                <Text size="xs" c="dimmed" mt="xs">Future writes require review and provenance: {assignment.provenance.required_fields.join(', ')}.</Text>
              )}
            </Paper>
          ))}
        </Stack>
      ) : <Text size="sm" c="dimmed">None</Text>}
    </Box>
  );
}

function MemoryPolicy({ profile }: { profile: PublicAgentProfile }) {
  return (
    <ProfileSection title="Memory Policy" icon={<IconDatabase size={16} />}>
      <Alert color="violet" variant="light" mb="md" icon={<IconShieldCheck size={16} />} title="Validated governance only">
        Every logical key resolves to an approved Git-backed space. Ops Room does not browse the Obsidian vault or perform writes through this view.
      </Alert>
      <Stack gap="md">
        <MemoryAssignmentList title="Read spaces" icon={<IconEye size={14} />} assignments={profile.memory_assignments.read} />
        <Divider />
        <MemoryAssignmentList title="Write policy" icon={<IconPencil size={14} />} assignments={profile.memory_assignments.write} />
      </Stack>
    </ProfileSection>
  );
}

function PolicyProfile({ profile }: { profile: PublicAgentProfile }) {
  return (
    <Stack gap="lg">
      <ProfileSection title="Profile Policy" icon={<IconShieldCheck size={16} />}>
        <Stack gap="sm">
          <Group justify="space-between" py="xs" className="detail-row"><Text size="sm" c="dimmed">Display name</Text><Text size="sm" fw={500}>{profile.display_name}</Text></Group>
          <Group justify="space-between" py="xs" className="detail-row"><Text size="sm" c="dimmed">Agent ID</Text><Text size="sm" ff="monospace">{profile.id}</Text></Group>
          <Group justify="space-between" py="xs" className="detail-row"><Text size="sm" c="dimmed">Enabled</Text><Badge color={profile.enabled ? 'teal' : 'red'} variant="light">{profile.enabled ? 'Enabled' : 'Disabled'}</Badge></Group>
          <Group justify="space-between" py="xs" className="detail-row"><Text size="sm" c="dimmed">Profile version</Text><Text size="sm">{profile.profile_version}</Text></Group>
          <Group justify="space-between" py="xs" className="detail-row"><Text size="sm" c="dimmed">Schema version</Text><Text size="sm">{profile.schema_version}</Text></Group>
          <Group justify="space-between" py="xs" className="detail-row"><Text size="sm" c="dimmed">Runtime backend</Text><Text size="sm">{profile.runtime.backend}</Text></Group>
        </Stack>
      </ProfileSection>
      <ProfileSection title="Mission" icon={<IconFileText size={16} />}><Text size="sm">{profile.mission}</Text></ProfileSection>
      <ProfileSection title="Personality" icon={<IconBrain size={16} />}>
        <Stack gap="md">
          <Box><Text size="sm" fw={600} mb={4}>Communication style</Text><Text size="sm">{profile.personality.communication_style}</Text></Box>
          <Box><Text size="sm" fw={600} mb={4}>Decision policies</Text><Stack gap={4}>{profile.personality.decision_policy.map((policy) => <Group key={policy} gap="sm" wrap="nowrap"><ThemeIcon size={18} variant="light" color="violet" radius="xl"><IconCheck size={12} /></ThemeIcon><Text size="sm">{policy}</Text></Group>)}</Stack></Box>
          <Box><Text size="sm" fw={600} mb={4}>Constraints</Text><Stack gap={4}>{profile.personality.constraints.map((constraint) => <Group key={constraint} gap="sm" wrap="nowrap"><ThemeIcon size={18} variant="light" color="orange" radius="xl"><IconBan size={12} /></ThemeIcon><Text size="sm">{constraint}</Text></Group>)}</Stack></Box>
        </Stack>
      </ProfileSection>
      <SkillAssignments profile={profile} />
      <MemoryPolicy profile={profile} />
      <ProfileSection title="Allowed Repositories" icon={<IconGitBranch size={16} />}>
        <Alert color="violet" variant="light" mb="md" icon={<IconShieldCheck size={16} />} title="Declared access policy">This represents declared access policy, not proof of active repository credentials.</Alert>
        {profile.repositories.length ? <Stack gap={4}>{profile.repositories.map((repo) => <Text key={repo} size="sm" ff="monospace">{repo}</Text>)}</Stack> : <Text size="sm" c="dimmed">No repositories declared</Text>}
      </ProfileSection>
    </Stack>
  );
}

export function AgentDetailPage() {
  const { id } = useParams<{ id: string }>();
  const profileQuery = useAgentProfile(id);
  const fleetQuery = useAgentFleet();
  const instancesQuery = useQuery({ queryKey: ['openab-instances'], queryFn: () => opsApi.instances(), refetchInterval: 10_000 });
  const runtimeAgent: AgentInstance | null = (instancesQuery.data?.instances || []).find((instance) => instance.agent === id) || null;
  const fleetAgent = fleetQuery.data?.fleet.find((agent) => agent.id === id) || null;
  const profile = profileQuery.data?.profile || null;

  if (profileQuery.isLoading) return <Stack gap="lg"><Skeleton height={48} radius="md" />{Array.from({ length: 4 }).map((_, index) => <Skeleton key={index} height={180} radius="lg" />)}</Stack>;

  if (profileQuery.isError) {
    return <Stack gap="lg"><Box><Title order={1} className="page-title">{id || 'Agent data unavailable'}</Title><Text c="dimmed" mt={6}>Profile policy could not be loaded.</Text></Box><OperationalSummary fleet={fleetAgent} loading={fleetQuery.isLoading} error={fleetQuery.isError} /><Alert color="red" icon={<IconAlertTriangle size={18} />} title="Profile API unavailable">Runtime information remains visible when available.</Alert>{runtimeAgent && <RuntimeSection agent={runtimeAgent} />}</Stack>;
  }

  if (!profile) {
    if (runtimeAgent) return <Stack gap="lg"><Box><Title order={1}>{id}</Title><Text c="dimmed">Runtime instance without matching profile.</Text></Box><OperationalSummary fleet={fleetAgent} loading={fleetQuery.isLoading} error={fleetQuery.isError} /><Alert color="orange" title="Profile unavailable">No matching Git-backed policy profile was found.</Alert><RuntimeSection agent={runtimeAgent} /></Stack>;
    if (instancesQuery.isLoading) return <Stack><Title order={1}>{id}</Title><OperationalSummary fleet={fleetAgent} loading={fleetQuery.isLoading} error={fleetQuery.isError} /><Skeleton height={120} /></Stack>;
    if (instancesQuery.isError) return <Stack><Title order={1}>{id}</Title><OperationalSummary fleet={fleetAgent} loading={fleetQuery.isLoading} error={fleetQuery.isError} /><Alert color="orange" title="Agent state unknown">The profile was not found and runtime inspection is unavailable.</Alert></Stack>;
    return <Center py={48}><Stack align="center" gap={8}><ThemeIcon size={48} radius="xl" variant="light" color="gray"><IconRobot size={24} /></ThemeIcon><Text fw={600}>Unknown agent</Text><Text size="sm" c="dimmed">No profile or runtime instance exists for “{id}”.</Text></Stack></Center>;
  }

  return (
    <Stack gap="lg">
      <Box><Group justify="space-between" align="flex-start"><Box><Title order={1} className="page-title">{profile.display_name}</Title><Text c="dimmed" mt={6}>{profile.mission}</Text></Box><Group gap="xs"><Badge color={profile.enabled ? 'teal' : 'red'} size="lg">{profile.enabled ? 'Enabled' : 'Disabled'}</Badge><Badge variant="light" color="violet" size="lg">Profile Policy</Badge></Group></Group></Box>
      <OperationalSummary fleet={fleetAgent} loading={fleetQuery.isLoading} error={fleetQuery.isError} />
      <Grid>
        <Grid.Col span={{ base: 12, lg: 7 }}><PolicyProfile profile={profile} /></Grid.Col>
        <Grid.Col span={{ base: 12, lg: 5 }}>
          {instancesQuery.isLoading ? <Paper withBorder p="lg"><Title order={4} mb="md">Runtime State</Title><Skeleton height={80} /></Paper>
            : instancesQuery.isError ? <Paper withBorder p="lg"><Alert color="red" title="Runtime API error">Profile policy remains available, but runtime state could not be loaded.</Alert></Paper>
              : runtimeAgent ? <RuntimeSection agent={runtimeAgent} />
                : <Paper withBorder p="lg"><Alert color="gray" title="Runtime unavailable">A valid profile exists, but no observable runtime instance was found.</Alert></Paper>}
        </Grid.Col>
      </Grid>
    </Stack>
  );
}
