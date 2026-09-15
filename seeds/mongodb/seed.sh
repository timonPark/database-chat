#!/usr/bin/env bash
# MongoDB — Atlas Sample Datasets 마이그레이션 (단일 DB 통합)
set -euo pipefail

CONTAINER="{{PROJECT_NAME}}-mongodb"
TARGET_DB="sample_data"
ARCHIVE_URL="https://atlas-education.s3.amazonaws.com/sampledata.archive"
ARCHIVE_TMP="/tmp/sampledata.archive"

echo "▶  MongoDB Atlas Sample Datasets 마이그레이션 시작"
echo "   컨테이너: $CONTAINER"
echo "   대상 DB : $TARGET_DB (모든 컬렉션을 하나의 DB로 통합)"
echo ""

# 1. 컨테이너 실행 확인
if ! docker ps --format '{{.Names}}' | grep -q "^${CONTAINER}$"; then
  echo "✗  컨테이너 '$CONTAINER' 가 실행 중이지 않습니다."
  echo "   먼저 'docker compose -f docker/docker-compose.yml up -d' 를 실행하세요."
  exit 1
fi

# 2. MongoDB 준비 대기
echo "⏳ MongoDB 준비 대기 중..."
until docker exec "$CONTAINER" mongosh --quiet \
  --username root --password changeme --authenticationDatabase admin \
  --eval "db.adminCommand({ ping: 1 })" > /dev/null 2>&1; do
  sleep 2
done
echo "✔  MongoDB 연결 확인"

# 3. 아카이브 다운로드 (~50MB)
if [ ! -f "$ARCHIVE_TMP" ]; then
  echo "⬇  Atlas Sample 아카이브 다운로드 중... (~50MB)"
  curl -# -L "$ARCHIVE_URL" -o "$ARCHIVE_TMP"
else
  echo "✔  아카이브 캐시 사용: $ARCHIVE_TMP"
fi

# 4. 컨테이너로 복사
echo "📦 컨테이너로 파일 복사 중..."
docker cp "$ARCHIVE_TMP" "${CONTAINER}:/tmp/sampledata.archive"

# 5. mongorestore — 모든 sample_* DB를 $TARGET_DB 하나로 통합
#    컬렉션명: <원본DB prefix>_<컬렉션명>  예) mflix_movies, analytics_accounts
echo "🔄 mongorestore 실행 중... (시간이 걸릴 수 있습니다)"
docker exec "$CONTAINER" mongorestore \
  --username root \
  --password changeme \
  --authenticationDatabase admin \
  --archive=/tmp/sampledata.archive \
  --drop \
  --nsFrom "sample_airbnb.*"     --nsTo "${TARGET_DB}.airbnb_*" \
  --nsFrom "sample_analytics.*"  --nsTo "${TARGET_DB}.analytics_*" \
  --nsFrom "sample_geospatial.*" --nsTo "${TARGET_DB}.geospatial_*" \
  --nsFrom "sample_guides.*"     --nsTo "${TARGET_DB}.guides_*" \
  --nsFrom "sample_mflix.*"      --nsTo "${TARGET_DB}.mflix_*" \
  --nsFrom "sample_restaurants.*" --nsTo "${TARGET_DB}.restaurants_*" \
  --nsFrom "sample_supplies.*"   --nsTo "${TARGET_DB}.supplies_*" \
  --nsFrom "sample_training.*"   --nsTo "${TARGET_DB}.training_*" \
  --nsFrom "sample_weatherdata.*" --nsTo "${TARGET_DB}.weatherdata_*"

echo ""
echo "✔  마이그레이션 완료!"

# 6. .env 자동 업데이트 (listing 전에 먼저 실행)
ENV_FILE="$(dirname "$0")/../.env"
if [ -f "$ENV_FILE" ]; then
  sed -i.bak "s|^DB_DATABASE=.*|DB_DATABASE=${TARGET_DB}|" "$ENV_FILE" && rm -f "${ENV_FILE}.bak"
  echo "✔  .env DB_DATABASE=${TARGET_DB} 업데이트 완료"
fi

echo ""
echo "💡 생성된 컬렉션 목록:"
docker exec "$CONTAINER" mongosh --quiet \
  --username root --password changeme --authenticationDatabase admin \
  --eval "db.getSiblingDB('${TARGET_DB}').getCollectionNames().sort().forEach(c => print('  •  ${TARGET_DB}.' + c))"
