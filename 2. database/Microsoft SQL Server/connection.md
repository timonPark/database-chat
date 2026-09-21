# MSSQL Connection

`mssql` 노드 드라이버(내부적으로 `tedious` 프로토콜 구현체 사용)로 `ConnectionPool`을 만들어 애플리케이션 수명 동안 재사용합니다. 요청마다 `pool.request()`로 요청 컨텍스트를 얻고 `query()`를 호출합니다.

## 환경 변수

기준 구현: [`templates/claude-mssql/server.ts:11`](../../templates/claude-mssql/server.ts)

| 변수 | 기본값 | 필수 |
| --- | --- | --- |
| `DB_HOST` | — | ✅ |
| `DB_PORT` | `1433` | |
| `DB_DATABASE` | — | ✅ |
| `DB_USER_NAME` | — | ✅ |
| `DB_USER_PASSWORD` | — | ✅ |

필수 4종(`DB_HOST`, `DB_DATABASE`, `DB_USER_NAME`, `DB_USER_PASSWORD`) 중 하나라도 없으면 서버는 즉시 `process.exit(1)`로 종료합니다.

## 계정 권한 (Permission)

`DB_USER_NAME` 계정은 대상 데이터베이스에 대해 **스키마(카탈로그) 조회와 데이터 조회를 모두 할 수 있는 권한**이 있어야 합니다. 이 권한이 없으면:

- 서버 런타임의 `SELECT`·`EXPLAIN`(=`SET SHOWPLAN_ALL` 등)·`sp_help`·`INFORMATION_SCHEMA` 조회가 실패합니다.
- `seeds/mssql/`의 스키마 생성 파이프라인이 `INFORMATION_SCHEMA.COLUMNS`·`sys.tables`·`sys.indexes` 등을 조회하지 못해 테이블 인덱스와 컬럼 스키마 파일을 만들 수 없습니다.

SQL Server 최소 요구치는 대상 DB의 **`db_datareader` 롤 + `VIEW DEFINITION` 권한**입니다. 예:

```sql
-- master 로 접속해 로그인 생성
CREATE LOGIN app_reader WITH PASSWORD = '<password>';

-- 대상 DB 로 전환 후 사용자 매핑
USE [<target-db>];
CREATE USER app_reader FOR LOGIN app_reader;

-- 모든 테이블/뷰의 SELECT 권한 (읽기 전용 롤)
ALTER ROLE db_datareader ADD MEMBER app_reader;

-- 스키마·인덱스 등 오브젝트 정의 조회 권한 (스키마 파이프라인용)
GRANT VIEW DEFINITION TO app_reader;

-- (선택) 실행 계획 조회
GRANT SHOWPLAN TO app_reader;
```

`INFORMATION_SCHEMA` 뷰는 별도 GRANT 없이도 사용자 자신에게 접근 권한이 있는 오브젝트만 반환하므로, `db_datareader`만 있어도 자기 스키마 조사에는 대체로 충분합니다. 전체 카탈로그가 필요하면 `VIEW DEFINITION` 추가.

