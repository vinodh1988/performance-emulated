#!/bin/sh
set -eu

if [ -n "${PERF_SSH_KEY_SOURCE:-}" ] && [ -f "$PERF_SSH_KEY_SOURCE" ]; then
  mkdir -p /app/.ssh
  cp "$PERF_SSH_KEY_SOURCE" /app/.ssh/mongo.pem
  chmod 400 /app/.ssh/mongo.pem
  export PERF_SSH_KEY=/app/.ssh/mongo.pem
fi

exec "$@"
