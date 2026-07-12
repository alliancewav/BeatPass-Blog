#!/bin/bash
# Ghost CMS supervisor for blog.beatpass.ca
#
# Invoked by cron (@reboot and every minute). flock guarantees exactly one
# instance: extra invocations exit immediately, so this is safe to run as
# often as cron fires it. Ghost is restarted 10s after any exit.
#
# Operational notes:
#   - To take Ghost down for maintenance:  touch scripts/ghost-supervisor.stop
#     then kill the running "node start.js". The loop idles until the file is removed.
#   - Logs: scripts/ghost-supervisor.log (auto-truncated above ~50MB).
#   - Ghost's own request logs remain in content/logs/.
#   - The systemd user unit ghost-blog.service is intentionally disabled
#     (autostart symlink removed) so it never double-starts Ghost.

DIR=/home/beatpass-blog-ssh/htdocs/blog.beatpass.ca
LOG="$DIR/scripts/ghost-supervisor.log"
STOP="$DIR/scripts/ghost-supervisor.stop"

exec 200>"$DIR/scripts/ghost-supervisor.lock"
flock -n 200 || exit 0

export NODE_ENV=production
export PATH=/home/beatpass-blog-ssh/.nvm/versions/node/v22.21.1/bin:/usr/local/bin:/usr/bin:/bin
cd "$DIR" || exit 1

echo "$(date -Is) supervisor started (pid $$)" >> "$LOG"
while true; do
  if [ -e "$STOP" ]; then sleep 30; continue; fi
  if [ -f "$LOG" ] && [ "$(stat -c%s "$LOG" 2>/dev/null || echo 0)" -gt 52428800 ]; then : > "$LOG"; fi
  node start.js >> "$LOG" 2>&1
  echo "$(date -Is) ghost exited (code $?); restarting in 10s" >> "$LOG"
  sleep 10
done
