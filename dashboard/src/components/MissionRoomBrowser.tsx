import {
  Alert,
  Badge,
  Box,
  Button,
  Group,
  Paper,
  Stack,
  Text,
  ThemeIcon,
  Title,
} from '@mantine/core';
import { useQuery } from '@tanstack/react-query';
import { IconChevronRight, IconRoute, IconShieldCheck } from '@tabler/icons-react';
import { useNavigate } from 'react-router-dom';

import { missionsApi } from '../api/missions';

export function MissionRoomBrowser() {
  const navigate = useNavigate();
  const query = useQuery({
    queryKey: ['missions'],
    queryFn: missionsApi.listMissions,
    refetchInterval: 10_000,
  });
  const available = query.data?.missions.filter((mission) => !mission.unavailable) || [];
  const attention = available.filter((mission) => mission.state === 'needs_human').length;

  return (
    <Paper withBorder p="lg">
      <Stack gap="md">
        <Group justify="space-between" align="flex-start" wrap="wrap">
          <Group gap="sm" align="flex-start">
            <ThemeIcon variant="light" color="violet" size={38} radius="md"><IconRoute size={20} /></ThemeIcon>
            <Box>
              <Title order={3}>Mission Rooms</Title>
              <Text size="sm" c="dimmed" mt={3}>
                Missions now have a dedicated navigation area and URL-addressable room for durable workflow evidence.
              </Text>
            </Box>
          </Group>
          <Group gap={6}>
            <Badge variant="light" color="violet">{available.length} missions</Badge>
            {attention > 0 && <Badge variant="light" color="orange">{attention} attention</Badge>}
          </Group>
        </Group>

        <Alert color="blue" variant="light" icon={<IconShieldCheck size={18} />} title="First-class Mission navigation">
          Open the Missions page to search objectives, bookmark exact Mission Room URLs, and inspect the same bounded read-only evidence used here.
        </Alert>

        <Group justify="flex-end">
          <Button rightSection={<IconChevronRight size={15} />} onClick={() => navigate('/missions')}>
            Open Missions
          </Button>
        </Group>
      </Stack>
    </Paper>
  );
}
