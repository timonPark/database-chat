# PostgreSQL Connection

`pg` (node-postgres) `Pool`로 커넥션 풀을 만들어 애플리케이션 수명 동안 재사용합니다. 요청마다 `pool.connect()`로 커넥션을 대여하고 `client.release()`로 반납합니다.

## 환경 변수

기준 구현: [`templates/claude-postgresql/server.ts:11`](../../templates/claude-postgresql/server.ts)

| 변수 | 기본값 | 필수 |
| --- | --- | --- |
| `DB_HOST` | — | ✅ |
| `DB_PORT` | `5432` | |
| `DB_DATABASE` | — | ✅ |
| `DB_USER_NAME` | — | ✅ |
| `DB_USER_PASSWORD` | — | ✅ |

필수 4종(`DB_HOST`, `DB_DATABASE`, `DB_USER_NAME`, `DB_USER_PASSWORD`) 중 하나라도 없으면 서버는 즉시 `process.exit(1)`로 종료합니다.

## 계정 권한 (Grant)

`DB_USER_NAME` 계정은 대상 DB에 대해 **스키마(카탈로그·컬럼 메타데이터)와 데이터를 모두 읽을 수 있는 권한**이 있어야 합니다. 이 권한이 없으면:

- 서버 런타임의 `SELECT`·`WITH`·`EXPLAIN` 호출이 실패합니다.
- `seeds/postgresql/`의 스키마 생성 파이프라인이 `information_schema` / `pg_catalog` 조회를 수행하지 못해 테이블 인덱스와 컬럼 스키마 파일을 만들 수 없습니다.

PostgreSQL 최소 요구치는 대상 DB **연결 권한 + 스키마 사용 권한 + 테이블 SELECT 권한**입니다. 예:

```sql
-- 관리자(superuser) 계정으로 실행
CREATE ROLE app_reader WITH LOGIN PASSWORD '<password>';

-- DB 접속 권한
GRANT CONNECT ON DATABASE "<target-db>" TO app_reader;

-- 스키마 사용 권한 (기본은 public, 필요 시 추가 스키마도)
GRANT USAGE ON SCHEMA public TO app_reader;

-- 기존 테이블 SELECT 권한
GRANT SELECT ON ALL TABLES IN SCHEMA public TO app_reader;

-- 앞으로 만들어질 테이블도 자동으로 SELECT 허용
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT ON TABLES TO app_reader;
```

`information_schema` / `pg_catalog`는 별도 GRANT 없이도 모든 롤이 조회할 수 있으므로 스키마 조회는 자동으로 됩니다.

쓰기·유지보수 권한(`INSERT`, `UPDATE`, `DELETE`, `TRUNCATE`, `REFERENCES`, `TRIGGER`, `CREATE`, `TEMPORARY`)은 **부여하지 않습니다**. LLM 경유 조회 채널이 실수로도 쓰기 SQL을 만들 수 없도록 계정 자체를 읽기 전용으로 유지합니다. 서버 측 SQL 키워드 차단은 [`query.md`](./query.md#sql-보안-검증) 참고 — 계정 권한과 함께 이중 방어를 구성합니다.

## 커넥션 풀 생성

```ts
const pool: Pool = new Pool({
  host: DB_HOST,
  port: Number(DB_PORT),
  database: DB_DATABASE,
  user: DB_USER_NAME,
  password: DB_USER_PASSWORD,
  max: 5,
  connectionTimeoutMillis: 10_000,
});
```

- **`max: 5`** — 풀 최대 커넥션 5개로 고정. LLM 조회는 순차적으로 발생하므로 이 이상 늘려도 이득이 적습니다.
- **`connectionTimeoutMillis: 10_000`** — 풀에서 커넥션을 얻기까지의 상한 10초. 쿼리 실행 타임아웃(30초)과 별개입니다.
- 풀 인스턴스는 모듈 최상단에서 한 번만 만들고, 요청 핸들러가 참조합니다.

## 연결 시작과 서버 부팅

```ts
async function startServer(): Promise<void> {
  const client: PoolClient = await pool.connect();
  client.release();
  console.log(`PostgreSQL 연결 완료: ${DB_HOST}:${DB_PORT}/${DB_DATABASE}`);

  const server: Server = app.listen(Number(PORT), () => {
    console.log(`서버 실행 중: http://localhost:${PORT}`);
  });
}

