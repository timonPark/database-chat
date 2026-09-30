@echo off
chcp 65001 >nul 2>&1
cd /d "%~dp0"
:: Claude + MySQL — 시작 스크립트 (Windows)
:: DB Docs: https://dev.mysql.com/doc/

if not exist node_modules (
  echo 초기 설정을 Claude가 자동으로 진행합니다...
  claude -p "npm install 실행 후 .env.example을 .env로 복사하고 docker/docker-compose.yml의 DB 정보를 .env에 채운 뒤 docker compose up -d 실행" --allowedTools Bash --model claude-haiku-4-5-20251001 --max-turns 15
)

call npm start
pause
