#!/bin/bash
set -e
cd "$(dirname "$0")"
echo "== Установка локального ИИ-браузерного агента =="
if ! command -v node >/dev/null 2>&1; then
  echo "Node.js не найден. Установи Node.js 22 LTS с https://nodejs.org/ и запусти этот скрипт снова."
  exit 1
fi
echo "Node: $(node -v)"
npm install
npx playwright install chromium
if [ ! -f .env ]; then
  cp .env.example .env
fi
if grep -q 'put_your_api_key_here' .env || ! grep -q '^OPENAI_API_KEY=.' .env; then
  echo
  echo "Введи OpenAI API key. Ввод скрыт; ключ сохранится только в локальном .env."
  read -s -p "OPENAI_API_KEY: " API_KEY
  echo
  if [ -z "$API_KEY" ]; then
    echo "Ключ не введён. Позже отредактируй .env и запусти npm start."
  else
    printf 'OPENAI_API_KEY=%s\nOPENAI_MODEL=gpt-4.1\n' "$API_KEY" > .env
    chmod 600 .env
  fi
fi
echo
echo "Установка завершена. Запускаю агента..."
npm start
