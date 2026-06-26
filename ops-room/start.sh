#!/bin/bash
# Start Ops Room server (with built-in poller)
# Use setsid to fully detach from shell

cd "$(dirname "$0")"
mkdir -p ../../data/ops-room/logs 2>/dev/null
setsid node src/server/webhook.mjs < /dev/null > ../../data/ops-room/logs/server.log 2>&1 &
echo "Ops Room server started"
echo "Health: http://localhost:7381/health"
