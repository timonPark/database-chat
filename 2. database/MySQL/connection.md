# MySQL Connection

`mysql2/promise`로 커넥션 풀을 만들어 애플리케이션 수명 동안 재사용합니다. 요청마다 새 커넥션을 열지 않고, 풀에서 커넥션을 대여·반납합니다.

## 환경 변수

기준 구현: [`templates/claude-mysql/server.ts:12`](../../templates/claude-mysql/server.ts)

| 변수 | 기본값 | 필수 |
| --- | --- | --- |
| `DB_HOST` | — | ✅ |
| `DB_PORT` | `3306` | |
| `DB_DATABASE` | — | ✅ |
| `DB_USER_NAME` | — | ✅ |
| `DB_USER_PASSWORD` | — | ✅ |

필수 4종(`DB_HOST`, `DB_DATABASE`, `DB_USER_NAME`, `DB_USER_PASSWORD`) 중 하나라도 없으면 서버는 즉시 `process.exit(1)`로 종료합니다.

## 계정 권한 (Grant)

`DB_USER_NAME` 계정은 대상 DB(및 그 안의 모든 테이블)에 대해 **스키마(테이블·컬럼 메타데이터)와 데이터를 모두 읽을 수 있는 권한**이 있어야 합니다. 이 권한이 없으면:

- 서버 런타임의 `SELECT`·`EXPLAIN`·`SHOW`·`DESCRIBE` 호출이 실패합니다.
- `seeds/mysql/`의 스키마 생성 파이프라인이 `information_schema` 조회, `SHOW CREATE TABLE`, `SHOW INDEX` 등을 수행하지 못해 테이블 인덱스와 컬럼 스키마 파일을 만들 수 없습니다.

MySQL 최소 요구치는 대상 DB에 대한 **`SELECT`** 권한입니다. 예:

```sql
-- root 계정으로 실행
CREATE USER 'app_reader'@'%' IDENTIFIED BY '<password>';
GRANT SELECT ON `<target-db>`.* TO 'app_reader'@'%';
-- (선택) 전체 DB의 스키마 열람이 필요하면
GRANT SELECT ON `information_schema`.* TO 'app_reader'@'%';
FLUSH PRIVILEGES;
```

쓰기 권한(`INSERT`, `UPDATE`, `DELETE`, `DROP`, `ALTER`, `CREATE`, `TRUNCATE`, `FILE` 등)은 **부여하지 않습니다**. LLM 경유 조회 채널이 실수로도 쓰기 SQL을 만들 수 없도록 계정 자체를 읽기 전용으로 유지합니다. 서버 측 SQL 키워드 차단은 [`query.md`](./query.md#sql-보안-검증) 참고 — 계정 권한과 함께 이중 방어를 구성합니다.

## 커넥션 풀 생성

```ts
const pool: Pool = mysql.createPool({
  host: DB_HOST,
  port: Number(DB_PORT),
  database: DB_DATABASE,
  user: DB_USER_NAME,
  password: DB_USER_PASSWORD,
  connectionLimit: 5,
  timezone: '+00:00',
  connectTimeout: 10_000,
});
```

- **`connectionLimit: 5`** — 소규모 데모 서버라 5로 고정. LLM 조회는 순차적으로 발생하므로 이 이상 늘려도 이득이 적습니다.
- **`timezone: '+00:00'`** — 서버가 반환하는 `DATETIME`·`TIMESTAMP`를 UTC로 해석. 세션/DB의 실제 timezone과 무관하게 응답 시각이 일관되도록 고정합니다. 자세한 내용은 [`type-conversion.md`](./type-conversion.md#datedatetimetimestamp) 참고.
- **`connectTimeout: 10_000`** — 초기 TCP 연결 상한 10초. 쿼리 실행 타임아웃(30초)과 별개입니다.
- 풀 인스턴스는 모듈 최상단에서 한 번만 만들고, 요청 핸들러가 참조합니다.

## 연결 시작과 서버 부팅

```ts
pool.getConnection()
  .then(conn => {
    conn.release();
    console.log(`MySQL 연결 완료: ${DB_HOST}:${DB_PORT}/${DB_DATABASE}`);
    const server = app.listen(Number(PORT), () => {
      console.log(`서버 실행 중: http://localhost:${PORT}`);
    });
  })
  .catch((err: Error) => {
    console.error('MySQL 연결 실패:', err.message);
    process.exit(1);
  });
```

- 부팅 시 풀에서 커넥션 하나를 뽑아 헬스체크만 하고 즉시 반납합니다(`conn.release()`).
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

```ts
const DB_TIMEOUT_MS: number = 30_000;
const DB_TIMEOUT_MSG: string = 'DB 응답시간 초과 Max 30초';

await pool.query<RowDataPacket[]>({ sql: finalSql, timeout: DB_TIMEOUT_MS });
```

- 모든 `pool.query()` 호출에 `timeout: 30_000` 옵션을 붙입니다.
- 타임아웃 시 `mysql2`는 `err.code === 'PROTOCOL_SEQUENCE_TIMEOUT'` 혹은 메시지에 `Timeout` 포함으로 throw — 서버는 이를 감지해 HTTP 504로 응답합니다.

```ts
function isTimeoutError(err: unknown): boolean {
  const e = err as { code?: string; message?: string };
  return e.code === 'PROTOCOL_SEQUENCE_TIMEOUT' || (e.message ?? '').includes('Timeout');
}
```

## 새 조합 템플릿 만들 때 체크리스트

1. 위 5개 환경 변수(`DB_HOST` ~ `DB_USER_PASSWORD`)를 `.env.example`에 명시.
2. 계정에 대상 DB의 `SELECT` 권한이 부여돼 있는지 확인 — 스키마(`information_schema`, `SHOW CREATE TABLE`)와 데이터(`SELECT`) 조회 권한이 모두 필요합니다. 쓰기·파일 권한은 부여하지 않습니다.
3. 풀 옵션(`connectionLimit`, `timezone`, `connectTimeout`) 유지 — 값을 바꾸려면 이 문서를 먼저 갱신하고 통일된 규약으로 반영.
4. 풀 생성은 모듈 최상단에서 1회. 요청마다 새로 만들지 않습니다.
5. `pool.getConnection()` 헬스체크 성공 후에만 `app.listen()`을 호출하는 순서 유지.
6. `SIGINT`/`SIGTERM` 핸들러에서 `pool.end()`를 반드시 호출.
