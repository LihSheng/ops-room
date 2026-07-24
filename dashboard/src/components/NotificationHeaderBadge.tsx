import { ActionIcon, Indicator, Tooltip } from '@mantine/core';
import { useQuery } from '@tanstack/react-query';
import { IconBell } from '@tabler/icons-react';
import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router-dom';

import { operatorNotificationsApi } from '../api/operator-notifications';

function findHeaderActionTarget() {
  return document.querySelector<HTMLElement>(
    '.app-header > .mantine-Group-root > .mantine-Group-root:last-child',
  );
}

export function NotificationHeaderBadge() {
  const navigate = useNavigate();
  const [target, setTarget] = useState<HTMLElement | null>(null);
  const query = useQuery({
    queryKey: ['operator-notifications', 'header-unread'],
    queryFn: () => operatorNotificationsApi.list({ state: 'unread', limit: 1 }),
    refetchInterval: 10_000,
    retry: false,
  });

  useEffect(() => {
    const current = findHeaderActionTarget();
    if (current) {
      setTarget(current);
      return undefined;
    }
    const observer = new MutationObserver(() => {
      const next = findHeaderActionTarget();
      if (next) {
        setTarget(next);
        observer.disconnect();
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, []);

  if (!target || query.isError) return null;
  const unread = query.data?.summary.unread || 0;
  const label = unread > 99 ? '99+' : unread;

  return createPortal(
    <Tooltip label={unread ? `${unread} unread notifications` : 'Notifications'}>
      <Indicator label={label} size={16} disabled={unread === 0} color="red" offset={3}>
        <ActionIcon
          variant="default"
          size="lg"
          aria-label="Open notifications"
          onClick={() => navigate('/activity?view=notifications')}
        >
          <IconBell size={17} />
        </ActionIcon>
      </Indicator>
    </Tooltip>,
    target,
  );
}
