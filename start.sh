#!/bin/bash
set -e

export DISPLAY=:99

# Контейнер при restart сохраняет /tmp -> старый lock не даёт Xvfb стартовать ("Server is already active for display 99")
rm -f /tmp/.X99-lock /tmp/.X11-unix/X99

echo "Starting virtual display..."
Xvfb :99 -screen 0 1440x900x24 -ac +extension RANDR &
for _ in $(seq 1 50); do [ -e /tmp/.X11-unix/X99 ] && break; sleep 0.2; done
[ -e /tmp/.X11-unix/X99 ] || { echo "Xvfb did not start" >&2; exit 1; }

echo "Starting VNC server..."
x11vnc -display :99 -forever -shared -nopw -rfbport 5900 -listen 127.0.0.1 -quiet &

echo "Starting noVNC on :6080 (open /vnc.html)..."
websockify --web=/usr/share/novnc 6080 127.0.0.1:5900 &

sleep 1

echo "Starting AI Browser Agent API..."
exec node server.mjs   # без npm-обёртки: SIGTERM доходит до node -> корректное закрытие браузера
