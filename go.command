#!/bin/bash
# Double-click in Finder: starts the core and opens the app in the browser, already logged in.
# Closing this window stops the system. Safe to double-click again: if it is already running it only opens the app.
cd "$(dirname "$0")" || exit 1

[ -d node_modules ] || npm install
[ -f .env ] || node scripts/init-env.mjs
[ -f app/dist/index.html ] || { [ -d app/node_modules ] || npm run app:install; npm run app:build; }

value() { grep -E "^$1=" .env | head -1 | cut -d= -f2-; }
PORT="$(value API_PORT)"; PORT="${PORT:-8787}"
TOKEN="$(value APP_ACCESS_TOKEN)"
URL="http://127.0.0.1:$PORT/#token=$TOKEN"

if curl -s -o /dev/null "http://127.0.0.1:$PORT/"; then
  echo "המערכת כבר רצה. פותח את האפליקציה."
  open "$URL"
  exit 0
fi

# Open the browser as soon as the server answers.
( for _ in $(seq 1 60); do
    curl -s -o /dev/null "http://127.0.0.1:$PORT/" && { open "$URL"; exit 0; }
    sleep 0.5
  done ) &

echo "מפעיל את מערכת הסוכנים. לעצירה: סגור את החלון הזה (או Ctrl+C)."
exec npm start
