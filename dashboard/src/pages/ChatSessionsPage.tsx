import {
  Alert,
  Badge,
  Box,
  Button,
  Checkbox,
  Code,
  Group,
  Paper,
  SegmentedControl,
  SimpleGrid,
  Skeleton,
  Stack,
  Table,
  Text,
  ThemeIcon,
  Title,
} from '@mantine/core';
import { useQuery } from '@tanstack/react-query';
import {
  IconAlertTriangle,
  IconMessageCircle2,
  IconRefresh,
  IconRoute,
  IconShieldCheck,
  IconUser,
} from '@tabler/icons-react';
import { useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';

import {
  chatSessionsApi,
  type ChatSessionIndexItem,
  type ChatSessionState,
  type ChatSessionType,
} from '../api/chat-sessions';
import { useOperatorAuth } from '../operator-auth';

function label(value: string | null | undefined) {
  return String(value || 'unavailable').replaceAll('_', ' ');
}

function stateColor(state: ChatSessionState) {
  if (state === 'open') return 'teal';
  if (state === 'needs_human') return 'orange';
  return 'gray';
}

function timeLabel(value: string | null | undefined) {
  if (!value) return 'Time unavailable';
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return parsed.toLocaleString();
}

function rolesAllowChat(roles: readonly string[]) {
  return roles.includes('operator') || roles.includes('administrator');
}

function SessionTypeBadge({ type }: { type: ChatSessionType }) {
  return (
    <Badge variant="light" color={type === 'direct' ? 'blue' : 'violet'}>
      {type === 'direct' ? 'Direct' : 'Mission'}
    </Badge>
  );
}

function ownerLabel(session: ChatSessionIndexItem) {
  if (session.session_type === 'direct') return session.agent_id || 'Agent unavailable';
  return session.mission_id || 'Mission unavailable';
}

export function ChatSessionsPage() {
  const auth = useOperatorAuth();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const selectedSessionId = searchParams.get('session');
  const roles = auth.session?.session.roles || [];
  const canRead = auth.mode === 'session' && rolesAllowChat(roles);
  const [type, setType] = useState<ChatSessionType | 'all'>('all');
  const [state, setState] = useState<ChatSessionState | 'all'>('all');
  const [attentionOnly, setAttentionOnly] = useState(false);

  const query = useQuery({
    queryKey: ['chat-sessions', type, state, attentionOnly],
    queryFn: () => chatSessionsApi.list({ type, state, attention: attentionOnly, limit: 200 }),
    enabled: canRead,
    refetchInterval: canRead ? 15_000 : false,
  });

  if (auth.mode === 'legacy') {
    return (
      <Alert color="orange" icon={<IconAlertTriangle size={18} />} title="Human session required">
        Dashboard-token mode cannot read governed chat-session evidence.
      </Alert>
    );
  }

  if (!rolesAllowChat(roles)) {
    return (
      <Alert color="orange" icon={<IconAlertTriangle size={18} />} title="Agent chat permission required">
        This account does not have the <Code>agent.chat</Code> permission.
      </Alert>
    );
  }

  const data = query.data;
  const sessions = data?.sessions || [];

  return (
    <Stack gap="lg">
      <Group justify="space-between" align="flex-start" wrap="wrap">
        <Box>
          <Title order={1} className="page-title">Chat sessions</Title>
          <Text c="dimmed" mt={6}>
            Transcript-free lifecycle evidence across direct and Mission-bound conversations.
          </Text>
        </Box>
        <Button variant="default" leftSection={<IconRefresh size={16} />} loading={query.isFetching} onClick={() => query.refetch()}>
          Refresh
        </Button>
      </Group>

      <Alert color="blue" variant="light" icon={<IconShieldCheck size={18} />} title="Bounded session evidence">
        This index shows ownership, state, turn counts, attention codes, timestamps, and navigation only. Transcript and provider response text remain in the exact session view.
      </Alert>

      <Paper withBorder p="md">
        <Group justify="space-between" align="flex-end" wrap="wrap">
          <Stack gap={5}>
            <Text size="sm" fw={700}>Conversation type</Text>
            <SegmentedControl
              value={type}
              onChange={(value) => setType(value as ChatSessionType | 'all')}
              data={[
                { label: 'All', value: 'all' },
                { label: 'Direct', value: 'direct' },
                { label: 'Mission', value: 'mission' },
              ]}
            />
          </Stack>
          <Stack gap={5}>
            <Text size="sm" fw={700}>Lifecycle state</Text>
            <SegmentedControl
              value={state}
              onChange={(value) => setState(value as ChatSessionState | 'all')}
              data={[
                { label: 'All', value: 'all' },
                { label: 'Open', value: 'open' },
                { label: 'Needs human', value: 'needs_human' },
                { label: 'Closed', value: 'closed' },
              ]}
            />
          </Stack>
          <Checkbox
            checked={attentionOnly}
            onChange={(event) => setAttentionOnly(event.currentTarget.checked)}
            label="Attention only"
          />
        </Group>
      </Paper>

      {query.isLoading ? (
        <Stack gap="md">{Array.from({ length: 4 }).map((_, index) => <Skeleton key={index} height={92} />)}</Stack>
      ) : query.isError || !data ? (
        <Alert color="red" icon={<IconAlertTriangle size={18} />} title="Chat session index unavailable">
          The unified session evidence could not be loaded. No transcript or mutation request was attempted.
        </Alert>
      ) : (
        <>
          <SimpleGrid cols={{ base: 2, md: 4 }} spacing="md">
            <Paper withBorder p="md"><Text size="xs" c="dimmed">Matching</Text><Text fz={24} fw={700}>{data.total_matching}</Text></Paper>
            <Paper withBorder p="md"><Text size="xs" c="dimmed">Needs human</Text><Text fz={24} fw={700}>{data.attention_count}</Text></Paper>
            <Paper withBorder p="md"><Text size="xs" c="dimmed">Direct source</Text><Badge mt={6} variant="light">{label(data.sources.direct_sessions)}</Badge></Paper>
            <Paper withBorder p="md"><Text size="xs" c="dimmed">Mission source</Text><Badge mt={6} variant="light">{label(data.sources.mission_sessions)}</Badge></Paper>
          </SimpleGrid>

          <Paper withBorder p="lg">
            {sessions.length === 0 ? (
              <Stack align="center" py={48} gap="sm">
                <ThemeIcon size={48} radius="xl" variant="light"><IconMessageCircle2 size={24} /></ThemeIcon>
                <Text fw={700}>No sessions match these filters</Text>
                <Text size="sm" c="dimmed">Closed historical sessions remain available when the lifecycle filter includes them.</Text>
              </Stack>
            ) : (
              <Table.ScrollContainer minWidth={980}>
                <Table highlightOnHover verticalSpacing="md">
                  <Table.Thead>
                    <Table.Tr>
                      <Table.Th>Session</Table.Th>
                      <Table.Th>State</Table.Th>
                      <Table.Th>Owner</Table.Th>
                      <Table.Th>Latest turn</Table.Th>
                      <Table.Th>Updated</Table.Th>
                      <Table.Th>Action</Table.Th>
                    </Table.Tr>
                  </Table.Thead>
                  <Table.Tbody>
                    {sessions.map((session) => (
                      <Table.Tr key={session.session_id} bg={selectedSessionId === session.session_id ? 'var(--mantine-color-violet-light)' : undefined}>
                        <Table.Td>
                          <Group gap="sm" wrap="nowrap">
                            <ThemeIcon variant="light" color={session.session_type === 'direct' ? 'blue' : 'violet'}>
                              {session.session_type === 'direct' ? <IconUser size={17} /> : <IconRoute size={17} />}
                            </ThemeIcon>
                            <Box style={{ minWidth: 0 }}>
                              <Group gap={6}><Text size="sm" fw={700} truncate>{session.title}</Text><SessionTypeBadge type={session.session_type} /></Group>
                              <Text size="xs" c="dimmed" ff="monospace" truncate>{session.session_id}</Text>
                            </Box>
                          </Group>
                        </Table.Td>
                        <Table.Td>
                          <Stack gap={4} align="flex-start">
                            <Badge color={stateColor(session.state)} variant="light">{label(session.state)}</Badge>
                            {session.attention_code && <Text size="xs" c="orange">{label(session.attention_code)}</Text>}
                          </Stack>
                        </Table.Td>
                        <Table.Td>
                          <Text size="sm" fw={600}>{ownerLabel(session)}</Text>
                          <Text size="xs" c="dimmed">{session.participant_ids.join(', ') || 'No participants'}</Text>
                        </Table.Td>
                        <Table.Td>
                          <Text size="sm">{session.turn_count} turn{session.turn_count === 1 ? '' : 's'}</Text>
                          <Text size="xs" c="dimmed">
                            {session.latest_turn ? `${label(session.latest_turn.state)}${session.latest_turn.target_agent_id ? ` · ${session.latest_turn.target_agent_id}` : ''}` : 'No turn yet'}
                          </Text>
                        </Table.Td>
                        <Table.Td><Text size="sm" c="dimmed">{timeLabel(session.updated_at)}</Text></Table.Td>
                        <Table.Td>
                          <Button size="compact-sm" variant={session.attention_required ? 'light' : 'subtle'} color={session.attention_required ? 'orange' : 'violet'} onClick={() => navigate(session.links.transcript)}>
                            Open exact session
                          </Button>
                        </Table.Td>
                      </Table.Tr>
                    ))}
                  </Table.Tbody>
                </Table>
              </Table.ScrollContainer>
            )}
          </Paper>
        </>
      )}
    </Stack>
  );
}
