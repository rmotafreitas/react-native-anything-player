#!/usr/bin/env bash
# Long-running stability monitor: samples memory, player state and the test
# server's connection count once a minute while both example apps stream.
# Usage: scripts/soak/monitor.sh <minutes> <out.csv>
set -u
MINUTES=${1:-45}
OUT=${2:-/tmp/anythingplayer-soak.csv}
ADB=${ADB:-$HOME/Library/Android/sdk/platform-tools/adb}
echo "t_min,android_pss_kb,android_state,ios_rss_kb,ios_threads,server_active,server_total" > "$OUT"
for ((m = 0; m <= MINUTES; m++)); do
  pss=$($ADB shell dumpsys meminfo anythingplayer.example 2>/dev/null | awk '/TOTAL PSS:/ {print $3; exit}')
  [ -z "$pss" ] && pss=$($ADB shell dumpsys meminfo anythingplayer.example 2>/dev/null | awk '/^ *TOTAL / {print $2; exit}')
  astate=$($ADB shell dumpsys media_session 2>/dev/null | sed -n '/anythingplayer/,/^  [a-z]/p' | grep -oE "\{state=[A-Z_]+" | head -1 | tr -d '{')
  pid=$(pgrep -x AnythingPlayerExample | head -1)
  rss=$([ -n "$pid" ] && ps -o rss= -p "$pid" | tr -d ' ')
  threads=$([ -n "$pid" ] && ps -M -p "$pid" | tail -n +2 | wc -l | tr -d ' ')
  stats=$(curl -s localhost:8765/stats | python3 -c "import json,sys; d=json.load(sys.stdin); print(d['active'], d['total'])" 2>/dev/null)
  echo "$m,${pss:-NA},${astate:-NA},${rss:-NA},${threads:-NA},${stats// /,}" >> "$OUT"
  [ "$m" -lt "$MINUTES" ] && sleep 60
done
