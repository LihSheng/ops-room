const WEBHOOK_URL = process.env.OPS_ROOM_EVENT_WEBHOOK_URL;
const FETCH_TIMEOUT_MS = parseInt(process.env.OPS_ROOM_NOTIFY_TIMEOUT || '5000', 10);

export function notify(event, data) {
  if (!WEBHOOK_URL) return;
  const payload = JSON.stringify({
    event,
    data,
    timestamp: new Date().toISOString(),
  });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  fetch(WEBHOOK_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: payload,
    signal: controller.signal,
  }).catch(() => {}).finally(() => clearTimeout(timer));
}