startServer().catch((err: Error) => {
  console.error('PostgreSQL 연결 실패:', err.message);
  process.exit(1);
});
```

- 부팅 시 풀에서 커넥션 하나를 뽑아 헬스체크만 하고 즉시 반납합니다(`client.release()`).
- 연결 실패 시 exit code 1로 종료 → 컨테이너/PM2가 재시작 정책에 따라 재시도.

## 종료 처리

```ts
process.on('SIGINT', async () => {
  await pool.end();
  process.exit(0);
});
process.on('SIGTERM', async () => {
  await pool.end();
  process.exit(0);
});
```

`pool.end()`는 진행 중인 쿼리를 기다린 뒤 모든 커넥션을 정상 종료합니다.

## 쿼리 타임아웃

`pg`는 `mysql2`처럼 `query()` 옵션으로 타임아웃을 넣을 수 없으므로 **세션 단위 `statement_timeout`을 SET LOCAL로 걸어** 상한을 강제합니다.

```ts
const DB_TIMEOUT_MS: number = 30_000;
const DB_TIMEOUT_MSG: string = 'DB 응답시간 초과 Max 30초';

const client: PoolClient = await pool.connect();
try {
  await client.query(`SET LOCAL statement_timeout = '${DB_TIMEOUT_MS}'`);
  const result = await client.query(sql, params);
  // ...
} finally {
  client.release();
}
```

- `SET LOCAL`은 트랜잭션 스코프. 트랜잭션이 아니어도 세션(=현재 커넥션)에만 적용되고 풀 반납 시 초기화됩니다.
- 타임아웃 시 PostgreSQL은 error code **`57014`** (`query_canceled`)로 요청을 취소합니다. 서버는 이를 감지해 HTTP 504로 응답합니다.

```ts
function isTimeoutError(err: unknown): boolean {
  return (err as { code?: string }).code === '57014';
}
```

## 커넥션 반납

모든 요청 핸들러는 `try/finally`로 반납을 보장합니다:

```ts
const client = await pool.connect();
try {
  // 쿼리 실행
} finally {
  client.release();
}
```

`release()`를 빠뜨리면 커넥션이 풀에서 회수되지 않아 `max: 5`가 소진된 뒤 `connectionTimeoutMillis`(10초) 이후 모든 요청이 실패합니다.

## 새 조합 템플릿 만들 때 체크리스트

1. 위 5개 환경 변수(`DB_HOST` ~ `DB_USER_PASSWORD`)를 `.env.example`에 명시.
2. 계정에 대상 DB의 `CONNECT` + 스키마 `USAGE` + 테이블 `SELECT` 권한이 부여돼 있는지 확인. `ALTER DEFAULT PRIVILEGES`로 미래 테이블에도 자동 적용. 쓰기·유지보수 권한은 부여하지 않습니다.
3. 풀 옵션(`max`, `connectionTimeoutMillis`) 유지 — 값을 바꾸려면 이 문서를 먼저 갱신하고 통일된 규약으로 반영.
4. 풀 생성은 모듈 최상단에서 1회. 요청마다 새로 만들지 않습니다.
5. 부팅 시 헬스체크(`pool.connect()` → `release()`) 성공 후에만 `app.listen()`을 호출하는 순서 유지.
6. 모든 `client.query()` 호출 전에 `SET LOCAL statement_timeout = '30000'` 실행.
7. `try/finally`로 `client.release()` 반드시 호출.
8. `SIGINT`/`SIGTERM` 핸들러에서 `pool.end()`를 반드시 호출.
