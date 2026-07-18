import {
  Alert,
  Badge,
  Box,
  Button,
  Group,
  Modal,
  Paper,
  Skeleton,
  Stack,
  Table,
  Text,
  ThemeIcon,
  Title,
} from '@mantine/core';
import { IconAlertTriangle, IconCode, IconEye, IconSearch, IconUsers } from '@tabler/icons-react';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { skillsApi, type CompatibilityStatus, type SkillCatalogItem } from '../api/skills';
import { useAgentProfiles } from '../hooks/use-agent-profiles';
import { useSkills } from '../hooks/use-skills';

function compatibilityColor(status: CompatibilityStatus) {
  if (status === 'compatible') return 'teal';
  if (status === 'incompatible') return 'red';
  return 'orange';
}

function SummaryBadges({ item }: { item: SkillCatalogItem }) {
  return (
    <Group gap={4} wrap="nowrap">
      <Badge color="teal" variant="light">{item.compatibility_summary.compatible} compatible</Badge>
      <Badge color="red" variant="light">{item.compatibility_summary.incompatible} incompatible</Badge>
      <Badge color="orange" variant="light">{item.compatibility_summary.unknown} unknown</Badge>
    </Group>
  );
}

export function SkillsPage() {
  const skillsQuery = useSkills();
  const profilesQuery = useAgentProfiles();
  const navigate = useNavigate();
  const [selected, setSelected] = useState<SkillCatalogItem | null>(null);
  const detailQuery = useQuery({
    queryKey: ['skill-detail', selected?.key, selected?.version],
    queryFn: () => skillsApi.detail(selected!.key, selected!.version),
    enabled: Boolean(selected),
  });

  const profiles = profilesQuery.data?.profiles || [];
  const agentNames = new Map(profiles.map((profile) => [profile.id, profile.display_name]));

  if (skillsQuery.isLoading) {
    return <Stack gap="lg"><Skeleton height={48} radius="md" />{Array.from({ length: 4 }).map((_, index) => <Skeleton key={index} height={92} radius="lg" />)}</Stack>;
  }

  if (skillsQuery.isError) {
    return (
      <Stack gap="lg">
        <Box><Title order={1} className="page-title">Skills</Title><Text c="dimmed" mt={6}>Versioned read-only skill registry.</Text></Box>
        <Alert color="red" title="Skill registry unavailable" icon={<IconAlertTriangle size={18} />}>
          The registry API could not be loaded. Agent profile and runtime views remain independent.
        </Alert>
      </Stack>
    );
  }

  const skills = skillsQuery.data?.skills || [];
  const count = skillsQuery.data?.count || 0;
  const detail = detailQuery.data?.skill;

  return (
    <Stack gap="lg">
      <Box>
        <Group justify="space-between" align="flex-start">
          <Box>
            <Title order={1} className="page-title">Skills</Title>
            <Text c="dimmed" mt={6}>Validated, immutable skill versions declared by agent profiles.</Text>
          </Box>
          <Badge variant="light" color="violet" size="lg">{count} versions</Badge>
        </Group>
      </Box>

      <Alert color="violet" variant="light" icon={<IconCode size={18} />} title="Declared compatibility only">
        Compatibility indicates declared requirements only. It does not prove that the skill is installed or executable.
      </Alert>

      {skills.length === 0 ? (
        <Paper withBorder p="xl">
          <Stack align="center" gap={8}>
            <ThemeIcon size={44} radius="xl" variant="light" color="gray"><IconSearch size={21} /></ThemeIcon>
            <Text fw={600}>Empty skill registry</Text>
            <Text size="sm" c="dimmed">No validated skill manifests are currently registered.</Text>
          </Stack>
        </Paper>
      ) : (
        <Paper withBorder p="lg">
          <Table.ScrollContainer minWidth={1120}>
            <Table verticalSpacing="md" highlightOnHover>
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>Skill version</Table.Th>
                  <Table.Th>Description</Table.Th>
                  <Table.Th>Declared by</Table.Th>
                  <Table.Th>Runtimes</Table.Th>
                  <Table.Th>Requirements</Table.Th>
                  <Table.Th>Compatibility</Table.Th>
                  <Table.Th />
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {skills.map((item) => (
                  <Table.Tr key={`${item.key}@${item.version}`}>
                    <Table.Td>
                      <Group gap="sm" wrap="nowrap">
                        <ThemeIcon variant="light" color="violet" size={28}><IconCode size={14} /></ThemeIcon>
                        <Box><Text size="sm" fw={600} ff="monospace">{item.key}</Text><Text size="xs" c="dimmed">v{item.version}</Text></Box>
                      </Group>
                    </Table.Td>
                    <Table.Td><Text size="sm" maw={320}>{item.description}</Text></Table.Td>
                    <Table.Td>
                      <Group gap={4}>
                        {item.agents.map((agentId) => (
                          <Badge key={agentId} variant="light" color="violet" style={{ cursor: 'pointer' }} onClick={() => navigate(`/agents/${agentId}`)}>
                            {agentNames.get(agentId) || agentId}
                          </Badge>
                        ))}
                      </Group>
                    </Table.Td>
                    <Table.Td><Group gap={4}>{item.supported_runtimes.map((runtime) => <Badge key={runtime} variant="outline">{runtime}</Badge>)}</Group></Table.Td>
                    <Table.Td><Text size="sm">{item.required_commands.length} commands · {item.required_credentials.length} credential references</Text></Table.Td>
                    <Table.Td><SummaryBadges item={item} /></Table.Td>
                    <Table.Td><Button variant="subtle" size="compact-sm" leftSection={<IconEye size={14} />} onClick={() => setSelected(item)}>View details</Button></Table.Td>
                  </Table.Tr>
                ))}
              </Table.Tbody>
            </Table>
          </Table.ScrollContainer>
        </Paper>
      )}

      <Modal opened={Boolean(selected)} onClose={() => setSelected(null)} title={selected ? `${selected.key} · ${selected.version}` : 'Skill details'} size="xl">
        {detailQuery.isLoading && <Stack>{Array.from({ length: 3 }).map((_, index) => <Skeleton key={index} height={72} />)}</Stack>}
        {detailQuery.isError && <Alert color="red" icon={<IconAlertTriangle size={16} />} title="Skill detail unavailable">The selected skill version could not be loaded.</Alert>}
        {!detailQuery.isLoading && !detailQuery.isError && !detail && <Alert color="orange" title="Unknown skill version">The selected immutable version is no longer present in the registry response.</Alert>}
        {detail && (
          <Stack gap="lg">
            <Text>{detail.description}</Text>
            <Group><Badge variant="light">Schema-backed metadata</Badge>{detail.supported_runtimes.map((runtime) => <Badge key={runtime} variant="outline">{runtime}</Badge>)}</Group>
            <Box><Text fw={600} mb={6}>Declared permissions</Text><Group gap={4}>{detail.permissions.map((permission) => <Badge key={permission} variant="light" color="gray">{permission}</Badge>)}</Group></Box>
            <Box><Text fw={600} mb={6}>Required commands</Text><Group gap={4}>{detail.required_commands.length ? detail.required_commands.map((command) => <Badge key={command} variant="outline">{command}</Badge>) : <Text size="sm" c="dimmed">None declared</Text>}</Group></Box>
            <Box><Text fw={600} mb={6}>Credential references</Text><Group gap={4}>{detail.required_credentials.length ? detail.required_credentials.map((reference) => <Badge key={reference} variant="outline">{reference}</Badge>) : <Text size="sm" c="dimmed">None declared</Text>}</Group></Box>
            <Table.ScrollContainer minWidth={760}>
              <Table verticalSpacing="sm">
                <Table.Thead><Table.Tr><Table.Th>Agent</Table.Th><Table.Th>Runtime</Table.Th><Table.Th>Resolution</Table.Th><Table.Th>Compatibility</Table.Th><Table.Th>Reasons</Table.Th></Table.Tr></Table.Thead>
                <Table.Tbody>
                  {detail.assignments.map((assignment) => (
                    <Table.Tr key={assignment.agent_id}>
                      <Table.Td><Button variant="transparent" size="compact-sm" leftSection={<IconUsers size={14} />} onClick={() => navigate(`/agents/${assignment.agent_id}`)}>{agentNames.get(assignment.agent_id) || assignment.agent_id}</Button></Table.Td>
                      <Table.Td><Badge variant="outline">{assignment.runtime_backend}</Badge></Table.Td>
                      <Table.Td><Badge color={assignment.resolution_status === 'resolved' ? 'teal' : 'orange'}>{assignment.resolution_status}</Badge></Table.Td>
                      <Table.Td><Badge color={compatibilityColor(assignment.compatibility.status)}>{assignment.compatibility.status}</Badge></Table.Td>
                      <Table.Td>{assignment.compatibility.reasons.length ? <Stack gap={2}>{assignment.compatibility.reasons.map((reason) => <Text key={`${reason.code}:${reason.subject || ''}`} size="xs">{reason.code}{reason.subject ? ` · ${reason.subject}` : ''}</Text>)}</Stack> : <Text size="xs" c="dimmed">No incompatibility reasons</Text>}</Table.Td>
                    </Table.Tr>
                  ))}
                </Table.Tbody>
              </Table>
            </Table.ScrollContainer>
            <Alert color="gray" variant="light">Credential status reports presence only. No value, prefix, length, hash, or environment content is returned.</Alert>
          </Stack>
        )}
      </Modal>
    </Stack>
  );
}
