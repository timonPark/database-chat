#!/usr/bin/env bash
# PostgreSQL — dvdrental Sample Database 마이그레이션
# 공식 문서: https://www.postgresqltutorial.com/postgresql-getting-started/postgresql-sample-database/
set -euo pipefail

CONTAINER="{{PROJECT_NAME}}-postgres"
DVDRENTAL_URL="https://neon.com/postgresqltutorial/dvdrental.zip"
ZIP_TMP="/tmp/dvdrental.zip"
TAR_TMP="/tmp/dvdrental.tar"

echo "▶  PostgreSQL dvdrental Sample Database 마이그레이션 시작"
echo "   컨테이너: $CONTAINER"
echo ""

# 1. 컨테이너 실행 확인
if ! docker ps --format '{{.Names}}' | grep -q "^${CONTAINER}$"; then
  echo "✗  컨테이너 '$CONTAINER' 가 실행 중이지 않습니다."
  echo "   먼저 'docker compose -f docker/docker-compose.yml up -d' 를 실행하세요."
  exit 1
fi

# 2. PostgreSQL 준비 대기
echo "⏳ PostgreSQL 준비 대기 중..."
until docker exec "$CONTAINER" pg_isready -U dbuser -q 2>/dev/null; do
  sleep 2
done
echo "✔  PostgreSQL 연결 확인"

# 3. dvdrental 다운로드 (유효한 zip 파일이 없으면 새로 받음)
if [ ! -s "$ZIP_TMP" ] || ! unzip -tq "$ZIP_TMP" >/dev/null 2>&1; then
  echo "⬇  dvdrental 다운로드 중..."
  rm -f "$ZIP_TMP"
  curl -# -fL "$DVDRENTAL_URL" -o "$ZIP_TMP"
fi
unzip -q -o "$ZIP_TMP" dvdrental.tar -d /tmp/
echo "✔  dvdrental.tar 압축 해제 완료"

# 4. tar 파일 컨테이너로 복사
docker cp "$TAR_TMP" "${CONTAINER}:/tmp/dvdrental.tar"

# 5. DB 생성 및 pg_restore (postgres 시스템 DB에 접속해서 명령 실행)
echo "🔄 dvdrental 데이터베이스 생성 중..."
docker exec "$CONTAINER" \
  psql -U dbuser -d postgres -c "DROP DATABASE IF EXISTS dvdrental;" 2>/dev/null || true
docker exec "$CONTAINER" \
  psql -U dbuser -d postgres -c "CREATE DATABASE dvdrental;"

echo "🔄 데이터 복원 중... (시간이 걸릴 수 있습니다)"
docker exec "$CONTAINER" \
  pg_restore -U dbuser -d dvdrental --no-owner --no-privileges /tmp/dvdrental.tar

echo ""
echo "✔  마이그레이션 완료!"
echo "   데이터베이스: dvdrental"
docker exec "$CONTAINER" \
  psql -U dbuser -d dvdrental -c "\dt" 2>/dev/null \
  | grep " table " | awk '{ print "  •  " $3 }'

# 6. .env 자동 업데이트
ENV_FILE="$(dirname "$0")/../.env"
if [ -f "$ENV_FILE" ]; then
  sed -i.bak "s|^DB_DATABASE=.*|DB_DATABASE=dvdrental|" "$ENV_FILE" && rm -f "${ENV_FILE}.bak"
  echo "✔  .env DB_DATABASE=dvdrental 업데이트 완료"
fi

echo ""
echo "💡 .env 의 DB_DATABASE 가 'dvdrental' 로 설정됐습니다."
