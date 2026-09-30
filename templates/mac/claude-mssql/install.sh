#!/usr/bin/env bash
# Claude + MSSQL — 시작 스크립트 (macOS/Linux)
# DB Docs: https://learn.microsoft.com/ko-kr/sql/?view=sql-server-ver17
cd "$(dirname "$0")"
if [ ! -d node_modules ] || [ ! -f .env ]; then
  echo "초기 설정을 Claude가 자동으로 진행합니다..."
  claude -p "현재 디렉토리에서 순서대로: 1) npm install  2) cp .env.example .env 후 DB 접속 정보 입력  3) docker compose -f docker/docker-compose.yml up -d  4) 완료 시 OK 출력" \
    --allowedTools Bash --model "${CLAUDE_MODEL:-claude-haiku-4-5-20251001}" --max-turns 15
fi
npm start