쓰기·DDL·관리 권한(`db_datawriter`, `db_ddladmin`, `db_owner`, `INSERT`/`UPDATE`/`DELETE` 개별 GRANT, `sysadmin` 서버 롤 등)은 **부여하지 않습니다**. LLM 경유 조회 채널이 실수로도 쓰기 T-SQL을 만들 수 없도록 계정 자체를 읽기 전용으로 유지합니다. 서버 측 SQL 접두어 검증은 [`query.md`](./query.md#sql-보안-검증) 참고 — 계정 권한과 함께 이중 방어를 구성합니다.

## 풀 생성 (`sql.connect`)

```ts
sql
  .connect({
    server: DB_HOST!,
    port: Number(DB_PORT),
    database: DB_DATABASE,
    user: DB_USER_NAME,
    password: DB_USER_PASSWORD,
    options: { trustServerCertificate: true, enableArithAbort: true },
    connectionTimeout: 10000,
    requestTimeout: 30000,
    pool: { max: 5, min: 1 },
  })
  .then((connPool: sql.ConnectionPool) => {
    pool = connPool;
    // app.listen(...)
  });
```

옵션별 의미:

- **`server` / `port` / `database` / `user` / `password`** — 표준 접속 정보. `mssql`은 host 필드 이름이 `server`입니다.
- **`options.trustServerCertificate: true`** — 서버가 자체 서명 인증서를 쓰거나 CA 체인 검증을 스킵하고 접속. **개발·데모 편의를 위한 설정**이며 프로덕션에서는 정식 인증서를 세팅하고 이 값을 `false`로 두는 것을 권장합니다.
- **`options.enableArithAbort: true`** — SQL Server 세션 옵션 `SET ARITHABORT ON` 상당. 인덱스가 있는 계산 컬럼·인덱싱된 뷰가 있을 때 쿼리 최적화기가 인덱스를 활용하기 위한 요구사항. 성능 안정성 관점에서 표준값으로 유지.
- **`connectionTimeout: 10_000`** — 첫 TCP/TDS handshake 상한 10초. 이 시간을 넘기면 접속 실패.
- **`requestTimeout: 30_000`** — 개별 쿼리 실행 상한 30초. 이 값은 풀 레벨 기본값이고, 요청마다 `request.timeout`으로 오버라이드 가능([`query.md`](./query.md) 참고).
- **`pool: { max: 5, min: 1 }`** — 최소 1개, 최대 5개 커넥션 유지. LLM 조회는 순차적으로 발생하므로 이 이상 늘려도 이득이 적습니다.

풀 인스턴스는 모듈 스코프 `let pool: sql.ConnectionPool`에 저장하고, 요청 핸들러가 참조합니다.

## 연결 시작과 서버 부팅

```ts
sql.connect({ ... })
  .then((connPool) => {
    pool = connPool;
    console.log(`MSSQL 연결 완료: ${DB_HOST}:${DB_PORT}/${DB_DATABASE}`);
    const server = app.listen(Number(PORT), () => { ... });
  })
  .catch((err: Error) => {
    console.error('MSSQL 연결 실패:', err.message);
    process.exit(1);
  });
```

- `sql.connect()` Promise가 resolve될 때 실제 커넥션이 열려 있으므로, 이후 `app.listen()`은 안전하게 실행됩니다.
- 연결 실패 시 exit code 1로 종료 → 컨테이너/PM2가 재시작 정책에 따라 재시도.

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

`pool.close()`는 진행 중인 쿼리를 기다린 뒤 모든 커넥션을 정상 종료합니다.

## 쿼리 타임아웃

풀 옵션의 `requestTimeout: 30_000`이 기본값이고, 각 요청에서 명시적으로 다시 설정하는 것이 서버의 관례:

```ts
const DB_TIMEOUT_MSG: string = 'DB 응답시간 초과 Max 30초';

const request = pool.request();
request.timeout = 30_000;
const result = await request.query(sqlStr);
```

타임아웃 시 `mssql`은 메시지에 `'Timeout'` 또는 `'timeout'` 문자열이 포함된 Error를 throw. 오류 코드가 아닌 **메시지 문자열로 감지**하는 것이 이 템플릿의 관례입니다:

```ts
function isTimeoutError(err: unknown): boolean {
  const msg = (err as Error).message ?? '';
  return msg.includes('Timeout') || msg.includes('timeout');
}
```

이 방식은 프레임워크가 바뀌면(예: `mssql` 메시지 텍스트가 변경) 감지가 실패할 수 있는 취약점이지만, 현재 `mssql` 6.x 계열에서 재현 가능하게 동작하고 있습니다. 감지에 실패해도 HTTP 500 + 원본 메시지가 그대로 응답에 담기므로 클라이언트가 원인 파악은 가능합니다.

## 새 조합 템플릿 만들 때 체크리스트

1. 위 5개 환경 변수(`DB_HOST` ~ `DB_USER_PASSWORD`)를 `.env.example`에 명시.
2. 계정에 `db_datareader` 롤 + `VIEW DEFINITION` (필요 시 `SHOWPLAN`) 권한이 부여돼 있는지 확인. 쓰기·DDL·관리 권한은 부여하지 않습니다.
3. 풀 옵션(`pool.max`, `pool.min`, `connectionTimeout`, `requestTimeout`) 유지 — 값을 바꾸려면 이 문서를 먼저 갱신하고 통일된 규약으로 반영.
4. **프로덕션에서는 `options.trustServerCertificate`를 `false`로 두고 정식 인증서를 사용.**
5. `options.enableArithAbort: true`는 유지 — 성능·인덱스 활용 안정성 관점에서 표준값.
6. 풀 생성은 모듈 최상단에서 1회, `let pool`에 저장.
7. 각 요청 핸들러에서 `request.timeout = 30_000`을 명시.
8. `SIGINT`/`SIGTERM` 핸들러에서 `pool.close()`를 반드시 호출.
