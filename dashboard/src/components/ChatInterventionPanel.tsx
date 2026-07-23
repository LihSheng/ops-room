import {
  Alert,
  Badge,
  Box,
  Button,
  Code,
  Group,
  Paper,
  SimpleGrid,
  Skeleton,
  Stack,
  Text,
  ThemeIcon,
  Title,
} from '@mantine/core';
import { useQuery } from '@tanstack/react-query';
import { IconAlertTriangle, IconMessageCircleExclamation, IconShieldCheck } from '@tabler/icons-react';
import { Link } from 'react-router-dom';

import { chatSessionsApi } from '../api/chat-sessions';
import { useOperatorAuth } from '../operator-auth';

function label(value: string | null | undefined) {
  return String(value || 'unavailable').replaceAll('_', ' ');
}

function rolesAllowChat(roles: readonly string[]) {
  return roles.includes('operator') || roles.includes('administrator');
}

export function ChatInterventionPanel() {
  const auth = useOperatorAuth();
  const roles = auth.session?.session.roles || [];
  const canRead = auth.mode === 'session' && rolesAllowChat(roles);
  const query = useQuery({
    queryKey: ['chat-sessions', 'attention'],
    queryFn: () => chatSessionsApi.list({ attention: true, limit: 100 }),
    enabled: canRead,
    refetchInterval: canRead ? 15_000 : false,
  });

  if (!canRead) return null;

  return (
    <Paper withBorder p="lg" id="chat-needs-human">
      <Stack gap="md">
        <Group justify="space-between" align="flex-start" wrap="wrap">
          <Group gap="sm" align="flex-start">
            <ThemeIcon color="orange" variant="light" size={40} radius="md"><IconMessageCircleExclamation size={21} /></ThemeIcon>
            <Box>
              <Title order={3}>Chat sessions needing human attention</Title>
              <Text size="sm" c="dimmed" mt={3}>
                Interrupted or failed bounded provider turns from direct and Mission conversations.
              </Text>
            </Box>
          </Group>
          <Button component={Link} to="/interventions?view=chat" variant="subtle" size="compact-sm">
            Open all chat sessions
          </Button>
        </Group>

        <Alert color="orange" variant="light" icon={<IconShieldCheck size={17} />} title="Automatic replay remains blocked">
          A chat provider may have received an accepted message before interruption. Inspect the exact durable session and close or start a deliberately new conversation; never replay the uncertain provider turn automatically.
        </Alert>

        {query.isLoading ? (
          <Stack gap="sm"><Skeleton height={82} /><Skeleton height={82} /></Stack>
        ) : query.isError || !query.data ? (
          <Alert color="red" icon={<IconAlertTriangle size={17} />} title="Chat intervention evidence unavailable">
            The transcript-free chat-session index could not be loaded. Existing task and Workflow intervention evidence remains independent.
          </Alert>
        ) : query.data.sessions.length === 0 ? (
          <Text size="sm" c="dimmed">No direct or Mission chat session currently requires human attention.</Text>
        ) : (
          <Stack gap="sm">
            <Group gap={5} wrap="wrap">
              <Badge variant="light">direct source: {label(query.data.sources.direct_sessions)}</Badge>
              <Badge variant="light">mission source: {label(query.data.sources.mission_sessions)}</Badge>
            </Group>
            {query.data.sessions.map((session) => (
              <Paper key={session.session_id} withBorder p="md" bg="orange.0">
                <Group justify="space-between" align="flex-start" wrap="wrap">
                  <Box maw={780}>
                    <Group gap={6}>
                      <Text fw={700}>{session.title}</Text>
                      <Badge color="orange" variant="light">{label(session.session_type)}</Badge>
                      <Badge color="orange" variant="outline">needs human</Badge>
                    </Group>
                    <Text size="xs" c="dimmed" ff="monospace" mt={5}>{session.session_id}</Text>
                    <SimpleGrid cols={{ base: 1, sm: 3 }} spacing="xs" mt="sm">
                      <Box><Text size="xs" c="dimmed">Attention code</Text><Code>{label(session.attention_code)}</Code></Box>
                      <Box><Text size="xs" c="dimmed">Latest target</Text><Text size="sm" fw={600}>{session.latest_turn?.target_agent_id || session.agent_id || 'Unavailable'}</Text></Box>
                      <Box><Text size="xs" c="dimmed">Updated</Text><Text size="sm">{session.updated_at}</Text></Box>
                    </SimpleGrid>
                  </Box>
                  <Button component={Link} to={session.links.session_index} color="orange" variant="light">
                    Inspect exact session
                  </Button>
                </Group>
              </Paper>
            ))}
          </Stack>
        )}
      </Stack>
    </Paper>
  );
}
