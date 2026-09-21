# Oracle Query — `/db-query`

읽기 전용 SQL을 실행하는 **단일 엔드포인트**. `SELECT`·`EXPLAIN`·`SHOW`·`DESCRIBE`·`DESC`를 모두 이 엔드포인트에서 처리합니다. JOIN·GROUP BY·서브쿼리·분석 함수를 쓰는 복합 SELECT도 같은 엔드포인트로 갑니다 — 자세한 SQL 패턴은 [`join-group.md`](./join-group.md) 참고.

기준 구현: [`templates/claude-oracle/server.ts:359`](../../templates/claude-oracle/server.ts)

## 요청 스펙

`POST /db-query`

```json
{
  "requestId": "req-abc-123",
  "sql": "SELECT id, name, email FROM users WHERE status = 'active' ORDER BY created_at DESC FETCH FIRST 20 ROWS ONLY",
  "limit": 20
}
```

| 필드 | 타입 | 필수 | 기본값 |
| --- | --- | --- | --- |
| `requestId` | string | | — (엑셀 내보내기용 SQL 저장 키) |
| `sql` | string | ✅ | — |
| `limit` | number | | `20` (드라이버 `maxRows`로 전달) |

`sql`이 비어 있으면 400 반환.

## SQL 보안 검증

요청 처리 초반에 접두어를 확인합니다.

```ts
const ALLOWED_SQL_PREFIXES = ['SELECT', 'EXPLAIN', 'SHOW', 'DESCRIBE', 'DESC'];

const sqlUpper = sql.trim().toUpperCase();
const isAllowed = ALLOWED_SQL_PREFIXES.some(prefix => sqlUpper.startsWith(prefix));
if (!isAllowed) {
  return res.status(400).json({
    error: `허용되지 않는 SQL 입니다. ${ALLOWED_SQL_PREFIXES.join(', ')} 만 허용됩니다.`,
  });
}
```

- **접두어 화이트리스트**: `SELECT` / `EXPLAIN` / `SHOW` / `DESCRIBE` / `DESC`. 대소문자 무관.
- **`WITH` (CTE)는 허용 목록에 없음** — Oracle에서도 `WITH cte AS (SELECT ...) SELECT ...` 문법을 지원하지만, 이 접두어로 시작하는 SQL은 400으로 거절됩니다. CTE가 필요하면 인라인 뷰(`FROM (SELECT ...)`)로 대체하도록 프롬프트를 조정하세요. 서버 검증을 완화하려면 화이트리스트에 `WITH`를 추가하는 별도 결정이 필요합니다.
- **금지 키워드 정규식 없음** — MySQL/PostgreSQL 템플릿과 달리 Oracle 템플릿에는 `INSERT|UPDATE|DELETE|...` 블랙리스트가 없습니다. 접두어만으로도 DML/DDL이 걸리기 때문(첫 토큰이 `INSERT`이면 화이트리스트 통과 실패). 그러나 서브쿼리 안의 함수 호출(예: `PRAGMA AUTONOMOUS_TRANSACTION`을 가진 PL/SQL 함수)로 우회할 여지는 남습니다 — 실질적으로는 **계정 권한(읽기 전용)이 최종 방어선**입니다.

