@echo off
chcp 65001 >nul 2>&1
cd /d "%~dp0"
:: Claude + Oracle Database — 시작 스크립트 (Windows)
:: DB Docs: https://docs.oracle.com/en/database/oracle/index.html
if not exist node_modules (
  echo 초기 설정을 Claude가 자동으로 진행합니다...
  claude -p "npm install 후 .env 설정 및 docker compose up 실행" --allowedTools Bash --model claude-haiku-4-5-20251001 --max-turns 15
)
call npm start
pause
