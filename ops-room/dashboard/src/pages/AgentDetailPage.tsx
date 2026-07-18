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
import type { ReactNode } from 'react';
import { useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { useAgentProfile } from '../hooks/use-agent-profile';
import { opsApi } from '../api';
import type { AgentInstance } from '../types';
import type { PublicAgentProfile } from '../api/agent-profiles';

function StatusBadge({ status }: { status?: string }) {
  const color = status === 'running' || status === 'healthy' ? 'teal' : status === 'exited' || status === 'missing' ? 'red' : 'gray';
  return <Badge color={color} variant="light">{String(status || 'unknown')}</Badge>;
}

function ProfileSection({ title, icon, children }: { title: string; icon: ReactNode; children: ReactNode }) {
  return (
    <Paper withBorder p="lg">
      <Group mb="md" gap="sm">
        <ThemeIcon variant="light" color="violet" size={28}>{icon}</ThemeIcon>
        <Title order={4}>{title}</Title>
      </Group>
      {children}
    </Paper>
  );
}

function RuntimeSection({ agent }: { agent: AgentInstance }) {
  const role = agent.role || agent.backend || 'Agent';
  return (
    <Paper withBorder p="lg">
      <Group mb="md" gap="sm">
        <ThemeIcon variant="light" color="teal" size={28}><IconServer size={16} /></ThemeIcon>
        <Title order={4}>Runtime State</Title>
        <Badge variant="light" color="teal" size="sm">Observed</Badge>
      </Group>
      <Stack gap="sm">
        <Group justify="space-between" py="xs" className="detail-row"><Text size="sm" c="dimmed">Observed status</Text><StatusBadge status={agent.runtime?.status} /></Group>
        <Group justify="space-between" py="xs" className="detail-row"><Text size="sm" c="dimmed">Health</Text><Text size="sm">{agent.runtime?.health || 'unknown'}</Text></Group>
        <Group justify="space-between" py="xs" className="detail-row"><Text size="sm" c="dimmed">Role</Text><Text size="sm">{role}</Text></Group>
        <Group justify="space-between" py="xs" className="detail-row"><Text size="sm" c="dimmed">Backend</Text><Text size="sm">{agent.backend || '-'}</Text></Group>
        <Group justify="space-between" py="xs" className="detail-row"><Text size="sm" c="dimmed">Service</Text><Text size="sm">{agent.service || '-'}</Text></Group>
        <Group justify="space-between" py="xs" className="detail-row"><Text size="sm" c="dimmed">Container</Text><Text size="sm">{agent.container_name || '-'}</Text></Group>
        <Group justify="space-between" py="xs" className="detail-row"><Text size="sm" c="dimmed">Restarts</Text><Text size="sm">{agent.runtime?.restart_count ?? 0}</Text></Group>
        <Group justify="space-between" py="xs" className="detail-row"><Text size="sm" c="dimmed">GitHub polling</Text><Badge variant="dot" color={agent.github_polling_enabled ? 'teal' : 'gray'}>{agent.github_polling_enabled ? 'Enabled' : 'Disabled'}</Badge></Group>
        {agent.runtime?.started_at && <Group justify="space-between" py="xs" className="detail-row"><Text size="sm" c="dimmed">Started</Text><Text size="sm">{new Date(agent.runtime.started_at).toLocaleString()}</Text></Group>}
      </Stack>
    </Paper>
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

      <ProfileSection title="Mission" icon={<IconFileText size={16} />}>
        <Text size="sm">{profile.mission}</Text>
      </ProfileSection>

      <ProfileSection title="Personality" icon={<IconBrain size={16} />}>
        <Stack gap="md">
          <Box>
            <Text size="sm" fw={600} mb={4}>Communication style</Text>
            <Text size="sm">{profile.personality.communication_style}</Text>
          </Box>
          <Box>
            <Text size="sm" fw={600} mb={4}>Decision policies</Text>
            <Stack gap={4}>
              {profile.personality.decision_policy.map((policy, i) => (
                <Group key={i} gap="sm" wrap="nowrap"><ThemeIcon size={18} variant="light" color="violet" radius="xl"><IconCheck size={12} /></ThemeIcon><Text size="sm">{policy}</Text></Group>
              ))}
            </Stack>
          </Box>
          <Box>
            <Text size="sm" fw={600} mb={4}>Constraints</Text>
            <Stack gap={4}>
              {profile.personality.constraints.map((constraint, i) => (
                <Group key={i} gap="sm" wrap="nowrap"><ThemeIcon size={18} variant="light" color="orange" radius="xl"><IconBan size={12} /></ThemeIcon><Text size="sm">{constraint}</Text></Group>
              ))}
            </Stack>
          </Box>
        </Stack>
      </ProfileSection>

      <ProfileSection title="Declared Skills" icon={<IconCode size={16} />}>
        {profile.skills.length ? (
          <Group gap="xs">{profile.skills.map((skill) => <Badge key={skill} variant="light" color="violet">{skill}</Badge>)}</Group>
        ) : <Text size="sm" c="dimmed">No skills declared</Text>}
      </ProfileSection>

      <ProfileSection title="Memory Policy" icon={<IconDatabase size={16} />}>
        <Alert color="violet" variant="light" mb="md" icon={<IconEye size={16} />} title="Declared policy scopes">
          These scopes are declarations from validated agent profiles. Ops Room does not inspect or verify the Obsidian vault through this page.
        </Alert>
        <Stack gap="md">
          <Box>
            <Text size="sm" fw={600} mb={4}>
              <Group gap={6}><IconEye size={14} /><span>Read scopes</span></Group>
            </Text>
            {profile.memory.read.length ? (
              <Stack gap={4}>{profile.memory.read.map((scope) => <Text key={scope} size="sm" ff="monospace" c="dimmed">{scope}</Text>)}</Stack>
            ) : <Text size="sm" c="dimmed">None</Text>}
          </Box>
          <Divider />
          <Box>
            <Text size="sm" fw={600} mb={4}>
              <Group gap={6}><IconPencil size={14} /><span>Write scopes</span></Group>
            </Text>
            {profile.memory.write.length ? (
              <Stack gap={4}>{profile.memory.write.map((scope) => <Text key={scope} size="sm" ff="monospace" c="dimmed">{scope}</Text>)}</Stack>
            ) : <Text size="sm" c="dimmed">None</Text>}
          </Box>
        </Stack>
      </ProfileSection>

      <ProfileSection title="Allowed Repositories" icon={<IconGitBranch size={16} />}>
        <Alert color="violet" variant="light" mb="md" icon={<IconShieldCheck size={16} />} title="Declared access policy">
          This represents declared access policy, not proof of active repository credentials.
        </Alert>
        {profile.repositories.length ? (
          <Stack gap={4}>{profile.repositories.map((repo) => <Text key={repo} size="sm" ff="monospace">{repo}</Text>)}</Stack>
        ) : <Text size="sm" c="dimmed">No repositories declared</Text>}
      </ProfileSection>
    </Stack>
  );
}

export function AgentDetailPage() {
  const { id } = useParams<{ id: string }>();
  const profileQuery = useAgentProfile(id);
  const instancesQuery = useQuery({
    queryKey: ['openab-instances'],
    queryFn: () => opsApi.instances(),
    refetchInterval: 10_000,
  });

  const instances = instancesQuery.data?.instances || [];
  const runtimeAgent: AgentInstance | null = instances.find((inst) => inst.agent === id) || null;

  const profileError = profileQuery.isError;
  const profileLoading = profileQuery.isLoading;
  const profile = profileQuery.data?.profile || null;
  const instancesError = instancesQuery.isError;

  // Loading
  if (profileLoading) {
    return (
      <Stack gap="lg">
        <Skeleton height={48} radius="md" />
        {Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} height={180} radius="lg" />)}
      </Stack>
    );
  }

  // Profile API failure — distinguish from genuinely missing profile
  if (profileError) {
    if (runtimeAgent) {
      return (
        <Stack gap="lg">
          <Box>
            <Title order={1} className="page-title">{id}</Title>
            <Text c="dimmed" mt={6}>Runtime instance with profile API error.</Text>
          </Box>
          <Alert color="red" icon={<IconAlertTriangle size={18} />} title="Profile API unavailable">
            The profile API request failed. A runtime instance exists for this agent, but profile policy metadata could not be loaded.
          </Alert>
          <RuntimeSection agent={runtimeAgent} />
        </Stack>
      );
    }
    return (
      <Stack gap="lg">
        <Box>
          <Title order={1} className="page-title">Agent data unavailable</Title>
          <Text c="dimmed" mt={6}>The profile API request failed for "{id}".</Text>
        </Box>
        <Alert color="red" icon={<IconAlertTriangle size={18} />} title="Profile API error">
          Could not load profile data. Check server health and try again.
        </Alert>
      </Stack>
    );
  }

  // Profile not found (404 from API — genuinely missing)
  if (!profile) {
    if (runtimeAgent) {
      return (
        <Stack gap="lg">
          <Box>
            <Title order={1} className="page-title">{id}</Title>
            <Text c="dimmed" mt={6}>Runtime instance without matching profile.</Text>
          </Box>
          <Alert color="orange" icon={<IconAlertTriangle size={18} />} title="Profile unavailable">
            A runtime instance exists for this agent, but no matching profile was found. This represents a policy inconsistency.
          </Alert>
          <RuntimeSection agent={runtimeAgent} />
        </Stack>
      );
    }
    // Runtime still loading — don't conclude "Agent not found" yet
    if (instancesQuery.isLoading) {
      return (
        <Stack gap="lg">
          <Box>
            <Title order={1} className="page-title">{id}</Title>
            <Text c="dimmed" mt={6}>Checking runtime state...</Text>
          </Box>
          <Skeleton height={120} radius="lg" />
        </Stack>
      );
    }
    // Runtime API error — don't conclude "Agent not found"
    if (instancesQuery.isError) {
      return (
        <Stack gap="lg">
          <Box>
            <Title order={1} className="page-title">{id}</Title>
            <Text c="dimmed" mt={6}>Profile not found — runtime check unavailable.</Text>
          </Box>
          <Alert color="orange" icon={<IconAlertTriangle size={18} />} title="Profile unavailable">
            No matching profile was found, and the runtime API request failed. The agent may exist but could not be verified.
          </Alert>
        </Stack>
      );
    }
    return (
      <Stack gap="lg">
        <Box>
          <Title order={1} className="page-title">Agent not found</Title>
          <Text c="dimmed" mt={6}>No profile or runtime instance exists for "{id}".</Text>
        </Box>
        <Center py={48}>
          <Stack align="center" gap={8}>
            <ThemeIcon size={48} radius="xl" variant="light" color="gray"><IconRobot size={24} /></ThemeIcon>
            <Text fw={600}>Unknown agent</Text>
            <Text size="sm" c="dimmed">The agent ID "{id}" does not match any known profile or runtime instance.</Text>
          </Stack>
        </Center>
      </Stack>
    );
  }

  // Profile found — display
  return (
    <Stack gap="lg">
      <Box>
        <Group justify="space-between" align="flex-start">
          <Box>
            <Title order={1} className="page-title">{profile.display_name}</Title>
            <Text c="dimmed" mt={6}>{profile.mission}</Text>
          </Box>
          <Group gap="xs">
            <Badge color={profile.enabled ? 'teal' : 'red'} variant="light" size="lg">{profile.enabled ? 'Enabled' : 'Disabled'}</Badge>
            <Badge variant="light" color="violet" size="lg">Profile Policy</Badge>
          </Group>
        </Group>
      </Box>

      <Grid>
        <Grid.Col span={{ base: 12, lg: 7 }}>
          <PolicyProfile profile={profile} />
        </Grid.Col>
        <Grid.Col span={{ base: 12, lg: 5 }}>
          <Stack gap="lg">
            {instancesQuery.isLoading ? (
              <Paper withBorder p="lg">
                <Group mb="md" gap="sm">
                  <ThemeIcon variant="light" color="gray" size={28}><IconServer size={16} /></ThemeIcon>
                  <Title order={4}>Runtime State</Title>
                </Group>
                <Skeleton height={80} radius="sm" />
              </Paper>
            ) : instancesError ? (
              <Paper withBorder p="lg">
                <Group mb="md" gap="sm">
                  <ThemeIcon variant="light" color="gray" size={28}><IconServer size={16} /></ThemeIcon>
                  <Title order={4}>Runtime State</Title>
                </Group>
                <Alert color="red" icon={<IconAlertTriangle size={16} />} title="Runtime API error">
                  The runtime instances API request failed. Runtime state could not be loaded.
                </Alert>
              </Paper>
            ) : runtimeAgent ? (
              <RuntimeSection agent={runtimeAgent} />
            ) : (
              <Paper withBorder p="lg">
                <Group mb="md" gap="sm">
                  <ThemeIcon variant="light" color="gray" size={28}><IconServer size={16} /></ThemeIcon>
                  <Title order={4}>Runtime State</Title>
                </Group>
                <Alert color="gray" icon={<IconAlertTriangle size={16} />} title="Runtime unavailable">
                  A valid profile exists, but no observable runtime instance was found.
                </Alert>
              </Paper>
            )}
            {instancesQuery.data?.docker && !instancesQuery.data.docker.available && (
              <Alert color="orange" variant="light" icon={<IconAlertTriangle size={16} />} title="Docker inspection unavailable">
                {instancesQuery.data.docker.error || 'Runtime metadata is degraded.'}
              </Alert>
            )}
          </Stack>
        </Grid.Col>
      </Grid>
    </Stack>
  );
}
