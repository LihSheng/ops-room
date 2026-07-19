import {
  Alert,
  Badge,
  Box,
  Group,
  Paper,
  Skeleton,
  Stack,
  Table,
  Text,
  ThemeIcon,
  Title,
} from '@mantine/core';
import {
  IconAlertTriangle,
  IconDatabase,
  IconEye,
  IconPencil,
} from '@tabler/icons-react';
import { useNavigate } from 'react-router-dom';
import { useMemorySpaces } from '../hooks/use-memory-spaces';
import { useAgentProfiles } from '../hooks/use-agent-profiles';

function kindColor(kind: string) {
  if (kind === 'project') return 'blue';
  if (kind === 'shared') return 'teal';
  if (kind === 'private-agent') return 'orange';
  return 'gray';
}

export function MemorySpacesPage() {
  const memoryQuery = useMemorySpaces();
  const profilesQuery = useAgentProfiles();
  const navigate = useNavigate();

  const profiles = profilesQuery.data?.profiles || [];
  const agentNames = new Map(profiles.map((profile) => [profile.id, profile.display_name]));

  if (memoryQuery.isLoading) {
    return (
      <Stack gap="lg">
        <Skeleton height={48} radius="md" />
        {Array.from({ length: 3 }).map((_, index) => <Skeleton key={index} height={100} radius="lg" />)}
      </Stack>
    );
  }

  if (memoryQuery.isError) {
    return (
      <Stack gap="lg">
        <Box>
          <Title order={1} className="page-title">Memory Spaces</Title>
          <Text c="dimmed" mt={6}>Governed memory-space registry.</Text>
        </Box>
        <Alert color="red" title="Memory registry unavailable" icon={<IconAlertTriangle size={18} />}>
          The validated memory-space registry could not be loaded. No vault access or mutation was attempted.
        </Alert>
      </Stack>
    );
  }

  const spaces = memoryQuery.data?.memory_spaces || [];
  const count = memoryQuery.data?.count || 0;

  return (
    <Stack gap="lg">
      <Box>
        <Group justify="space-between" align="flex-start">
          <Box>
            <Title order={1} className="page-title">Memory Spaces</Title>
            <Text c="dimmed" mt={6}>Validated Git-backed governance for curated Obsidian publication spaces.</Text>
          </Box>
          <Badge variant="light" color="violet" size="lg">{count} spaces</Badge>
        </Group>
      </Box>

      <Alert color="violet" variant="light" icon={<IconDatabase size={18} />} title="Policy registry, not a memory service">
        Ops Room validates logical keys, curated relative publication paths, ownership, write policy, and future provenance requirements. It does not browse notes, inspect the whole vault, perform memory search, or write to Obsidian.
      </Alert>

      {spaces.length === 0 ? (
        <Paper withBorder p="xl">
          <Stack align="center" gap={8}>
            <ThemeIcon size={44} radius="xl" variant="light" color="gray"><IconDatabase size={21} /></ThemeIcon>
            <Text fw={600}>No approved memory spaces</Text>
            <Text size="sm" c="dimmed">The memory-space registry contains no validated manifests.</Text>
          </Stack>
        </Paper>
      ) : (
        <Paper withBorder p="lg">
          <Table.ScrollContainer minWidth={1100}>
            <Table verticalSpacing="md" highlightOnHover>
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>Space</Table.Th>
                  <Table.Th>Type</Table.Th>
                  <Table.Th>Publication path</Table.Th>
                  <Table.Th>Governance</Table.Th>
                  <Table.Th>Readers</Table.Th>
                  <Table.Th>Writers</Table.Th>
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {spaces.map((space) => (
                  <Table.Tr key={space.key}>
                    <Table.Td>
                      <Group gap="sm" wrap="nowrap">
                        <ThemeIcon variant="light" color="violet" size={28}><IconDatabase size={14} /></ThemeIcon>
                        <Box>
                          <Text size="sm" fw={600}>{space.display_name}</Text>
                          <Text size="xs" ff="monospace" c="dimmed">{space.key}@{space.version}</Text>
                        </Box>
                      </Group>
                    </Table.Td>
                    <Table.Td>
                      <Stack gap={4} align="flex-start">
                        <Badge variant="light" color={kindColor(space.kind)}>{space.kind}</Badge>
                        {space.owner_agent && <Text size="xs" c="dimmed">Owner: {agentNames.get(space.owner_agent) || space.owner_agent}</Text>}
                      </Stack>
                    </Table.Td>
                    <Table.Td>
                      <Stack gap={3}>
                        <Text size="sm" ff="monospace">{space.publication_path}</Text>
                        {space.parent_key && <Text size="xs" c="dimmed">Child of {space.parent_key}</Text>}
                      </Stack>
                    </Table.Td>
                    <Table.Td>
                      <Stack gap={4} align="flex-start">
                        <Badge variant="outline" color={space.write_policy === 'read-only' ? 'gray' : 'orange'}>{space.write_policy}</Badge>
                        <Text size="xs" c="dimmed">
                          {space.provenance.review_required ? 'Review required' : 'No write workflow'}
                          {space.provenance.required_fields.length > 0 ? ` · ${space.provenance.required_fields.length} provenance fields` : ''}
                        </Text>
                      </Stack>
                    </Table.Td>
                    <Table.Td>
                      <Group gap={4}>
                        {space.readers.length > 0 ? space.readers.map((agentId) => (
                          <Badge
                            key={agentId}
                            variant="light"
                            color="blue"
                            leftSection={<IconEye size={12} />}
                            style={{ cursor: 'pointer' }}
                            onClick={() => navigate(`/agents/${agentId}`)}
                          >
                            {agentNames.get(agentId) || agentId}
                          </Badge>
                        )) : <Text size="sm" c="dimmed">None</Text>}
                      </Group>
                    </Table.Td>
                    <Table.Td>
                      <Group gap={4}>
                        {space.writers.length > 0 ? space.writers.map((agentId) => (
                          <Badge
                            key={agentId}
                            variant="light"
                            color="orange"
                            leftSection={<IconPencil size={12} />}
                            style={{ cursor: 'pointer' }}
                            onClick={() => navigate(`/agents/${agentId}`)}
                          >
                            {agentNames.get(agentId) || agentId}
                          </Badge>
                        )) : <Text size="sm" c="dimmed">None</Text>}
                      </Group>
                    </Table.Td>
                  </Table.Tr>
                ))}
              </Table.Tbody>
            </Table>
          </Table.ScrollContainer>
        </Paper>
      )}
    </Stack>
  );
}
