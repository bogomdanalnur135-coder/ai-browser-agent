#!/bin/bash
cd "$(dirname "$0")"
TOKEN=$(grep '^API_TOKEN=' .env | cut -d= -f2-); API=http://localhost:8081
BODY=$(python3 -c "import json,sys;print(json.dumps({'prompt':sys.argv[1]}))" "$1")
ID=$(curl -s -X POST $API/tasks -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d "$BODY" | python3 -c "import sys,json;print(json.load(sys.stdin)['task']['id'])")
while true; do
  R=$(curl -s $API/tasks/$ID -H "Authorization: Bearer $TOKEN")
  S=$(echo "$R" | python3 -c "import sys,json;print(json.load(sys.stdin)['task']['status'])")
  echo "$S"; case $S in completed|failed|cancelled) break;; esac; sleep 3
done
echo "$R" | python3 -c "import sys,json;t=json.load(sys.stdin)['task'];print(t['result'] or t['error'])"
