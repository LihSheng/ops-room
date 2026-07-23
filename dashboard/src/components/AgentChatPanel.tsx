import {
  Alert,
  Badge,
  Box,
  Button,
  Checkbox,
  Code,
  Divider,
  Group,
  Modal,
  Paper,
  ScrollArea,
  Skeleton,
  Stack,
  Text,
  Textarea,
  TextInput,
  ThemeIcon,
  Title,
} from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  IconAlertTriangle,
  IconMessageCircle,
  IconPlus,
  IconRefresh,
  IconSend,
  IconShieldCheck,
  IconX,
} from '@tabler/icons-react';
import { useEffect, useMemo, useState } from 'react';

import {
  agentChatApi,
  createAgentChatIdempotencyKey,
  OperatorAgentChatApiError,
  type AgentChatSession,
} from '../api/agent-chat';
import { useOperatorAuth } from '../operator-auth';

function label(value: string | null | undefined) {
  return String(value || 'unavailable').replaceAll('_', ' ');
}

function stateColor(value: string) {
  if (value === 'open' || value === 'completed') return 'teal';
  if (value === 'needs_human') return 'orange';
  if (value === 'provider_pending') return 'blue';
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

function errorMessage(error: unknown) {
  if (!(error instanceof OperatorAgentChatApiError)) return null;
  const details = [error.errorCode, error.auditEventId ? `audit ${error.auditEventId}` : null]
    .filter(Boolean)
    .join(' · ');
  return `${error.message}${details ? ` (${details})` : ''}`;
}

export function AgentChatPanel({ agentId, displayName }: { agentId: string; displayName: string }) {
  const auth = useOperatorAuth();
  const queryClient = useQueryClient();
  const roles = auth.session?.session.roles || [];
  const canChat = auth.mode === 'session' && rolesAllowChat(roles);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const sessionsQuery = useQuery({
    queryKey: ['agent-chat-sessions', agentId],
    queryFn: () => agentChatApi.list(agentId),
    enabled: canChat,
    refetchInterval: canChat ? 15_000 : false,
  });
  const sessions = useMemo(
    () => sessionsQuery.data?.sessions || [],
    [sessionsQuery.data?.sessions],
  );

  useEffect(() => {
    if (selectedId && sessions.some((session) => session.session_id === selectedId)) return;
    const preferred = sessions.find((session) => session.state === 'open') || sessions[0];
    setSelectedId(preferred?.session_id || null);
  }, [selectedId, sessions]);

  const sessionQuery = useQuery({
    queryKey: ['agent-chat-session', selectedId],
    queryFn: () => agentChatApi.detail(String(selectedId)),
    enabled: canChat && Boolean(selectedId),
    refetchInterval: selectedId ? 10_000 : false,
  });
  const session = sessionQuery.data?.session
    || sessions.find((candidate) => candidate.session_id === selectedId)
    || null;

  const [createOpened, setCreateOpened] = useState(false);
  const [createTitle, setCreateTitle] = useState('');
  const [createReason, setCreateReason] = useState('');
  const [createConfirmed, setCreateConfirmed] = useState(false);
  const [createKey, setCreateKey] = useState('');
  const [createPending, setCreatePending] = useState(false);
  const [createUncertain, setCreateUncertain] = useState(false);

  const [message, setMessage] = useState('');
  const [messageKey, setMessageKey] = useState<string | null>(null);
  const [messagePending, setMessagePending] = useState(false);
  const [messageUncertain, setMessageUncertain] = useState(false);

  const [closeOpened, setCloseOpened] = useState(false);
  const [closeReason, setCloseReason] = useState('');
  const [closeConfirmed, setCloseConfirmed] = useState(false);
  const [closeKey, setCloseKey] = useState('');
  const [closePending, setClosePending] = useState(false);
  const [closeUncertain, setCloseUncertain] = useState(false);

  const refresh = async (sessionId: string | null = selectedId) => {
    const keys: Array<readonly unknown[]> = [
      ['agent-chat-sessions', agentId],
      ['agent-profile', agentId],
      ['agent-fleet'],
      ['ops-dashboard'],
      ['interventions'],
    ];
    if (sessionId) keys.push(['agent-chat-session', sessionId]);
    await Promise.all(keys.map((queryKey) => queryClient.invalidateQueries({ queryKey })));
  };

  const openCreate = () => {
    setCreateOpened(true);
    setCreateTitle(`Chat with ${displayName}`);
    setCreateReason('Clarify work with this agent');
    setCreateConfirmed(false);
    setCreateKey(createAgentChatIdempotencyKey());
    setCreateUncertain(false);
  };

  const closeCreate = () => {
    if (createPending) return;
    setCreateOpened(false);
    setCreateUncertain(false);
  };

  const submitCreate = async () => {
    if (!auth.session || !createReason.trim() || !createTitle.trim() || !createConfirmed || !createKey) return;
    setCreatePending(true);
    setCreateUncertain(false);
    try {
      const result = await agentChatApi.create({
        agentId,
        title: createTitle.trim(),
        reason: createReason.trim(),
        idempotencyKey: createKey,
        csrfToken: auth.session.csrf_token,
      });
      setSelectedId(result.session.session_id);
      await refresh(result.session.session_id);
      notifications.show({
        color: 'teal',
        title: result.domain_idempotent ? 'Chat session already accepted' : 'Chat session created',
        message: `${result.session.title}${result.audit_event_id ? ` · Audit ${result.audit_event_id}` : ''}`,
      });
      setCreateOpened(false);
    } catch (error) {
      const definite = errorMessage(error);
      if (definite) {
        notifications.show({ color: 'red', title: 'Chat session rejected', message: definite });
        setCreateKey(createAgentChatIdempotencyKey());
        await refresh();
      } else {
        setCreateUncertain(true);
      }
    } finally {
      setCreatePending(false);
    }
  };

  const submitMessage = async () => {
    if (!auth.session || !session || session.state !== 'open' || !message.trim()) return;
    const retainedKey = messageKey || createAgentChatIdempotencyKey();
    setMessageKey(retainedKey);
    setMessagePending(true);
    setMessageUncertain(false);
    try {
      const result = await agentChatApi.send({
        sessionId: session.session_id,
        content: message.trim(),
        idempotencyKey: retainedKey,
        csrfToken: auth.session.csrf_token,
      });
      await refresh(session.session_id);
      const needsHuman = result.turn.state === 'needs_human';
      notifications.show({
        color: needsHuman ? 'orange' : 'teal',
        title: needsHuman ? 'Chat turn needs attention' : result.domain_idempotent ? 'Chat turn already accepted' : 'Agent replied',
        message: needsHuman
          ? `${label(result.turn.error_code)}${result.audit_event_id ? ` · Audit ${result.audit_event_id}` : ''}`
          : `${displayName} returned a bounded final response${result.audit_event_id ? ` · Audit ${result.audit_event_id}` : ''}`,
      });
      setMessage('');
      setMessageKey(null);
    } catch (error) {
      const definite = errorMessage(error);
      if (definite) {
        notifications.show({ color: 'red', title: 'Message rejected', message: definite });
        setMessageKey(null);
        await refresh(session.session_id);
      } else {
        setMessageUncertain(true);
      }
    } finally {
      setMessagePending(false);
    }
  };

  const openClose = () => {
    if (!session) return;
    setCloseOpened(true);
    setCloseReason('Conversation is complete');
    setCloseConfirmed(false);
    setCloseKey(createAgentChatIdempotencyKey());
    setCloseUncertain(false);
  };

  const closeClose = () => {
    if (closePending) return;
    setCloseOpened(false);
    setCloseUncertain(false);
  };

  const submitClose = async () => {
    if (!auth.session || !session || !closeReason.trim() || !closeConfirmed || !closeKey) return;
    setClosePending(true);
    setCloseUncertain(false);
    try {
      const result = await agentChatApi.close({
        sessionId: session.session_id,
        reason: closeReason.trim(),
        idempotencyKey: closeKey,
        csrfToken: auth.session.csrf_token,
      });
      await refresh(session.session_id);
      notifications.show({
        color: 'teal',
        title: result.domain_idempotent ? 'Chat session already closed' : 'Chat session closed',
        message: `${result.session.title}${result.audit_event_id ? ` · Audit ${result.audit_event_id}` : ''}`,
      });
      setCloseOpened(false);
    } catch (error) {
      const definite = errorMessage(error);
      if (definite) {
        notifications.show({ color: 'red', title: 'Close rejected', message: definite });
        setCloseKey(createAgentChatIdempotencyKey());
        await refresh(session.session_id);
      } else {
        setCloseUncertain(true);
      }
    } finally {
      setClosePending(false);
    }
  };

  return (
    <Paper withBorder p="lg" id="agent-chat">
      <Stack gap="md">
        <Group justify="space-between" align="flex-start" wrap="wrap">
          <Group gap="sm" align="flex-start">
            <ThemeIcon variant="light" color="violet" size={40} radius="md"><IconMessageCircle size={21} /></ThemeIcon>
            <Box>
              <Title order={3}>Direct chat</Title>
              <Text size="sm" c="dimmed" mt={3}>
                Durable, operator-attributed conversations with bounded final responses from {displayName}.
              </Text>
            </Box>
          </Group>
          <Group gap={6}>
            {session && <Badge color={stateColor(session.state)} variant="light">{label(session.state)}</Badge>}
            <Button
              size="sm"
              variant="light"
              leftSection={<IconPlus size={15} />}
              disabled={!canChat}
              onClick={openCreate}
            >
              New session
            </Button>
          </Group>
        </Group>

        <Alert color="blue" variant="light" icon={<IconShieldCheck size={17} />} title="Conversation-only authority">
          Chat can clarify, discuss, investigate conceptually, and summarize. It cannot read files, run tools, mutate repositories, change workflow state, or replace exact-SHA handoffs and approvals. Only final responses are stored.
        </Alert>

        {auth.mode === 'legacy' ? (
          <Alert color="orange" icon={<IconAlertTriangle size={17} />} title="Human session required">
            Dashboard-token mode cannot read or create direct chat sessions.
          </Alert>
        ) : !rolesAllowChat(roles) ? (
          <Alert color="orange" icon={<IconAlertTriangle size={17} />} title="Agent chat permission required">
            This account does not have the <Code>agent.chat</Code> permission.
          </Alert>
        ) : sessionsQuery.isLoading ? (
          <Skeleton height={260} />
        ) : sessionsQuery.isError ? (
          <Alert color="red" icon={<IconAlertTriangle size={17} />} title="Chat sessions unavailable">
            Durable chat-session evidence could not be loaded. No message was submitted.
          </Alert>
        ) : (
          <Group align="stretch" gap="md" wrap="nowrap">
            <Paper withBorder p="sm" w={250} miw={220}>
              <Stack gap="xs">
                <Group justify="space-between">
                  <Text size="sm" fw={700}>Sessions</Text>
                  <Button
                    size="compact-xs"
                    variant="subtle"
                    leftSection={<IconRefresh size={13} />}
                    loading={sessionsQuery.isFetching}
                    onClick={() => { void refresh(); }}
                  >
                    Refresh
                  </Button>
                </Group>
                <Divider />
                {sessions.length === 0 ? (
                  <Text size="xs" c="dimmed">No direct chat session exists for this agent.</Text>
                ) : (
                  <ScrollArea.Autosize mah={420}>
                    <Stack gap={6}>
                      {sessions.map((candidate) => (
                        <Button
                          key={candidate.session_id}
                          variant={candidate.session_id === selectedId ? 'light' : 'subtle'}
                          color={candidate.state === 'needs_human' ? 'orange' : 'violet'}
                          justify="flex-start"
                          h="auto"
                          py="xs"
                          onClick={() => setSelectedId(candidate.session_id)}
                        >
                          <Box ta="left" style={{ overflow: 'hidden' }}>
                            <Text size="sm" fw={600} truncate>{candidate.title}</Text>
                            <Text size="xs" c="dimmed">{label(candidate.state)} · {candidate.turn_count} turn{candidate.turn_count === 1 ? '' : 's'}</Text>
                          </Box>
                        </Button>
                      ))}
                    </Stack>
                  </ScrollArea.Autosize>
                )}
              </Stack>
            </Paper>

            <Paper withBorder p="md" style={{ flex: 1, minWidth: 0 }}>
              {!selectedId ? (
                <Stack align="center" justify="center" mih={260} ta="center">
                  <ThemeIcon size={44} radius="xl" variant="light" color="violet"><IconMessageCircle size={22} /></ThemeIcon>
                  <Text fw={700}>Start a governed conversation</Text>
                  <Text size="sm" c="dimmed">Create a session to discuss this agent's work without granting operational authority.</Text>
                </Stack>
              ) : sessionQuery.isLoading ? (
                <Skeleton height={320} />
              ) : sessionQuery.isError || !session ? (
                <Alert color="red" icon={<IconAlertTriangle size={17} />} title="Transcript unavailable">
                  The selected durable session could not be read.
                </Alert>
              ) : (
                <Stack gap="md">
                  <Group justify="space-between" align="flex-start" wrap="wrap">
                    <Box>
                      <Group gap={6}><Text fw={700}>{session.title}</Text><Badge size="sm" color={stateColor(session.state)}>{label(session.state)}</Badge></Group>
                      <Text size="xs" c="dimmed">Created by {session.created_by.actor_display_name} · {timeLabel(session.created_at)}</Text>
                      <Text size="xs" ff="monospace" c="dimmed">{session.session_id}</Text>
                    </Box>
                    {session.state !== 'closed' && (
                      <Button size="compact-sm" color="red" variant="light" leftSection={<IconX size={14} />} onClick={openClose}>
                        Close session
                      </Button>
                    )}
                  </Group>

                  {session.state === 'needs_human' && (
                    <Alert color="orange" icon={<IconAlertTriangle size={17} />} title="Provider turn needs human attention">
                      {label(session.last_error)}. The interrupted or failed turn was not replayed automatically. Close this session or retain it as durable investigation evidence.
                    </Alert>
                  )}

                  <ScrollArea.Autosize mah={480} offsetScrollbars>
                    <Stack gap="sm" pr="xs">
                      {session.turns.length === 0 ? (
                        <Text size="sm" c="dimmed">No messages yet.</Text>
                      ) : session.turns.map((turn) => (
                        <Stack key={turn.turn_id} gap={6}>
                          <Paper withBorder p="sm" bg="gray.0" ml="15%">
                            <Text size="xs" c="dimmed" fw={700}>{turn.human_message.actor.actor_display_name} · {timeLabel(turn.human_message.created_at)}</Text>
                            <Text size="sm" mt={5} style={{ whiteSpace: 'pre-wrap' }}>{turn.human_message.content}</Text>
                          </Paper>
                          {turn.agent_message ? (
                            <Paper withBorder p="sm" mr="15%">
                              <Group justify="space-between" gap="xs"><Text size="xs" c="dimmed" fw={700}>{displayName} · {timeLabel(turn.agent_message.created_at)}</Text><Badge size="xs" variant="outline">{turn.agent_message.model}</Badge></Group>
                              <Text size="sm" mt={5} style={{ whiteSpace: 'pre-wrap' }}>{turn.agent_message.content}</Text>
                            </Paper>
                          ) : (
                            <Alert color={turn.state === 'provider_pending' ? 'blue' : 'orange'} variant="light" title={turn.state === 'provider_pending' ? 'Provider response pending' : 'No final response recorded'}>
                              {turn.state === 'provider_pending' ? 'The message is durably recorded while the bounded provider turn runs.' : label(turn.error_code)}
                            </Alert>
                          )}
                        </Stack>
                      ))}
                    </Stack>
                  </ScrollArea.Autosize>

                  <Divider />
                  <Textarea
                    label="Message"
                    description="Maximum 4,000 characters. This is conversation context, not an operational command."
                    minRows={3}
                    maxRows={8}
                    maxLength={4_000}
                    value={message}
                    onChange={(event) => {
                      setMessage(event.currentTarget.value);
                      if (!messageKey) setMessageKey(createAgentChatIdempotencyKey());
                    }}
                    disabled={session.state !== 'open' || messagePending}
                    placeholder={session.state === 'open' ? `Ask ${displayName} for clarification or a summary...` : 'This session cannot accept more messages.'}
                  />
                  {messageUncertain && (
                    <Alert color="orange" icon={<IconAlertTriangle size={17} />} title="Server response was not received">
                      The same message request key is retained. Retrying cannot create a second provider turn for a previously accepted message.
                    </Alert>
                  )}
                  <Group justify="flex-end">
                    <Button
                      leftSection={<IconSend size={15} />}
                      loading={messagePending}
                      disabled={session.state !== 'open' || !message.trim()}
                      onClick={() => { void submitMessage(); }}
                    >
                      Send message
                    </Button>
                  </Group>
                </Stack>
              )}
            </Paper>
          </Group>
        )}
      </Stack>

      <Modal opened={createOpened} onClose={closeCreate} title="Create direct chat session" centered closeOnClickOutside={!createPending} closeOnEscape={!createPending}>
        <Stack gap="md">
          <Alert color="violet" variant="light" title="Durable conversation">
            This creates an Ops Room-owned transcript for {displayName}. Creating a session does not invoke a provider.
          </Alert>
          <TextInput label="Session title" maxLength={120} value={createTitle} onChange={(event) => setCreateTitle(event.currentTarget.value)} disabled={createPending} required />
          <Textarea label="Operator reason" description="Required for actor-attributed audit evidence." maxLength={500} minRows={2} value={createReason} onChange={(event) => setCreateReason(event.currentTarget.value)} disabled={createPending} required />
          <Checkbox checked={createConfirmed} onChange={(event) => setCreateConfirmed(event.currentTarget.checked)} disabled={createPending} label="I understand this session provides conversation only and grants no operational authority." />
          {createUncertain && <Alert color="orange" icon={<IconAlertTriangle size={17} />} title="Server response was not received">The same session request key is retained for a safe retry.</Alert>}
          <Group justify="flex-end"><Button variant="default" onClick={closeCreate} disabled={createPending}>Cancel</Button><Button loading={createPending} disabled={!createTitle.trim() || !createReason.trim() || !createConfirmed} onClick={() => { void submitCreate(); }}>Create session</Button></Group>
        </Stack>
      </Modal>

      <Modal opened={closeOpened} onClose={closeClose} title="Close direct chat session" centered closeOnClickOutside={!closePending} closeOnEscape={!closePending}>
        <Stack gap="md">
          <Alert color="red" variant="light" title="Exact consequence">
            The selected session becomes closed and cannot accept additional messages. Its bounded transcript remains durable evidence.
          </Alert>
          <Textarea label="Operator reason" maxLength={500} minRows={2} value={closeReason} onChange={(event) => setCloseReason(event.currentTarget.value)} disabled={closePending} required />
          <Checkbox checked={closeConfirmed} onChange={(event) => setCloseConfirmed(event.currentTarget.checked)} disabled={closePending} label="I understand this session will become read only." />
          {closeUncertain && <Alert color="orange" icon={<IconAlertTriangle size={17} />} title="Server response was not received">The same close request key is retained for a safe retry.</Alert>}
          <Group justify="flex-end"><Button variant="default" onClick={closeClose} disabled={closePending}>Cancel</Button><Button color="red" loading={closePending} disabled={!closeReason.trim() || !closeConfirmed} onClick={() => { void submitClose(); }}>Close session</Button></Group>
        </Stack>
      </Modal>
    </Paper>
  );
}

export { rolesAllowChat };
