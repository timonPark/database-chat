# PostgreSQL Query — `/db-query`

읽기 전용 SQL을 실행하는 **단일 엔드포인트**. `SELECT`·`WITH`·`EXPLAIN`을 모두 이 엔드포인트에서 처리합니다. JOIN·GROUP BY·CTE·윈도우 함수를 쓰는 복합 SELECT도 같은 엔드포인트로 갑니다 — 자세한 SQL 패턴은 [`join-group.md`](./join-group.md) 참고.

기준 구현: [`templates/claude-postgresql/server.ts:368`](../../templates/claude-postgresql/server.ts)

## 요청 스펙

`POST /db-query`

```json
{
  "requestId": "req-abc-123",
  "sql": "SELECT id, name, email FROM users WHERE status = $1 AND created_at >= $2 ORDER BY created_at DESC LIMIT 20",
  "params": ["active", "2024-01-01"]
}
```

| 필드 | 타입 | 필수 | 기본값 |
| --- | --- | --- | --- |
| `requestId` | string | | — (엑셀 내보내기용 SQL 저장 키) |
| `sql` | string | ✅ | — |
| `params` | array | | `[]` |

`sql`이 비어 있으면 400 반환.

## SQL 보안 검증

파이프라인 실행 전에 접두어와 금지 키워드를 확인합니다.

```ts
const ALLOWED_SQL_PREFIXES = ['SELECT', 'WITH', 'EXPLAIN'];
const BLOCKED_SQL_KEYWORDS = /\b(INSERT|UPDATE|DELETE|DROP|TRUNCATE|ALTER|CREATE|REPLACE|GRANT|REVOKE|COPY|VACUUM|ANALYZE)\b/i;

function validateSql(sql: string): void {
  const trimmed = sql.trim().toUpperCase();
  const allowed = ALLOWED_SQL_PREFIXES.some(prefix => trimmed.startsWith(prefix));
  if (!allowed) {
    throw new Error('SELECT / WITH / EXPLAIN 으로 시작하는 읽기 전용 쿼리만 허용됩니다.');
  }
  if (BLOCKED_SQL_KEYWORDS.test(sql)) {
    throw new Error('허용되지 않는 SQL 키워드가 포함되어 있습니다.');
  }
}
```

- **접두어 화이트리스트**: `SELECT` / `WITH`(CTE) / `EXPLAIN`. `WITH`가 허용되므로 CTE 시작 SQL을 그대로 실행할 수 있습니다.
- **금지 키워드 블랙리스트**: 위 정규식 매칭 시 즉시 실패. PostgreSQL 특유의 `COPY`·`VACUUM`·`ANALYZE`도 차단 대상 — 데이터 유출(`COPY TO`)과 유지보수 명령을 원천 봉쇄.
- 검증 실패 시 400 + 사유 반환.

