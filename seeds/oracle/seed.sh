#!/usr/bin/env bash
# Oracle Database — HR Sample Schema 마이그레이션
# 공식 GitHub: https://github.com/oracle/db-sample-schemas
set -euo pipefail

CONTAINER="{{PROJECT_NAME}}-oracle"
SCHEMAS_REPO="https://github.com/oracle/db-sample-schemas.git"
SCHEMAS_TMP="/tmp/db-sample-schemas"
PDB="FREEPDB1"      # gvenzl/oracle-free 23c 기본 PDB 이름
SYS_PASS="changeme"
HR_PASS="hr"

echo "▶  Oracle HR Sample Schema 마이그레이션 시작"
echo "   컨테이너: $CONTAINER  /  PDB: $PDB"
echo ""

# 1. 컨테이너 실행 확인
if ! docker ps --format '{{.Names}}' | grep -q "^${CONTAINER}$"; then
  echo "✗  컨테이너 '$CONTAINER' 가 실행 중이지 않습니다."
  echo "   먼저 'docker compose -f docker/docker-compose.yml up -d' 를 실행하세요."
  exit 1
fi

# 2. Oracle 준비 대기 (초기화 최대 5분 소요)
# gvenzl 이미지의 healthcheck.sh 는 PDB 서비스 등록까지 완료돼야 exit 0 을 반환합니다.
echo "⏳ Oracle 초기화 대기 중... (최대 5분)"
TIMEOUT=300
ELAPSED=0
until docker exec "$CONTAINER" /opt/oracle/healthcheck.sh > /dev/null 2>&1; do
  sleep 5
  ELAPSED=$((ELAPSED + 5))
  if [ $ELAPSED -ge $TIMEOUT ]; then
    echo "✗  Oracle 초기화 타임아웃. 컨테이너 로그를 확인하세요."
    exit 1
  fi
  echo "   대기 중... (${ELAPSED}s / ${TIMEOUT}s)"
done
echo "✔  Oracle 연결 확인"

# 3. 샘플 스키마 저장소 클론
if [ ! -d "$SCHEMAS_TMP" ]; then
  echo "⬇  Oracle Sample Schemas 클론 중..."
  git clone --depth=1 "$SCHEMAS_REPO" "$SCHEMAS_TMP"
else
  echo "✔  샘플 스키마 캐시 사용: $SCHEMAS_TMP"
fi

# 4. HR 스크립트 컨테이너로 복사
echo "📦 HR 스크립트 컨테이너로 복사 중..."
docker exec "$CONTAINER" mkdir -p /tmp/hr
docker cp "${SCHEMAS_TMP}/human_resources/." "${CONTAINER}:/tmp/hr/"

# 5. HR 스키마 설치
# 원본 hr_install.sql 은 ACCEPT ... HIDE 로 대화형 프롬프트를 사용해서 자동화가 어려움.
# HR 사용자를 직접 만들고 hr_create/populate/code 스크립트만 실행합니다.
echo "🔄 HR 스키마 설치 중..."
docker exec -i "$CONTAINER" \
  sqlplus -S sys/"${SYS_PASS}"@localhost/"${PDB}" as sysdba <<EOF
WHENEVER SQLERROR EXIT FAILURE
SET ECHO OFF FEEDBACK OFF VERIFY OFF HEADING OFF

BEGIN
   EXECUTE IMMEDIATE 'DROP USER hr CASCADE';
EXCEPTION WHEN OTHERS THEN
   IF SQLCODE != -1918 THEN RAISE; END IF;
END;
/

CREATE USER hr IDENTIFIED BY "${HR_PASS}"
               DEFAULT TABLESPACE users
               QUOTA UNLIMITED ON users;

GRANT CREATE MATERIALIZED VIEW,
      CREATE PROCEDURE,
      CREATE SEQUENCE,
      CREATE SESSION,
      CREATE SYNONYM,
      CREATE TABLE,
      CREATE TRIGGER,
      CREATE TYPE,
      CREATE VIEW
  TO hr;

ALTER SESSION SET CURRENT_SCHEMA=HR;
ALTER SESSION SET NLS_LANGUAGE=American;
ALTER SESSION SET NLS_TERRITORY=America;

@/tmp/hr/hr_create.sql
@/tmp/hr/hr_populate.sql
@/tmp/hr/hr_code.sql

COMMIT;

-- num_rows 통계를 즉시 반영해야 extract-schema 가 정확한 건수를 뽑을 수 있음
EXEC DBMS_STATS.GATHER_SCHEMA_STATS('HR');

EXIT;
EOF

echo ""
echo "✔  마이그레이션 완료!"
echo "   스키마: HR  /  접속 계정: hr / ${HR_PASS}"
TABLES=$(docker exec -i "$CONTAINER" \
  sqlplus -S hr/"${HR_PASS}"@localhost/"${PDB}" <<'EOF'
SET HEADING OFF FEEDBACK OFF PAGESIZE 0
SELECT table_name FROM user_tables ORDER BY table_name;
EXIT;
EOF
)
echo "$TABLES" | awk 'NF { print "  •  " $0 }'

# 6. .env 자동 업데이트
ENV_FILE="$(dirname "$0")/../.env"
if [ -f "$ENV_FILE" ]; then
  sed -i.bak \
    -e "s|^DB_USER_NAME=.*|DB_USER_NAME=hr|" \
    -e "s|^DB_USER_PASSWORD=.*|DB_USER_PASSWORD=${HR_PASS}|" \
    -e "s|^DB_SERVICE_NAME=.*|DB_SERVICE_NAME=${PDB}|" \
    "$ENV_FILE" && rm -f "${ENV_FILE}.bak"
  echo "✔  .env DB_USER_NAME=hr, DB_USER_PASSWORD=${HR_PASS}, DB_SERVICE_NAME=${PDB} 업데이트 완료"
fi

echo ""
echo "💡 .env 가 hr 계정 / SERVICE=${PDB} 로 설정됐습니다."
