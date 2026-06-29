const WEBHOOK_URL = process.env.OPS_ROOM_EVENT_WEBHOOK_URL;

export function notify(event, data) {
  if (!WEBHOOK_URL) return;
  const payload = JSON.stringify({
    event,
    data,
    timestamp: new Date().toISOString(),
  });
  fetch(WEBHOOK_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: payload,
  }).catch(() => {});
}
