import {
  Alert,
  Box,
  Button,
  Code,
  Group,
  Paper,
  Skeleton,
  Stack,
  Text,
  ThemeIcon,
  Title,
} from '@mantine/core';
import { useQuery } from '@tanstack/react-query';
import {
  IconAlertTriangle,
  IconArrowLeft,
  IconRefresh,
  IconRoute,
} from '@tabler/icons-react';
import { useNavigate, useParams } from 'react-router-dom';

import { MissionApiError, missionsApi } from '../api/missions';
import { MissionRoomContent, missionLabel, missionStateColor } from '../components/MissionRoomContent';

function MissionSummaryFallback({ mission, errorCode }: {
  mission: Awaited<ReturnType<typeof missionsApi.getMission>>['mission'];
  errorCode: string | null;
}) {
  return (
    <Stack gap="lg">
      <Paper withBorder p="lg">
        <Group justify="space-between" align="flex-start" wrap="wrap">
          <Box>
            <Title order={2}>{mission.title}</Title>
            <Text c="dimmed" mt={6}>{mission.objective}</Text>
          </Box>
          <Text size="sm" fw={700} c={missionStateColor(mission.state)}>{missionLabel(mission.state)}</Text>
        </Group>
        <Group gap="xl" mt="lg" align="flex-start" wrap="wrap">
          <Box><Text size="xs" c="dimmed">Mission ID</Text><Code>{mission.mission_id}</Code></Box>
          <Box><Text size="xs" c="dimmed">Repository</Text><Text size="sm" fw={600}>{mission.repository_id || 'Unavailable'}</Text></Box>
          <Box><Text size="xs" c="dimmed">Workflow</Text><Text size="sm" fw={600}>{mission.workflow_id || 'Not bound'}</Text></Box>
        </Group>
      </Paper>
      <Alert color="orange" variant="light" icon={<IconAlertTriangle size={18} />} title="Mission Room evidence unavailable">
        {missionLabel(errorCode || 'mission_room_unavailable')}. The durable Mission remains visible, but missing Workflow evidence has not been inferred.
      </Alert>
    </Stack>
  );
}

export function MissionRoomPage() {
  const navigate = useNavigate();
  const { missionId } = useParams<{ missionId: string }>();
  const normalizedId = String(missionId || '').trim();
  const query = useQuery({
    queryKey: ['mission-room', normalizedId],
    queryFn: () => missionsApi.getMission(normalizedId),
    enabled: Boolean(normalizedId),
    refetchInterval: normalizedId ? 10_000 : false,
    retry: (failureCount, error) => {
      if (error instanceof MissionApiError && [400, 404].includes(error.status)) return false;
      return failureCount < 2;
    },
  });

  const apiError = query.error instanceof MissionApiError ? query.error : null;
  const notFound = apiError?.status === 404;
  const invalid = apiError?.status === 400 || !normalizedId;

  return (
    <Stack gap="lg">
      <Group justify="space-between" align="flex-start" wrap="wrap">
        <Group gap="sm">
          <Button variant="default" size="compact-md" leftSection={<IconArrowLeft size={16} />} onClick={() => navigate('/missions')}>
            Missions
          </Button>
          <ThemeIcon variant="light" color="violet" size={40} radius="md"><IconRoute size={22} /></ThemeIcon>
          <Box>
            <Title order={1} className="page-title">Mission Room</Title>
            <Text c="dimmed" mt={4}>A URL-addressable view of one durable Mission and its deterministic workflow evidence.</Text>
          </Box>
        </Group>
        <Button variant="default" leftSection={<IconRefresh size={16} />} loading={query.isFetching} disabled={!normalizedId} onClick={() => query.refetch()}>
          Refresh
        </Button>
      </Group>

      {query.isLoading ? (
        <Stack gap="md"><Skeleton height={150} radius="md" /><Skeleton height={420} radius="md" /></Stack>
      ) : invalid ? (
        <Alert color="red" icon={<IconAlertTriangle size={18} />} title="Invalid Mission route">
          The Mission identifier is missing or invalid. Return to the Missions list and open a durable record.
        </Alert>
      ) : notFound ? (
        <Alert color="orange" icon={<IconAlertTriangle size={18} />} title="Mission not found">
          No durable Mission record matches this URL. The route remains visible so a copied or bookmarked link does not silently redirect elsewhere.
        </Alert>
      ) : query.isError ? (
        <Alert color="red" icon={<IconAlertTriangle size={18} />} title="Mission Room unavailable">
          The authenticated Mission Room read contract could not be loaded. No workflow or external-effect state was inferred.
        </Alert>
      ) : query.data?.room ? (
        <MissionRoomContent room={query.data.room} />
      ) : query.data?.mission ? (
        <MissionSummaryFallback mission={query.data.mission} errorCode={query.data.room_error_code} />
      ) : (
        <Alert color="orange" icon={<IconAlertTriangle size={18} />} title="Mission evidence unavailable">
          The route returned no bounded Mission record.
        </Alert>
      )}
    </Stack>
  );
}
