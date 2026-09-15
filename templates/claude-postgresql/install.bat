@echo off
chcp 65001 >nul 2>&1
cd /d "%~dp0"
:: Claude + PostgreSQL — 시작 스크립트 (Windows)
:: DB Docs: https://www.postgresql.org/docs/

if not exist node_modules (
  echo 초기 설정을 Claude가 자동으로 진행합니다...
  claude -p "npm install 실행 후 .env.example을 .env로 복사하고 DB 접속 정보 입력 후 docker compose up -d 실행" --allowedTools Bash --model claude-haiku-4-5-20251001 --max-turns 15
)

call npm start
pause
