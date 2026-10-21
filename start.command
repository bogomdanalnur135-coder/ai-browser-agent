#!/bin/bash
set -e
cd "$(dirname "$0")"
if ! command -v docker >/dev/null 2>&1; then
  echo "Docker не найден. Установи Docker Desktop: https://www.docker.com/products/docker-desktop/"
  read -r -p "Нажми Enter для выхода..."
  exit 1
fi
if ! docker info >/dev/null 2>&1; then
  echo "Docker установлен, но не запущен. Открой Docker Desktop, дождись статуса Running и запусти start.command ещё раз."
  read -r -p "Нажми Enter для выхода..."
  exit 1
fi
if [ ! -f .env ]; then
  cp .env.example .env
  echo "Создал .env из шаблона. Сначала впиши OPENAI_API_KEY и API_TOKEN в файл .env, затем запусти start.command снова."
  if command -v open >/dev/null 2>&1; then open -t .env; fi
  read -r -p "Нажми Enter для выхода..."
  exit 0
fi
if grep -q 'sk-your-openai-api-key' .env || grep -q 'replace-with-a-random-secret' .env; then
  echo "Сначала замени примеры OPENAI_API_KEY и API_TOKEN в файле .env."
  if command -v open >/dev/null 2>&1; then open -t .env; fi
  read -r -p "Нажми Enter для выхода..."
  exit 1
fi
docker compose up --build -d
echo
echo "Агент запущен. Проверка API: http://localhost:8080/health"
echo "Логи: docker compose logs -f"
read -r -p "Нажми Enter для закрытия..."