이 검증은 계정 권한(읽기 전용, [`connection.md`](./connection.md#계정-권한-grant) 참고)과 함께 이중 방어를 구성합니다. 계정에 쓰기 권한이 없더라도 프리플라이트 단계에서 즉시 차단하는 것이 목적.

## 파라미터 바인딩

`params` 배열은 SQL의 `$1`, `$2`, ... placeholder에 순서대로 바인딩됩니다. `pg` 드라이버가 서버에 별도 prepare 요청을 보내 값이 SQL 텍스트로 문자열 치환되지 않으므로 SQL 인젝션이 발생하지 않습니다.

```ts
const result = await client.query(sql, params as unknown[]);
```

- 동적 값(사용자 입력, 날짜, 정수, 배열)은 항상 `$N` + `params`로 넘길 것.
- 반대로 테이블명·컬럼명·정렬 방향처럼 **식별자**는 placeholder로 바인딩할 수 없습니다 — 필요하면 화이트리스트 기반 조립이 필요합니다.
- LLM 프롬프트는 값 리터럴을 SQL 안에 직접 넣도록 유도하고 있어(예: `WHERE phone = '01012345678'`), `params` 활용은 새 조합 템플릿을 만들 때 선택적으로 활성화할 수 있는 기능입니다. 서버 측 기능은 제공되어 있으므로 프롬프트만 조정하면 됩니다.

## `LIMIT` 자동 부착 없음

MySQL 템플릿의 `/db-query`와 달리 PostgreSQL 템플릿은 **`LIMIT`을 서버가 부착하지 않습니다**.

- LLM 프롬프트가 `LIMIT ${limit}`을 SQL 안에 반드시 포함하도록 강제합니다.
- LIMIT 없이 대량 결과가 나오면 응답 크기·응답 시간이 폭주할 수 있으므로 프롬프트 규약 준수가 중요합니다.

## 실행 흐름

```ts
const client: PoolClient = await pool.connect();
try {
  await client.query(`SET LOCAL statement_timeout = '${DB_TIMEOUT_MS}'`);
  const result = await client.query(sql, params as unknown[]);
  const rows = removeSensitiveColumns(result.rows as Record<string, unknown>[]);

  if (rows.length === 0) {
    return res.json({ count: 0, data: [], dbTimeMs, message: '조회된 데이터가 없습니다. ...' });
  }
  return res.json({ count: rows.length, data: rows, dbTimeMs });
} finally {
  client.release();
}
```

1. 풀에서 커넥션 대여.
2. `SET LOCAL statement_timeout`으로 세션 타임아웃 30초 강제 — 자세한 내용은 [`connection.md`](./connection.md#쿼리-타임아웃) 참고.
3. SQL + params 실행.
4. 민감 컬럼 제거 후 응답.
5. `finally`로 커넥션 반납 보장.

## 민감 컬럼 자동 제거

```ts
const SENSITIVE_COLUMNS = ['password', 'pass_hash', 'passwd', 'pwd', 'secret'];

function removeSensitiveColumns(rows: Record<string, unknown>[]): Record<string, unknown>[] {
  return rows.map(row => {
    const clean = { ...row };
    for (const col of SENSITIVE_COLUMNS) delete clean[col];
    return clean;
  });
}
```

응답 rows 각각에서 위 컬럼명(정확 일치)을 삭제합니다. `SELECT *`나 실수로 민감 컬럼을 포함한 SELECT도 응답에는 반영되지 않습니다. `MAX(password)` 같은 우회 형태는 컬럼 별칭이 바뀌므로 필터되지 않으니, 이런 경우는 SELECT 목록에서 애초에 제외하도록 프롬프트로 유도합니다.

## 응답 스펙

정상:

```json
{
  "count": 12,
  "data": [ { "id": 1, "name": "..." }, ... ],
  "dbTimeMs": 24
}
```

> **참고**: PostgreSQL 템플릿의 `count`는 응답 rows 수와 동일합니다(`rows.length`). 별도의 `COUNT(*)`로 총 건수를 계산하지 않습니다. 사용자에게 "총 몇 건"인지 정확한 값이 필요하면 LLM이 `SELECT COUNT(*) FROM ...`을 별도로 실행해야 합니다.

0건:

```json
{
  "count": 0,
  "data": [],
  "dbTimeMs": 5,
  "message": "조회된 데이터가 없습니다. 추가 쿼리 없이 즉시 이 메시지를 사용자에게 전달하라."
}
```

검증 실패:

```
HTTP/1.1 400 Bad Request
{ "error": "SELECT / WITH / EXPLAIN 으로 시작하는 읽기 전용 쿼리만 허용됩니다." }
```

타임아웃 (30초 초과):

```
HTTP/1.1 504 Gateway Timeout
{ "error": "DB 응답시간 초과 Max 30초" }
```

기타 오류: HTTP 500 + `{ "error": "..." }`.

## `requestId`와 엑셀 내보내기

`requestId`가 오면 `sql`과 `params`를 그대로 `queryParamsStore`에 저장합니다.

```ts
if (requestId) queryParamsStore.set(requestId, { sql, params });
queryParamsStore.set('__latest__', { sql, params });
```

`POST /db-export`가 같은 `requestId`로 호출되면 저장된 SQL/params를 **그대로** 재실행합니다. LIMIT을 벗겨서 전체 결과를 뽑지는 않습니다 — 엑셀 내보내기는 "화면에 보인 것 그대로" 규약.

`__latest__` 폴백 키는 `requestId`를 잃어버린 클라이언트가 마지막 쿼리를 내보낼 수 있게 하는 안전망입니다.

## 새 조합 템플릿 만들 때 체크리스트

1. `validateSql()` 호출을 파이프라인 실행 전에 반드시 통과. 검증 실패 시 400.
2. 파라미터 바인딩(`$N` + `params`)은 서버 측에 이미 지원되어 있음 — 활용하려면 프롬프트만 조정.
3. `/db-query` 하나로 통합된 구조 유지 — 별도 `/db-aggregate` 엔드포인트를 만들지 않습니다.
4. 응답 rows는 `removeSensitiveColumns()`를 반드시 통과.
5. 모든 `client.query()` 호출 전에 `SET LOCAL statement_timeout` 실행.
6. `try/finally`로 `client.release()` 반드시 호출.
7. 응답 계약: `count = rows.length`. 총 건수를 별도로 계산하지 않음.
