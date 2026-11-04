#!/bin/bash
cd "$(dirname "$0")"
TOKEN=$(grep '^API_TOKEN=' .env | cut -d= -f2-); API=http://localhost:8081
ID=$(curl -s $API/tasks -H "Authorization: Bearer $TOKEN" | python3 -c "import sys,json;ts=[t for t in json.load(sys.stdin)['tasks'] if t['status']=='awaiting_confirmation'];print(ts[-1]['id'] if ts else '')")
[ -z "$ID" ] && { echo "Нет задач, ждущих подтверждения"; exit 1; }
curl -s -X POST $API/tasks/$ID/confirm -H "Authorization: Bearer $TOKEN"; echo
