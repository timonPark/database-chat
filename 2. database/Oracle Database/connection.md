# Oracle Connection

`oracledb.createPool()`로 커넥션 풀을 만들어 애플리케이션 수명 동안 재사용합니다. 요청마다 `pool.getConnection()`으로 커넥션을 대여하고 `conn.close()`로 풀에 반납합니다.

## 환경 변수

기준 구현: [`templates/claude-oracle/server.ts:11`](../../templates/claude-oracle/server.ts)

| 변수 | 기본값 | 필수 |
| --- | --- | --- |
| `DB_HOST` | — | ✅ |
| `DB_PORT` | `1521` | |
| `DB_SERVICE_NAME` | — | ✅ |
| `DB_USER_NAME` | — | ✅ |
| `DB_USER_PASSWORD` | — | ✅ |

필수 4종(`DB_HOST`, `DB_SERVICE_NAME`, `DB_USER_NAME`, `DB_USER_PASSWORD`) 중 하나라도 없으면 서버는 즉시 `process.exit(1)`로 종료합니다.

> **주의**: 다른 DB 템플릿과 달리 환경 변수 이름이 `DB_DATABASE`가 아니라 **`DB_SERVICE_NAME`**입니다. Oracle은 데이터베이스 개념이 CDB/PDB·서비스 이름 기반으로 다른 DBMS와 다르기 때문입니다. `.env.example`을 만들 때 이름을 헷갈리지 않도록 주의.

## 계정 권한 (Grant)

`DB_USER_NAME` 계정은 대상 스키마(테이블 소유자)의 **스키마 메타데이터와 데이터를 모두 읽을 수 있는 권한**이 있어야 합니다. 이 권한이 없으면:

- 서버 런타임의 `SELECT`·`EXPLAIN`·`SHOW`·`DESCRIBE` 호출이 실패합니다.
- `seeds/oracle/`의 스키마 생성 파이프라인이 `ALL_TABLES`·`ALL_TAB_COLUMNS`·`ALL_INDEXES` 등 데이터 딕셔너리 조회를 수행하지 못해 테이블 인덱스와 컬럼 스키마 파일을 만들 수 없습니다.

Oracle 최소 요구치는 **`CREATE SESSION` 시스템 권한 + 대상 테이블의 SELECT 오브젝트 권한**입니다. 예:

```sql
-- SYSTEM 또는 SYSDBA 로 실행 (CDB/PDB 환경이면 해당 PDB에 접속 후 실행)
CREATE USER app_reader IDENTIFIED BY "<password>"
  DEFAULT TABLESPACE users
  QUOTA UNLIMITED ON users;

-- 접속 권한
GRANT CREATE SESSION TO app_reader;

-- 데이터 딕셔너리 조회 (스키마 조사 파이프라인용)
GRANT SELECT_CATALOG_ROLE TO app_reader;

-- 대상 스키마의 모든 테이블/뷰에 SELECT 권한
BEGIN
  FOR t IN (SELECT owner, table_name FROM all_tables WHERE owner = '<TARGET_SCHEMA>') LOOP
    EXECUTE IMMEDIATE 'GRANT SELECT ON "' || t.owner || '"."' || t.table_name || '" TO app_reader';
  END LOOP;
END;
/
```

- `SELECT_CATALOG_ROLE`은 `ALL_*` / `DBA_*` 데이터 딕셔너리 뷰의 SELECT 권한을 묶어 제공. 스키마 조사에 편리.
- 신규 테이블에도 자동으로 SELECT를 부여하려면 **오브젝트 소유자가 매번 GRANT를 걸어주는 정책**을 두거나, 스키마 소유자 계정으로 직접 접속(권한 이슈 없음)하는 방식이 필요합니다. Oracle에는 PostgreSQL의 `ALTER DEFAULT PRIVILEGES` 같은 기본 권한 상속이 없습니다.

