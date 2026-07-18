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
  IconUsers,
} from '@tabler/icons-react';
import { useNavigate } from 'react-router-dom';
import { useMemorySpaces } from '../hooks/use-memory-spaces';
import { useAgentProfiles } from '../hooks/use-agent-profiles';

export function MemorySpacesPage() {
  const memoryQuery = useMemorySpaces();
  const profilesQuery = useAgentProfiles();
  const navigate = useNavigate();

  const profiles = profilesQuery.data?.profiles || [];
  const agentNames = new Map(profiles.map((p) => [p.id, p.display_name]));

  if (memoryQuery.isLoading) {
    return (
      <Stack gap="lg">
        <Skeleton height={48} radius="md" />
        {Array.from({ length: 3 }).map((_, i) => <Skeleton key={i} height={100} radius="lg" />)}
      </Stack>
    );
  }

  if (memoryQuery.isError) {
    return (
      <Stack gap="lg">
        <Box>
          <Title order={1} className="page-title">Memory Spaces</Title>
          <Text c="dimmed" mt={6}>Declared memory policy catalog.</Text>
        </Box>
        <Alert color="red" title="Memory spaces catalog unavailable" icon={<IconAlertTriangle size={18} />}>
          The memory spaces API could not be loaded. No profile mutation was attempted.
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
            <Text c="dimmed" mt={6}>Read-only catalog of memory scopes declared by validated agent profiles.</Text>
          </Box>
          <Badge variant="light" color="violet" size="lg">{count} scopes</Badge>
        </Group>
      </Box>

      <Alert color="violet" variant="light" icon={<IconDatabase size={18} />} title="Declared policy scopes">
        These scopes are declarations from validated agent profiles. Ops Room does not inspect or verify the Obsidian vault through this page. It does not browse the vault, read note contents, check path existence, perform memory search, add write controls, or expose absolute host paths.
      </Alert>

      {spaces.length === 0 ? (
        <Paper withBorder p="xl">
          <Stack align="center" gap={8}>
            <ThemeIcon size={44} radius="xl" variant="light" color="gray"><IconDatabase size={21} /></ThemeIcon>
            <Text fw={600}>No memory scopes declared</Text>
            <Text size="sm" c="dimmed">No agent profiles have declared memory read or write scopes yet.</Text>
          </Stack>
        </Paper>
      ) : (
        <Paper withBorder p="lg">
          <Table.ScrollContainer minWidth={700}>
            <Table verticalSpacing="md" highlightOnHover>
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>Scope key</Table.Th>
                  <Table.Th>Readers</Table.Th>
                  <Table.Th>Reader count</Table.Th>
                  <Table.Th>Writers</Table.Th>
                  <Table.Th>Writer count</Table.Th>
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {spaces.map((space) => (
                  <Table.Tr key={space.key}>
                    <Table.Td>
                      <Group gap="sm" wrap="nowrap">
                        <ThemeIcon variant="light" color="violet" size={28}><IconDatabase size={14} /></ThemeIcon>
                        <Text size="sm" fw={600} ff="monospace">{space.key}</Text>
                      </Group>
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
                      <Group gap={6}>
                        <ThemeIcon variant="light" color="gray" size={22}><IconUsers size={12} /></ThemeIcon>
                        <Text size="sm" fw={500}>{space.readers.length}</Text>
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
                    <Table.Td>
                      <Group gap={6}>
                        <ThemeIcon variant="light" color="gray" size={22}><IconUsers size={12} /></ThemeIcon>
                        <Text size="sm" fw={500}>{space.writers.length}</Text>
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
