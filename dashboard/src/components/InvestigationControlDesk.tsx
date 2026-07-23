import {
  Alert,
  Box,
  Button,
  Group,
  Paper,
  Select,
  Skeleton,
  Stack,
  Text,
  ThemeIcon,
  Title,
} from '@mantine/core';
import { useQuery } from '@tanstack/react-query';
import { IconAlertTriangle, IconRefresh, IconShieldCheck } from '@tabler/icons-react';
import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';

import { missionsApi } from '../api/missions';
import { InvestigationControlPanel } from './InvestigationControlPanel';

export function InvestigationControlDesk() {
  const [missionId, setMissionId] = useState<string | null>(null);
  const missionsQuery = useQuery({
    queryKey: ['missions'],
    queryFn: missionsApi.listMissions,
    refetchInterval: 10_000,
  });

  const candidates = useMemo(
    () => (missionsQuery.data?.missions || [])
      .filter((mission) => !mission.unavailable && mission.workflow_id)
      .sort((left, right) => {
        if (left.state === 'needs_human' && right.state !== 'needs_human') return -1;
        if (right.state === 'needs_human' && left.state !== 'needs_human') return 1;
        return String(right.updated_at || '').localeCompare(String(left.updated_at || ''));
      }),
    [missionsQuery.data?.missions],
  );

  useEffect(() => {
    if (missionId && candidates.some((mission) => mission.mission_id === missionId)) return;
    setMissionId(candidates[0]?.mission_id || null);
  }, [candidates, missionId]);

  const roomQuery = useQuery({
    queryKey: ['mission-room', missionId],
    queryFn: () => missionsApi.getMission(String(missionId)),
    enabled: Boolean(missionId),
    refetchInterval: missionId ? 10_000 : false,
  });

  return (
    <Paper withBorder p="lg">
      <Stack gap="md">
        <Group justify="space-between" align="flex-start" wrap="wrap">
          <Group gap="sm" align="flex-start">
            <ThemeIcon variant="light" color="orange" size={40} radius="md"><IconShieldCheck size={21} /></ThemeIcon>
            <Box>
              <Title order={3}>Investigation control desk</Title>
              <Text size="sm" c="dimmed" mt={3}>
                Select a Mission to resolve uncertain effects and govern workspace holds through exact server-owned contracts.
              </Text>
            </Box>
          </Group>
          <Button
            variant="default"
            size="sm"
            leftSection={<IconRefresh size={15} />}
            loading={missionsQuery.isFetching || roomQuery.isFetching}
            onClick={() => {
              void missionsQuery.refetch();
              if (missionId) void roomQuery.refetch();
            }}
          >
            Refresh investigations
          </Button>
        </Group>

        {missionsQuery.isLoading ? (
          <Skeleton height={84} />
        ) : missionsQuery.isError ? (
          <Alert color="red" icon={<IconAlertTriangle size={17} />} title="Investigation controls unavailable">
            Mission evidence could not be loaded. No effect or workspace action was attempted.
          </Alert>
        ) : candidates.length === 0 ? (
          <Text size="sm" c="dimmed">No Mission with durable workflow evidence is available for investigation controls.</Text>
        ) : (
          <Group align="flex-end" wrap="wrap">
            <Select
              label="Mission investigation"
              description="Needs-human Missions are shown first."
              searchable
              value={missionId}
              onChange={setMissionId}
              data={candidates.map((mission) => ({
                value: mission.mission_id,
                label: `${mission.title} · ${mission.state.replaceAll('_', ' ')}`,
              }))}
              style={{ flex: 1, minWidth: 280 }}
            />
            {missionId && (
              <Button component={Link} to={`/missions/${encodeURIComponent(missionId)}`} variant="subtle">
                Open Mission Room
              </Button>
            )}
          </Group>
        )}

        {missionId && roomQuery.isLoading && <Skeleton height={220} />}
        {missionId && roomQuery.isError && (
          <Alert color="red" icon={<IconAlertTriangle size={17} />} title="Investigation evidence unavailable">
            The selected Mission Room could not be loaded. No legal action has been inferred.
          </Alert>
        )}
        {roomQuery.data?.room && <InvestigationControlPanel room={roomQuery.data.room} compact />}
      </Stack>
    </Paper>
  );
}