이 검증은 계정 권한(읽기 전용, [`connection.md`](./connection.md#계정-권한-grant) 참고)과 함께 이중 방어를 구성합니다.

## 행 제한 — SQL과 드라이버 옵션 이중 강제

Oracle 템플릿은 행 제한을 두 곳에서 겁니다:

**① SQL 안에 페이징 절 명시 (LLM 담당)**

```sql
-- Oracle 12c 이상: FETCH FIRST N ROWS ONLY (표준 문법)
SELECT ... FROM ... WHERE ... ORDER BY ... FETCH FIRST 20 ROWS ONLY;

-- 이전 버전: ROWNUM (인라인 뷰로 감싸야 정렬과 함께 사용 가능)
SELECT * FROM (
  SELECT ... FROM ... WHERE ... ORDER BY ...
) WHERE ROWNUM <= 20;
```

**② 드라이버 `maxRows` 옵션 (서버 담당)**

```ts
const result = await conn.execute(sql, [], {
  outFormat: oracledb.OUT_FORMAT_OBJECT,
  maxRows: limit ?? 20,
  fetchArraySize: 100,
});
```

`maxRows`는 드라이버가 응답에 담을 최대 행 수를 강제합니다. SQL 안의 `FETCH FIRST`가 누락되어도 이 옵션이 최종 상한으로 작동. 결과 크기 폭주에 대한 안전망 역할.

`fetchArraySize: 100`은 서버 → 드라이버 한 왕복에 가져올 행 수. 네트워크 왕복 횟수를 줄여 응답 시간을 단축합니다. `maxRows`가 100 미만이어도 첫 왕복에서 필요한 만큼만 가져옵니다.

## 실행 흐름

```ts
let conn: oracledb.Connection | null = null;
try {
  const dbStart = Date.now();
  conn = await pool.getConnection();

  const result = await conn.execute(sql, [], {
    outFormat: oracledb.OUT_FORMAT_OBJECT,
    maxRows: limit ?? 20,
    fetchArraySize: 100,
  });

  const data = (result.rows ?? []) as Record<string, unknown>[];
  const cleanData = removeSensitiveColumns(data);
  const dbTimeMs = Date.now() - dbStart;

  if (cleanData.length === 0) {
    return res.json({ count: 0, data: [], dbTimeMs, message: '조회된 데이터가 없습니다. ...' });
  }
  return res.json({ count: cleanData.length, data: cleanData, dbTimeMs });
} finally {
  if (conn) {
    try { await conn.close(); } catch { /* 무시 */ }
  }
}
```

1. 풀에서 커넥션 대여.
2. SQL 실행 — `outFormat: OUT_FORMAT_OBJECT`로 컬럼명을 키로 하는 객체 배열을 받음(기본은 배열 형태).
3. 민감 컬럼 제거 후 응답.
4. `finally`로 커넥션 반납 보장.

## `outFormat: OUT_FORMAT_OBJECT`

이 옵션이 없으면 `oracledb`는 `result.rows`를 `[[col1, col2, ...], [col1, col2, ...]]` 형태의 배열로 반환합니다. 객체 형태(`[{ COL1: ..., COL2: ... }, ...]`)로 응답해야 컬럼명 기반 파싱(민감 컬럼 제거, JSON 응답)이 가능하므로 반드시 설정합니다.

Oracle은 기본적으로 컬럼명을 **대문자**로 반환합니다 — `SELECT id, name FROM users` 결과의 키는 `ID`, `NAME`. 원본 대소문자를 유지하려면 SQL에서 `"id"`, `"name"`처럼 큰따옴표로 감싸야 하지만, 기본 규약은 대문자 그대로 두는 것입니다.

## 민감 컬럼 자동 제거

Oracle의 대문자 컬럼명 특성을 고려해 **소문자 비교**로 매칭합니다:

```ts
const SENSITIVE_COLUMNS = ['password', 'pass_hash', 'passwd', 'pwd', 'secret'];

function removeSensitiveColumns(data: Record<string, unknown>[]): Record<string, unknown>[] {
  return data.map(row => {
    const cleaned: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(row)) {
      if (!SENSITIVE_COLUMNS.includes(key.toLowerCase())) {
        cleaned[key] = value;
      }
    }
    return cleaned;
  });
}
```

- `PASSWORD`, `password`, `PassWord` 모두 매칭.
- `MAX(password)` 같은 함수로 뽑은 값은 컬럼 별칭이 바뀌므로 필터되지 않음 — SELECT 목록에서 애초에 제외하도록 프롬프트로 유도.

## 응답 스펙

정상:

```json
{
  "count": 12,
  "data": [ { "ID": 1, "NAME": "..." }, ... ],
  "dbTimeMs": 24
}
```

- 컬럼명이 대문자(Oracle 기본)로 응답됨.
- `count = rows.length` (별도의 `COUNT(*)`로 총 건수를 계산하지 않음). 사용자에게 "총 몇 건"인지 정확한 값이 필요하면 LLM이 `SELECT COUNT(*) FROM ...`을 별도로 실행해야 합니다.

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
{ "error": "허용되지 않는 SQL 입니다. SELECT, EXPLAIN, SHOW, DESCRIBE, DESC 만 허용됩니다." }
```

타임아웃 (ORA-01013):

```
HTTP/1.1 504 Gateway Timeout
{ "error": "DB 응답시간 초과 Max 30초" }
```

기타 오류: HTTP 500 + `{ "error": "..." }`.

## `requestId`와 엑셀 내보내기

`requestId`가 오면 원본 SQL을 그대로 `queryParamsStore`에 저장합니다.

```ts
if (requestId) queryParamsStore.set(requestId, { sql: sql.trim() });
queryParamsStore.set('__latest__', { sql: sql.trim() });
```

`POST /db-export`가 같은 `requestId`로 호출되면 저장된 SQL을 **그대로** 재실행합니다. `maxRows` 옵션 없이 실행되므로 SQL의 `FETCH FIRST`/`ROWNUM` 절이 그대로 유효 — 화면에 보인 상위 N건만 파일로도 저장됩니다.

전체 결과를 뽑고 싶으면 `removeLimitFromSql()` 유틸이 파일에 이미 정의돼 있지만(`FETCH FIRST n ROWS ONLY`와 `ROWNUM <= n`을 정규식으로 제거) 기본 `/db-export` 핸들러에서는 호출하지 않습니다 — 필요한 조합 템플릿에서 선택적으로 활성화하는 훅으로 남아 있습니다.

`__latest__` 폴백 키는 `requestId`를 잃어버린 클라이언트가 마지막 쿼리를 내보낼 수 있게 하는 안전망입니다.

## 새 조합 템플릿 만들 때 체크리스트

1. 접두어 화이트리스트 통과 검증을 SQL 실행 전에 반드시 통과. 검증 실패 시 400.
2. `execute()` 호출에 `outFormat: OUT_FORMAT_OBJECT` 반드시 지정 — 배열 형태로 오면 민감 컬럼 제거·JSON 응답이 깨집니다.
3. `maxRows: limit`을 반드시 지정 — SQL의 페이징 절 누락에 대한 안전망.
4. `fetchArraySize: 100` 유지 — 네트워크 왕복 최적화. 응답 크기 대비 지나치게 크지 않게.
5. 응답 rows는 `removeSensitiveColumns()`(소문자 비교)를 반드시 통과.
6. `try/finally`로 `conn.close()` 반드시 호출 — 반납 실패 시 풀 고갈.
7. 응답 계약: `count = rows.length`. 총 건수를 별도로 계산하지 않음.
8. Oracle 응답 컬럼명이 기본 대문자임을 프런트/응답 규약에 반영.
