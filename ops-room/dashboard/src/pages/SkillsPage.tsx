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
import { IconAlertTriangle, IconCode, IconSearch, IconUsers } from '@tabler/icons-react';
import { useNavigate } from 'react-router-dom';
import { useSkills } from '../hooks/use-skills';
import { useAgentProfiles } from '../hooks/use-agent-profiles';

export function SkillsPage() {
  const skillsQuery = useSkills();
  const profilesQuery = useAgentProfiles();
  const navigate = useNavigate();

  const profiles = profilesQuery.data?.profiles || [];
  const agentNames = new Map(profiles.map((p) => [p.id, p.display_name]));

  if (skillsQuery.isLoading) {
    return (
      <Stack gap="lg">
        <Skeleton height={48} radius="md" />
        {Array.from({ length: 3 }).map((_, i) => <Skeleton key={i} height={80} radius="lg" />)}
      </Stack>
    );
  }

  if (skillsQuery.isError) {
    return (
      <Stack gap="lg">
        <Box>
          <Title order={1} className="page-title">Skills</Title>
          <Text c="dimmed" mt={6}>Declared skill catalog.</Text>
        </Box>
        <Alert color="red" title="Skills catalog unavailable" icon={<IconAlertTriangle size={18} />}>
          The skills API could not be loaded. No profile mutation was attempted.
        </Alert>
      </Stack>
    );
  }

  const skills = skillsQuery.data?.skills || [];
  const count = skillsQuery.data?.count || 0;

  return (
    <Stack gap="lg">
      <Box>
        <Group justify="space-between" align="flex-start">
          <Box>
            <Title order={1} className="page-title">Skills</Title>
            <Text c="dimmed" mt={6}>Read-only catalog of skills declared by validated agent profiles.</Text>
          </Box>
          <Badge variant="light" color="violet" size="lg">{count} skills</Badge>
        </Group>
      </Box>

      <Alert color="violet" variant="light" icon={<IconCode size={18} />} title="Declared by profiles">
        These skills are profile declarations only. Ops Room does not execute, install, or materialize them. Use wording such as "Declared by profiles" rather than "Installed".
      </Alert>

      {skills.length === 0 ? (
        <Paper withBorder p="xl">
          <Stack align="center" gap={8}>
            <ThemeIcon size={44} radius="xl" variant="light" color="gray"><IconSearch size={21} /></ThemeIcon>
            <Text fw={600}>No skills declared</Text>
            <Text size="sm" c="dimmed">No agent profiles have declared any skills yet.</Text>
          </Stack>
        </Paper>
      ) : (
        <Paper withBorder p="lg">
          <Table.ScrollContainer minWidth={500}>
            <Table verticalSpacing="md" highlightOnHover>
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>Skill key</Table.Th>
                  <Table.Th>Declared by</Table.Th>
                  <Table.Th>Agent count</Table.Th>
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {skills.map((item) => (
                  <Table.Tr key={item.key}>
                    <Table.Td>
                      <Group gap="sm" wrap="nowrap">
                        <ThemeIcon variant="light" color="violet" size={28}><IconCode size={14} /></ThemeIcon>
                        <Text size="sm" fw={600} ff="monospace">{item.key}</Text>
                      </Group>
                    </Table.Td>
                    <Table.Td>
                      <Group gap={4}>
                        {item.agents.map((agentId) => (
                          <Badge
                            key={agentId}
                            variant="light"
                            color="violet"
                            style={{ cursor: 'pointer' }}
                            onClick={() => navigate(`/agents/${agentId}`)}
                          >
                            {agentNames.get(agentId) || agentId}
                          </Badge>
                        ))}
                      </Group>
                    </Table.Td>
                    <Table.Td>
                      <Group gap={6}>
                        <ThemeIcon variant="light" color="gray" size={22}><IconUsers size={12} /></ThemeIcon>
                        <Text size="sm" fw={500}>{item.agents.length}</Text>
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
