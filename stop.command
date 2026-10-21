#!/bin/bash
set -e
cd "$(dirname "$0")"
docker compose down
echo "Контейнер остановлен. Данные профиля браузера сохранены."
read -r -p "Нажми Enter для выхода..."
