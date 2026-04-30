#!/usr/bin/env bash
set -euo pipefail

DIR="$(cd "$(dirname "$0")/.." && pwd)"
PID_FILE="$DIR/.hive.pid"
LOG_DIR="$DIR/logs"
LOG_FILE="$LOG_DIR/hive-$(date +%Y%m%d).log"

mkdir -p "$LOG_DIR"

usage() {
  echo "Usage: $0 {start|stop|status|logs|restart}"
  exit 1
}

is_running() {
  [[ -f "$PID_FILE" ]] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null
}

cmd_start() {
  if is_running; then
    echo "⚠️  hive-acp already running (PID $(cat "$PID_FILE"))"
    return 0
  fi

  echo "🚀 Starting hive-acp..."
  echo "[$(date -Iseconds)] === STARTING ===" >> "$LOG_FILE"

  cd "$DIR"
  nohup npx tsx src/index.ts >> "$LOG_FILE" 2>&1 &
  local pid=$!
  echo "$pid" > "$PID_FILE"

  # Wait briefly and verify it's still alive
  sleep 2
  if kill -0 "$pid" 2>/dev/null; then
    echo "✅ hive-acp running (PID $pid)"
    echo "📄 Logs: $LOG_FILE"
  else
    echo "❌ hive-acp failed to start. Check logs:"
    tail -20 "$LOG_FILE"
    rm -f "$PID_FILE"
    return 1
  fi
}

cmd_stop() {
  if ! is_running; then
    echo "⚠️  hive-acp is not running"
    rm -f "$PID_FILE"
    return 0
  fi

  local pid
  pid=$(cat "$PID_FILE")
  echo "🛑 Stopping hive-acp (PID $pid)..."
  echo "[$(date -Iseconds)] === STOPPING ===" >> "$LOG_FILE"

  kill "$pid"

  # Wait up to 10s for graceful shutdown
  local i=0
  while kill -0 "$pid" 2>/dev/null && (( i < 10 )); do
    sleep 1
    ((i++))
  done

  if kill -0 "$pid" 2>/dev/null; then
    echo "⚠️  Force killing..."
    kill -9 "$pid" 2>/dev/null || true
  fi

  rm -f "$PID_FILE"
  echo "✅ hive-acp stopped"
}

cmd_status() {
  if is_running; then
    local pid
    pid=$(cat "$PID_FILE")
    local mem cpu
    mem=$(ps -o rss= -p "$pid" 2>/dev/null | awk '{printf "%.1f MB", $1/1024}')
    cpu=$(ps -o %cpu= -p "$pid" 2>/dev/null | xargs)
    local uptime_info
    uptime_info=$(ps -o etime= -p "$pid" 2>/dev/null | xargs)

    echo "✅ *hive-acp running*"
    echo "  PID:    $pid"
    echo "  Uptime: $uptime_info"
    echo "  Memory: $mem"
    echo "  CPU:    ${cpu}%"
    echo "  Log:    $LOG_FILE"
  else
    echo "❌ hive-acp is not running"
    rm -f "$PID_FILE"
    return 0
  fi
}

cmd_logs() {
  local lines="${1:-50}"
  local latest
  latest=$(ls -t "$LOG_DIR"/hive-*.log 2>/dev/null | head -1)
  local target="${latest:-$LOG_FILE}"
  if [[ -f "$target" ]]; then
    tail -n "$lines" "$target"
  else
    echo "No log file found"
  fi
}

cmd_restart() {
  cmd_stop
  sleep 1
  cmd_start
}

case "${1:-}" in
  start)   cmd_start ;;
  stop)    cmd_stop ;;
  status)  cmd_status ;;
  logs)    cmd_logs "${2:-50}" ;;
  restart) cmd_restart ;;
  *)       usage ;;
esac
