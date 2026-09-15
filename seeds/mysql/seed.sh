#!/usr/bin/env bash
# MySQL — Sakila Sample Database 마이그레이션
# 공식 문서: https://dev.mysql.com/doc/sakila/en/
set -euo pipefail

CONTAINER="{{PROJECT_NAME}}-mysql"
SAKILA_URL="https://downloads.mysql.com/docs/sakila-db.zip"
ZIP_TMP="/tmp/sakila-db.zip"
DIR_TMP="/tmp/sakila-db"
CRED_FILE=".credentials"

echo "▶  MySQL Sakila Sample Database 마이그레이션 시작"
echo "   컨테이너: $CONTAINER"
echo ""

# 1. 컨테이너 실행 확인
if ! docker ps --format '{{.Names}}' | grep -q "^${CONTAINER}$"; then
  echo "✗  컨테이너 '$CONTAINER' 가 실행 중이지 않습니다."
  echo "   먼저 'docker compose -f docker/docker-compose.yml up -d' 를 실행하세요."
  exit 1
fi

# 2. MySQL 준비 대기
echo "⏳ MySQL 준비 대기 중..."
until docker exec "$CONTAINER" mysqladmin ping -h localhost -uroot -pchangeme --silent 2>/dev/null; do
  sleep 2
done
echo "✔  MySQL 연결 확인"

# 3. Sakila 다운로드
if [ ! -f "$ZIP_TMP" ]; then
  echo "⬇  Sakila 다운로드 중..."
  curl -# -L "$SAKILA_URL" -o "$ZIP_TMP"
fi
rm -rf "$DIR_TMP" && unzip -q "$ZIP_TMP" -d /tmp/
echo "✔  Sakila 압축 해제 완료"

# 4. SQL 파일 컨테이너로 복사
docker cp "${DIR_TMP}/sakila-schema.sql" "${CONTAINER}:/tmp/sakila-schema.sql"
docker cp "${DIR_TMP}/sakila-data.sql"   "${CONTAINER}:/tmp/sakila-data.sql"

# 5. 스키마 + 데이터 적용
echo "🔄 스키마 적용 중..."
docker exec "$CONTAINER" \
  bash -c "mysql -uroot -pchangeme < /tmp/sakila-schema.sql"

echo "🔄 데이터 적용 중... (시간이 걸릴 수 있습니다)"
docker exec "$CONTAINER" \
  bash -c "mysql -uroot -pchangeme < /tmp/sakila-data.sql"

# 6. 랜덤 비밀번호 생성 + dbuser 계정 생성 (읽기 전용)
DB_USER_PASS=$(openssl rand -base64 32 | tr -dc 'a-zA-Z0-9' | head -c 20)
echo "🔐 dbuser 계정 생성 및 읽기 권한 부여 중..."
docker exec "$CONTAINER" bash -c "mysql -uroot -pchangeme -e \
  \"DROP USER IF EXISTS 'dbuser'@'%'; \
    CREATE USER 'dbuser'@'%' IDENTIFIED BY '${DB_USER_PASS}'; \
    GRANT SELECT ON sakila.* TO 'dbuser'@'%'; \
    FLUSH PRIVILEGES;\""
echo "✔  dbuser 생성 완료 (SELECT 권한만 부여)"

# 7. 자격증명 파일 저장
cat > "$CRED_FILE" << EOF
# MySQL 접속 정보 — $(date +%Y-%m-%d)
DB_HOST=127.0.0.1
DB_PORT=3306
DB_DATABASE=sakila
DB_USER_NAME=dbuser
DB_USER_PASSWORD=${DB_USER_PASS}
EOF
echo "✔  접속 정보 저장 → ${CRED_FILE}"

# .env가 존재하면 자동 반영
if [ -f ".env" ]; then
  sed -i.bak \
    -e "s/^DB_DATABASE=.*/DB_DATABASE=sakila/" \
    -e "s/^DB_USER_NAME=.*/DB_USER_NAME=dbuser/" \
    -e "s/^DB_USER_PASSWORD=.*/DB_USER_PASSWORD=${DB_USER_PASS}/" \
    .env && rm -f .env.bak
  echo "✔  .env 접속 정보 자동 반영 완료"
fi

echo ""
echo "✔  마이그레이션 완료!"
echo "   데이터베이스: sakila"
docker exec "$CONTAINER" \
  bash -c "mysql -uroot -pchangeme sakila -e 'SHOW TABLES;'" 2>/dev/null \
  | awk 'NR>1 { print "  •  " $1 }'
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  접속 정보 (읽기 전용 계정)"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  호스트     : 127.0.0.1"
echo "  포트       : 3306"
echo "  데이터베이스 : sakila"
echo "  유저       : dbuser"
echo "  비밀번호   : ${DB_USER_PASS}"
echo "  저장 위치  : ./${CRED_FILE}"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
