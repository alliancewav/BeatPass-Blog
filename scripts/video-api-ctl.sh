#!/bin/bash
# Video API management script
# Usage: bash video-api-ctl.sh [start|stop|restart|status|logs]

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
API_SCRIPT="$SCRIPT_DIR/video-api.js"
LOG_FILE="$SCRIPT_DIR/video-api.log"
PID_FILE="$SCRIPT_DIR/video-api.pid"

case "${1:-status}" in
  start)
    if [ -f "$PID_FILE" ] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
      echo "Already running (PID $(cat "$PID_FILE"))"
      exit 0
    fi
    nohup node "$API_SCRIPT" >> "$LOG_FILE" 2>&1 &
    echo $! > "$PID_FILE"
    sleep 2
    if kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
      echo "✓ Started (PID $(cat "$PID_FILE"))"
      curl -s http://127.0.0.1:3100/status
    else
      echo "✗ Failed to start. Check $LOG_FILE"
      exit 1
    fi
    ;;
  stop)
    if [ -f "$PID_FILE" ]; then
      kill "$(cat "$PID_FILE")" 2>/dev/null
      rm -f "$PID_FILE"
      echo "✓ Stopped"
    else
      pkill -f "node.*video-api.js" 2>/dev/null
      echo "✓ Stopped (pkill)"
    fi
    ;;
  restart)
    $0 stop
    sleep 1
    $0 start
    ;;
  status)
    if [ -f "$PID_FILE" ] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
      echo "Running (PID $(cat "$PID_FILE"))"
      curl -s http://127.0.0.1:3100/status
    else
      echo "Not running"
    fi
    ;;
  logs)
    tail -50 "$LOG_FILE"
    ;;
  *)
    echo "Usage: $0 {start|stop|restart|status|logs}"
    ;;
esac