쓰기·DDL 권한(`CREATE ANY TABLE`, `INSERT`, `UPDATE`, `DELETE`, `DROP`, `ALTER`, `SYSDBA` 등)은 **부여하지 않습니다**. LLM 경유 조회 채널이 실수로도 쓰기 SQL을 만들 수 없도록 계정 자체를 읽기 전용으로 유지합니다. 서버 측 SQL 접두어 검증은 [`query.md`](./query.md#sql-보안-검증) 참고 — 계정 권한과 함께 이중 방어를 구성합니다.

## 커넥션 풀 생성

```ts
oracledb
  .createPool({
    user: DB_USER_NAME,
    password: DB_USER_PASSWORD,
    connectString: `${DB_HOST}:${DB_PORT}/${DB_SERVICE_NAME}`,
    poolMax: 5,
    poolMin: 1,
  })
  .then((createdPool: oracledb.Pool) => {
    pool = createdPool;
    // ...
  });
```

- **`connectString`** — Easy Connect Naming (EZCONNECT) 문법: `HOST:PORT/SERVICE_NAME`. TNSNAMES.ora나 wallet 기반 접속이 필요하면 이 형식 대신 서비스 이름(alias)이나 wallet 경로로 대체해야 합니다 (Thick 모드 필요, [`instant-client.md`](./instant-client.md) 참고).
- **`poolMax: 5` / `poolMin: 1`** — 최소 1개, 최대 5개 커넥션 유지. LLM 조회는 순차적으로 발생하므로 이 이상 늘려도 이득이 적습니다.
- 풀 인스턴스는 모듈 스코프 `let pool: oracledb.Pool`에 저장하고, 요청 핸들러가 참조합니다.

## 연결 시작과 서버 부팅

```ts
oracledb
  .createPool({ ... })
  .then((createdPool) => {
    pool = createdPool;
    console.log(`Oracle 연결 완료: ${DB_HOST}:${DB_PORT}/${DB_SERVICE_NAME}`);
    const server = app.listen(Number(PORT), () => { ... });
  })
  .catch((err: Error) => {
    console.error('Oracle 연결 실패:', err.message);
    process.exit(1);
  });
```

- `createPool()`은 풀을 생성하기만 하고 실제 커넥션은 첫 `getConnection()` 시점에 열립니다. 부팅 성공 로그가 나온다고 실제 리스너까지 도달했다는 뜻은 아니므로, 문제가 있으면 첫 요청에서 드러납니다.
- 풀 생성 실패 시 exit code 1로 종료 → 컨테이너/PM2가 재시작 정책에 따라 재시도.

## 종료 처리

```ts
process.on('SIGINT', async () => {
  await pool.close();
  process.exit(0);
});
process.on('SIGTERM', async () => {
  await pool.close();
  process.exit(0);
});
```

`pool.close()`는 진행 중인 쿼리를 기다린 뒤 모든 커넥션을 정상 종료합니다. 강제 종료가 필요하면 `pool.close(<drainTimeSec>)`으로 초 단위 유예 시간을 지정.

## 커넥션 반납

모든 요청 핸들러는 `try/finally`로 반납을 보장합니다:

```ts
let conn: oracledb.Connection | null = null;
try {
  conn = await pool.getConnection();
  const result = await conn.execute(sql, [], {
    outFormat: oracledb.OUT_FORMAT_OBJECT,
    maxRows: limit,
    fetchArraySize: 100,
  });
  // ...
} finally {
  if (conn) {
    try { await conn.close(); } catch { /* 무시 */ }
  }
}
```

`conn.close()`는 커넥션을 풀에 **반납**합니다(물리적 종료가 아님). 빠뜨리면 `poolMax: 5`가 소진된 뒤 이후 요청이 대기 상태에 들어갑니다.

## 쿼리 타임아웃

Oracle 템플릿에는 `mysql2`처럼 개별 `execute()` 옵션으로 타임아웃을 지정하는 훅이 코드에 명시적으로 걸려 있지 않습니다. 서버 측 상한은 `oracledb.callTimeout`(밀리초) 커넥션 프로퍼티로 강제하거나, DBA 측 리소스 매니저(Resource Manager)로 세션당 CPU/실행 시간 상한을 두는 방식이 표준입니다.

취소·타임아웃 발생 시 Oracle은 오류 코드 **ORA-01013** (`errorNum: 1013`, `user requested cancel of current operation`)로 요청을 취소합니다. 서버는 이를 감지해 HTTP 504로 응답합니다:

```ts
const DB_TIMEOUT_MS: number = 30_000;
const DB_TIMEOUT_MSG: string = 'DB 응답시간 초과 Max 30초';

function isTimeoutError(err: unknown): boolean {
  return (err as { errorNum?: number }).errorNum === 1013;
}
```

새 조합 템플릿에서 애플리케이션 레벨에서 30초 상한을 강제하려면 `getConnection()` 이후 `conn.callTimeout = 30_000`을 설정합니다. 그러면 `callTimeout`을 초과한 요청이 ORA-01013으로 취소되어 위 핸들러가 동작합니다.

## 새 조합 템플릿 만들 때 체크리스트

1. 위 5개 환경 변수(`DB_HOST`, `DB_PORT`, `DB_SERVICE_NAME`, `DB_USER_NAME`, `DB_USER_PASSWORD`)를 `.env.example`에 명시. **`DB_DATABASE`가 아니라 `DB_SERVICE_NAME`**임을 강조.
2. 계정에 `CREATE SESSION` + `SELECT_CATALOG_ROLE` + 대상 스키마 테이블 SELECT 권한이 부여돼 있는지 확인. 쓰기·DDL 권한은 부여하지 않습니다.
3. 풀 옵션(`poolMax`, `poolMin`) 유지 — 값을 바꾸려면 이 문서를 먼저 갱신하고 통일된 규약으로 반영.
4. 풀 생성은 모듈 최상단에서 1회, `let pool`에 저장.
5. `try/finally`로 `conn.close()` 반드시 호출.
6. `SIGINT`/`SIGTERM` 핸들러에서 `pool.close()`를 반드시 호출.
7. 30초 상한을 강제하려면 대여한 커넥션에 `conn.callTimeout = 30_000` 설정.
