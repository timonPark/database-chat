# MySQL Query — `/db-query`

단순 `SELECT` 실행 엔드포인트. `WHERE`·`ORDER BY`·단일 테이블 조회에 사용합니다. `JOIN`·`GROUP BY`·`HAVING`·서브쿼리가 필요하면 [`/db-aggregate`](./join-group.md)를 씁니다.

기준 구현: [`templates/claude-mysql/server.ts:352`](../../templates/claude-mysql/server.ts)

## 요청 스펙

`POST /db-query`

```json
{
  "requestId": "req-abc-123",
  "sql": "SELECT id, name, email FROM users WHERE status = 'active' ORDER BY created_at DESC",
  "limit": 20
}
```

| 필드 | 타입 | 필수 | 기본값 |
| --- | --- | --- | --- |
| `requestId` | string | | — (엑셀 내보내기용 SQL 저장 키) |
| `sql` | string | ✅ | — |
| `limit` | number | | `20` |

`sql`이 비어 있으면 400 반환.

## SQL 보안 검증

파이프라인 실행 전에 접두어와 금지 키워드를 확인합니다.

```ts
const ALLOWED_SQL_PREFIXES = ['SELECT', 'EXPLAIN', 'SHOW', 'DESCRIBE', 'DESC'];
const BLOCKED_SQL_KEYWORDS = /\b(INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|TRUNCATE|REPLACE|MERGE|EXEC|EXECUTE|CALL|GRANT|REVOKE|LOAD\s+DATA|INTO\s+OUTFILE|INTO\s+DUMPFILE)\b/i;

function validateSql(sql: string): void {
  const trimmed = sql.trim().toUpperCase();
  const isAllowed = ALLOWED_SQL_PREFIXES.some(prefix => trimmed.startsWith(prefix));
  if (!isAllowed) throw new Error('SELECT 쿼리만 허용됩니다.');
  if (BLOCKED_SQL_KEYWORDS.test(sql)) throw new Error('허용되지 않는 SQL 키워드가 포함되어 있습니다.');
}
```

- **접두어 화이트리스트**: `SELECT` / `EXPLAIN` / `SHOW` / `DESCRIBE` / `DESC`만 허용. 대소문자 무관.
- **금지 키워드 블랙리스트**: 위 정규식 매칭 시 즉시 실패. 컬럼명이 우연히 `create_at` 같은 형태여도 `\b` 단어 경계로 오탐이 발생하지 않도록 조립.
- 검증 실패 시 400 + 사유 반환.

이 검증은 계정 권한(읽기 전용, [`connection.md`](./connection.md#계정-권한-grant) 참고)과 함께 이중 방어를 구성합니다. 계정에 쓰기 권한이 없더라도 프리플라이트 단계에서 즉시 차단하는 것이 목적.

## 자동 `LIMIT` 부착

`SELECT`로 시작하고 `LIMIT`이 없으면 서버가 `LIMIT <limit>`을 뒤에 붙입니다.

```ts
const upperSql = sql.trim().toUpperCase();
const finalSql = upperSql.startsWith('SELECT') && !upperSql.includes('LIMIT')
  ? `${sql} LIMIT ${limit}`
  : sql;
```

- LLM tool 출력 한도와 응답 시간 폭주를 방지하기 위함.
- `EXPLAIN`·`SHOW`·`DESCRIBE`는 `LIMIT`이 애초에 불필요하므로 부착하지 않습니다.
- LLM 프롬프트도 `LIMIT ${limit}`을 명시하도록 유도 — 부착은 안전망입니다.

## 실행

```ts
const [rows] = await pool.query<RowDataPacket[]>({ sql: finalSql, timeout: DB_TIMEOUT_MS });
```

- `pool.query()`는 내부적으로 커넥션을 대여→실행→반납.
- `timeout: 30_000`으로 서버측 쿼리 상한 강제.

## 민감 컬럼 자동 제거

```ts
const SENSITIVE_COLUMNS = ['password', 'pass_hash', 'passwd', 'pwd', 'secret'];

const data = rows.map(row => {
  const r = { ...row };
  SENSITIVE_COLUMNS.forEach(col => delete r[col]);
  return r;
});
```

응답 rows 각각에서 위 컬럼명(정확 일치)을 삭제합니다. `SELECT *`나 실수로 민감 컬럼을 포함한 SELECT도 응답에는 반영되지 않습니다.

## 응답 스펙

정상:

```json
{
  "count": 12,
  "data": [ { "id": 1, "name": "..." }, ... ],
  "dbTimeMs": 24
}
```

> **참고**: MySQL 템플릿의 `count`는 응답 rows 수와 동일합니다(`data.length`). MongoDB처럼 별도의 `countDocuments`로 총 건수를 계산하지 않습니다. 사용자에게 "총 몇 건"인지 정확한 값이 필요하면 LLM이 `SELECT COUNT(*) FROM ...`을 별도로 실행해야 합니다.

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
{ "error": "SELECT 쿼리만 허용됩니다." }
```

타임아웃 (30초 초과):

```
HTTP/1.1 504 Gateway Timeout
{ "error": "DB 응답시간 초과 Max 30초" }
```

기타 오류: HTTP 500 + `{ "error": "..." }`.

## `requestId`와 엑셀 내보내기

`requestId`가 오면 `finalSql`(LIMIT 부착 후)과 테이블명을 `sqlStore`에 저장합니다.

```ts
if (requestId) sqlStore.set(requestId, { sql: finalSql, table: tableName });
sqlStore.set('__latest__', { sql: finalSql, table: tableName });
```

`POST /db-export`가 같은 `requestId`로 호출되면 저장된 SQL을 **그대로** 재실행합니다. MongoDB처럼 LIMIT을 벗겨서 전체 결과를 뽑지는 않습니다 — MySQL 템플릿에서 엑셀 내보내기는 "화면에 보인 것 그대로" 규약.

`__latest__` 폴백 키는 `requestId`를 잃어버린 클라이언트가 마지막 쿼리를 내보낼 수 있게 하는 안전망입니다.

`tableName`은 `FROM <table>` 패턴에서 정규식으로 추출:

```ts
function extractTableName(sql: string): string {
  const match = sql.match(/FROM\s+`?(\w+)`?/i);
  return match?.[1] ?? 'result';
}
```

엑셀 파일명 조립에 사용됩니다.

## 새 조합 템플릿 만들 때 체크리스트

1. `validateSql()` 호출을 파이프라인 실행 전에 반드시 통과. 검증 실패 시 400.
2. `SELECT`로 시작하고 `LIMIT`이 없는 SQL에는 서버가 `LIMIT <limit>`을 자동 부착.
3. 응답 rows는 `SENSITIVE_COLUMNS` 필터를 반드시 통과.
4. `pool.query()` 호출에 `timeout: DB_TIMEOUT_MS` 옵션 유지.
5. 응답 계약: `count = data.length`. 총 건수를 별도로 계산하지 않음.
