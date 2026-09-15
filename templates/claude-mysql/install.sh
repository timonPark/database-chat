#!/usr/bin/env bash
# Claude + MySQL — 시작 스크립트 (macOS/Linux)
# DB Docs: https://dev.mysql.com/doc/
cd "$(dirname "$0")"

if [ ! -d node_modules ] || [ ! -f .env ]; then
  echo "초기 설정을 Claude가 자동으로 진행합니다..."
  claude -p "현재 디렉토리에서 순서대로 실행하세요: 1) npm install  2) cp .env.example .env 실행 후 docker/docker-compose.yml의 DB 접속 정보를 읽어 .env에 채우기  3) docker compose -f docker/docker-compose.yml up -d 로 MySQL 기동  4) 포트 3306이 열릴 때까지 최대 30초 대기  5) 완료 시 OK 출력" \
    --allowedTools Bash \
    --model "${CLAUDE_MODEL:-claude-haiku-4-5-20251001}" \
    --max-turns 15
fi

npm start
