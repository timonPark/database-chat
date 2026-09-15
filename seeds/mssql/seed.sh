#!/usr/bin/env bash
# Microsoft SQL Server — AdventureWorksLT2022 마이그레이션
# 공식 GitHub: https://github.com/microsoft/sql-server-samples
set -euo pipefail

CONTAINER="{{PROJECT_NAME}}-mssql"
BAK_URL="https://github.com/Microsoft/sql-server-samples/releases/download/adventureworks/AdventureWorksLT2022.bak"
BAK_TMP="/tmp/AdventureWorksLT2022.bak"
SA_PASS="Changeme1!"
DB_NAME="AdventureWorksLT2022"
SQLCMD="opt/mssql-tools18/bin/sqlcmd"

echo "▶  SQL Server AdventureWorksLT2022 마이그레이션 시작"
echo "   컨테이너: $CONTAINER"
echo ""

# 1. 컨테이너 실행 확인
if ! docker ps --format '{{.Names}}' | grep -q "^${CONTAINER}$"; then
  echo "✗  컨테이너 '$CONTAINER' 가 실행 중이지 않습니다."
  echo "   먼저 'docker compose -f docker/docker-compose.yml up -d' 를 실행하세요."
  exit 1
fi

# 2. SQL Server 준비 대기
echo "⏳ SQL Server 준비 대기 중..."
until docker exec "$CONTAINER" \
  /"${SQLCMD}" -S localhost -U SA -P "${SA_PASS}" -No \
  -Q "SELECT 1" > /dev/null 2>&1; do
  sleep 3
done
echo "✔  SQL Server 연결 확인"

# 3. .bak 파일 다운로드 (~7MB)
if [ ! -f "$BAK_TMP" ]; then
  echo "⬇  AdventureWorksLT2022.bak 다운로드 중... (~7MB)"
  curl -# -L "$BAK_URL" -o "$BAK_TMP"
else
  echo "✔  .bak 캐시 사용: $BAK_TMP"
fi

# 4. 컨테이너 백업 디렉터리에 복사
echo "📦 컨테이너로 파일 복사 중..."
docker exec "$CONTAINER" mkdir -p /var/opt/mssql/backup
docker cp "$BAK_TMP" "${CONTAINER}:/var/opt/mssql/backup/AdventureWorksLT2022.bak"

# 5. 기존 DB 삭제 (있을 경우)
docker exec "$CONTAINER" \
  /"${SQLCMD}" -S localhost -U SA -P "${SA_PASS}" -No \
  -Q "IF DB_ID('${DB_NAME}') IS NOT NULL DROP DATABASE [${DB_NAME}];" 2>/dev/null || true

# 6. RESTORE DATABASE
echo "🔄 데이터베이스 복원 중..."
docker exec "$CONTAINER" \
  /"${SQLCMD}" -S localhost -U SA -P "${SA_PASS}" -No -Q \
  "RESTORE DATABASE [${DB_NAME}]
   FROM DISK = '/var/opt/mssql/backup/AdventureWorksLT2022.bak'
   WITH MOVE 'AdventureWorksLT2022_Data' TO '/var/opt/mssql/data/AdventureWorksLT2022.mdf',
        MOVE 'AdventureWorksLT2022_Log'  TO '/var/opt/mssql/data/AdventureWorksLT2022_log.ldf',
        REPLACE, STATS = 10;"

echo ""
echo "✔  마이그레이션 완료!"
echo "   데이터베이스: $DB_NAME"
docker exec "$CONTAINER" \
  /"${SQLCMD}" -S localhost -U SA -P "${SA_PASS}" -No \
  -Q "USE [${DB_NAME}]; SELECT TABLE_NAME FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_TYPE='BASE TABLE' ORDER BY TABLE_NAME;" \
  2>/dev/null | grep -v "^-\|^TABLE\|rows affected\|^$" | awk '{ print "  •  " $0 }'

# 7. .env 자동 업데이트
ENV_FILE="$(dirname "$0")/../.env"
if [ -f "$ENV_FILE" ]; then
  sed -i.bak "s|^DB_DATABASE=.*|DB_DATABASE=${DB_NAME}|" "$ENV_FILE" && rm -f "${ENV_FILE}.bak"
  echo "✔  .env DB_DATABASE=${DB_NAME} 업데이트 완료"
fi

echo ""
echo "💡 .env 의 DB_DATABASE 가 '${DB_NAME}' 로 설정됐습니다."
