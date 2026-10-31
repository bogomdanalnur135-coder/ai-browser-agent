#!/bin/bash
set -e

export DISPLAY=:99

echo "Starting virtual display..."
Xvfb :99 -screen 0 1440x900x24 -ac +extension RANDR &
sleep 2

echo "Starting VNC server..."
x11vnc -display :99 -forever -shared -nopw -rfbport 5900 -listen 0.0.0.0 &

echo "Starting noVNC..."
websockify --web=/usr/share/novnc 6080 127.0.0.1:5900 &

sleep 2

echo "Starting AI Browser Agent API..."
exec npm start
