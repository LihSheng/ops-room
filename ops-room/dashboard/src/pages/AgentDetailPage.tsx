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
import type { PublicAgentProfile } from '../api/agent-profiles';
import type { CompatibilityStatus, RequirementStatus } from '../api/skills';
import { useAgentProfile } from '../hooks/use-agent-profile';
import type { AgentInstance } from '../types';

function statusColor(status?: string) {
  if (status === 'running' || status === 'healthy' || status === 'compatible' || status === 'present' || status === 'resolved') return 'teal';
  if (status === 'exited' || status === 'missing' || status === 'incompatible') return 'red';
  return 'orange';
}

function StatusBadge({ status }: { status?: string }) {
  return <Badge color={statusColor(status)} variant="light">{String(status || 'unknown')}</Badge>;
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
      <ProfileSection title="Memory Policy" icon={<IconDatabase size={16} />}>
        <Alert color="violet" variant="light" mb="md" icon={<IconEye size={16} />} title="Declared policy scopes">These scopes are declarations from validated agent profiles. Ops Room does not inspect or verify the Obsidian vault through this page.</Alert>
        <Stack gap="md">
          <Box><Text size="sm" fw={600} mb={4}><Group gap={6}><IconEye size={14} /><span>Read scopes</span></Group></Text>{profile.memory.read.length ? <Stack gap={4}>{profile.memory.read.map((scope) => <Text key={scope} size="sm" ff="monospace" c="dimmed">{scope}</Text>)}</Stack> : <Text size="sm" c="dimmed">None</Text>}</Box>
          <Divider />
          <Box><Text size="sm" fw={600} mb={4}><Group gap={6}><IconPencil size={14} /><span>Write scopes</span></Group></Text>{profile.memory.write.length ? <Stack gap={4}>{profile.memory.write.map((scope) => <Text key={scope} size="sm" ff="monospace" c="dimmed">{scope}</Text>)}</Stack> : <Text size="sm" c="dimmed">None</Text>}</Box>
        </Stack>
      </ProfileSection>
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
  const instancesQuery = useQuery({ queryKey: ['openab-instances'], queryFn: () => opsApi.instances(), refetchInterval: 10_000 });
  const runtimeAgent: AgentInstance | null = (instancesQuery.data?.instances || []).find((instance) => instance.agent === id) || null;
  const profile = profileQuery.data?.profile || null;

  if (profileQuery.isLoading) return <Stack gap="lg"><Skeleton height={48} radius="md" />{Array.from({ length: 4 }).map((_, index) => <Skeleton key={index} height={180} radius="lg" />)}</Stack>;

  if (profileQuery.isError) {
    return <Stack gap="lg"><Box><Title order={1} className="page-title">{id || 'Agent data unavailable'}</Title><Text c="dimmed" mt={6}>Profile policy could not be loaded.</Text></Box><Alert color="red" icon={<IconAlertTriangle size={18} />} title="Profile API unavailable">Runtime information remains visible when available.</Alert>{runtimeAgent && <RuntimeSection agent={runtimeAgent} />}</Stack>;
  }

  if (!profile) {
    if (runtimeAgent) return <Stack gap="lg"><Box><Title order={1}>{id}</Title><Text c="dimmed">Runtime instance without matching profile.</Text></Box><Alert color="orange" title="Profile unavailable">No matching Git-backed policy profile was found.</Alert><RuntimeSection agent={runtimeAgent} /></Stack>;
    if (instancesQuery.isLoading) return <Stack><Title order={1}>{id}</Title><Skeleton height={120} /></Stack>;
    if (instancesQuery.isError) return <Stack><Title order={1}>{id}</Title><Alert color="orange" title="Agent state unknown">The profile was not found and runtime inspection is unavailable.</Alert></Stack>;
    return <Center py={48}><Stack align="center" gap={8}><ThemeIcon size={48} radius="xl" variant="light" color="gray"><IconRobot size={24} /></ThemeIcon><Text fw={600}>Unknown agent</Text><Text size="sm" c="dimmed">No profile or runtime instance exists for “{id}”.</Text></Stack></Center>;
  }

  return (
    <Stack gap="lg">
      <Box><Group justify="space-between" align="flex-start"><Box><Title order={1} className="page-title">{profile.display_name}</Title><Text c="dimmed" mt={6}>{profile.mission}</Text></Box><Group gap="xs"><Badge color={profile.enabled ? 'teal' : 'red'} size="lg">{profile.enabled ? 'Enabled' : 'Disabled'}</Badge><Badge variant="light" color="violet" size="lg">Profile Policy</Badge></Group></Group></Box>
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
