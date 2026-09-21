# MSSQL Query — `/db-query`

읽기 전용 T-SQL을 실행하는 **단일 엔드포인트**. `SELECT`·`EXPLAIN`·`SHOW`·`DESCRIBE`·`DESC`를 모두 이 엔드포인트에서 처리합니다. JOIN·GROUP BY·서브쿼리·윈도우 함수를 쓰는 복합 SELECT도 같은 엔드포인트로 갑니다 — 자세한 SQL 패턴은 [`join-group.md`](./join-group.md) 참고.

기준 구현: [`templates/claude-mssql/server.ts:358`](../../templates/claude-mssql/server.ts)

## 요청 스펙

`POST /db-query`

```json
{
  "requestId": "req-abc-123",
  "sql": "SELECT TOP 20 id, name, email FROM dbo.Users WHERE status = 'active' ORDER BY created_at DESC",
  "limit": 20
}
```

| 필드 | 타입 | 필수 | 기본값 |
| --- | --- | --- | --- |
| `requestId` | string | | — (엑셀 내보내기용 SQL 저장 키) |
| `sql` | string | ✅ | — |
| `limit` | number | | `20` (참고 값 — 실제 행 제한은 SQL 안의 `TOP`/`FETCH NEXT`가 결정) |

`sql`이 비어 있으면 400 반환.

`limit` 필드는 body 파싱은 되지만 서버가 SQL을 재작성하는 데 사용하지 않습니다 (`void limit`). 행 제한은 반드시 SQL 안에 명시해야 합니다 — [행 제한 규약](#행-제한-규약) 참고.

## SQL 보안 검증

요청 처리 초반에 접두어를 확인합니다.

```ts
const ALLOWED_SQL_PREFIXES = ['SELECT', 'EXPLAIN', 'SHOW', 'DESCRIBE', 'DESC'];

const sqlUpper = sqlStr.trim().toUpperCase();
const isAllowed = ALLOWED_SQL_PREFIXES.some(prefix => sqlUpper.startsWith(prefix));
if (!isAllowed) {
  return res.status(400).json({
    error: `허용되지 않는 SQL 입니다. ${ALLOWED_SQL_PREFIXES.join(', ')} 만 허용됩니다.`,
  });
}
```

- **접두어 화이트리스트**: `SELECT` / `EXPLAIN` / `SHOW` / `DESCRIBE` / `DESC`. 대소문자 무관.
- **`WITH` (CTE)는 허용 목록에 없음** — T-SQL에서도 `WITH cte AS (...) SELECT ...` 문법을 지원하지만, 이 접두어로 시작하는 SQL은 400으로 거절됩니다. CTE가 필요하면 인라인 뷰(`FROM (SELECT ...) AS x`)로 대체하도록 프롬프트를 조정하세요. 서버 검증을 완화하려면 화이트리스트에 `WITH`를 추가하는 별도 결정이 필요합니다.
- **금지 키워드 정규식 없음** — MySQL/PostgreSQL 템플릿과 달리 MSSQL 템플릿에는 `INSERT|UPDATE|DELETE|...` 블랙리스트가 없습니다. 접두어만으로도 DML/DDL이 걸리기 때문. 서브쿼리 안에서 저장 프로시저·사용자 함수(`EXEC`·`sp_...` 등) 호출을 통한 우회 여지는 남아 있어 **계정 권한(읽기 전용)이 최종 방어선**입니다.

이 검증은 계정 권한(읽기 전용, [`connection.md`](./connection.md#계정-권한-permission) 참고)과 함께 이중 방어를 구성합니다.

## 행 제한 규약

MSSQL 템플릿은 서버가 SQL을 재작성하거나 드라이버 옵션으로 자르지 않습니다. LLM이 T-SQL 페이징 구문을 SQL 안에 반드시 포함해야 합니다.

**① `SELECT TOP n` (가장 흔한 형태)**

```sql
SELECT TOP 20 id, name, email
FROM dbo.Users
WHERE status = 'active'
ORDER BY created_at DESC;
```

- 정렬과 함께 쓰면 정렬 결과의 상위 N건.
- `ORDER BY` 없으면 순서 미정.

**② `OFFSET ... FETCH NEXT ...` (표준 SQL 페이징, T-SQL 2012+)**

```sql
SELECT id, name, email
FROM dbo.Users
WHERE status = 'active'
ORDER BY created_at DESC
OFFSET 0 ROWS FETCH NEXT 20 ROWS ONLY;
```

- 반드시 `ORDER BY`가 있어야 사용 가능.
- 페이지 스크롤이 필요하면 `OFFSET`을 20의 배수로 늘려가며 재요청.

프롬프트는 두 문법 모두 허용하도록 안내합니다.

## 스키마 포함 테이블명 규약

SQL Server는 하나의 DB 안에 여러 스키마(dbo, SalesLT, HumanResources 등)가 공존하는 경우가 많고, 사용자 계정마다 기본 스키마가 다를 수 있습니다. **스키마를 생략하면 사용자 기본 스키마로 해석되어 결과가 달라지거나 오류가 발생**합니다. 프롬프트가 다음 규약을 강제:

```sql
-- ✅ 스키마 포함
SELECT TOP 20 * FROM SalesLT.Product;
SELECT TOP 20 * FROM dbo.ErrorLog;

-- ❌ 스키마 생략 — 사용자 기본 스키마에 따라 결과가 달라짐
SELECT TOP 20 * FROM Product;
```

이 규약은 프롬프트에만 존재하며 서버는 관여하지 않습니다.

## 실행 흐름

```ts
try {
  const dbStart = Date.now();
  const request = pool.request();
  request.timeout = 30_000;
  const result = await request.query(sqlStr);

  const data = result.recordset as Record<string, unknown>[];
  const cleanData = removeSensitiveColumns(data);
  const dbTimeMs = Date.now() - dbStart;

  if (cleanData.length === 0) {
    return res.json({ count: 0, data: [], dbTimeMs, message: '조회된 데이터가 없습니다. ...' });
  }
  return res.json({ count: cleanData.length, data: cleanData, dbTimeMs });
} catch (err) {
  // ...
}
```

1. 풀에서 요청 컨텍스트 생성 (`pool.request()`).
2. 요청 타임아웃 30초 강제.
3. T-SQL 실행 — 결과는 `result.recordset`.
4. 민감 컬럼 제거 후 응답.

`mssql`은 커넥션을 명시적으로 반납하는 개념이 없고, `request` 객체가 알아서 풀 커넥션을 대여·반납합니다 — MongoDB·Oracle 템플릿과 다른 점.

## 민감 컬럼 자동 제거

대소문자 무관 매칭 (소문자로 비교):

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

- `PASSWORD`, `password`, `PassWord` 모두 매칭 (T-SQL 컬럼명 대소문자는 collation에 따라 다양).
- `MAX(password)` 같은 함수로 뽑은 값은 컬럼 별칭이 바뀌므로 필터되지 않음 — SELECT 목록에서 애초에 제외하도록 프롬프트로 유도.

## 응답 스펙

정상:

```json
{
  "count": 12,
  "data": [ { "id": 1, "name": "..." }, ... ],
  "dbTimeMs": 24
}
```

- `count = rows.length` (별도의 `COUNT(*)`로 총 건수를 계산하지 않음). 사용자에게 "총 몇 건"인지 정확한 값이 필요하면 LLM이 `SELECT COUNT(*) FROM ...`을 별도로 실행해야 합니다.
- 컬럼명은 T-SQL이 반환한 대소문자를 그대로 유지 (Oracle처럼 대문자로 강제되지 않음).

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

타임아웃 (30초 초과, 메시지 문자열 감지):

```
HTTP/1.1 504 Gateway Timeout
{ "error": "DB 응답시간 초과 Max 30초" }
```

기타 오류: HTTP 500 + `{ "error": "..." }`.

## `requestId`와 엑셀 내보내기

`requestId`가 오면 원본 SQL을 그대로 `queryParamsStore`에 저장합니다.

```ts
if (requestId) queryParamsStore.set(requestId, { sql: sqlStr.trim() });
queryParamsStore.set('__latest__', { sql: sqlStr.trim() });
```

`POST /db-export`가 같은 `requestId`로 호출되면 저장된 SQL을 **그대로** 재실행합니다. SQL의 `TOP`/`FETCH NEXT` 절이 그대로 유효 — 화면에 보인 상위 N건만 파일로도 저장됩니다.

전체 결과를 뽑고 싶으면 `removeLimitFromSql()` 유틸이 파일에 이미 정의돼 있지만(`SELECT TOP n`을 `SELECT`로, `OFFSET n ROWS FETCH NEXT n ROWS ONLY`를 정규식으로 제거) 기본 `/db-export` 핸들러에서는 호출하지 않습니다 — 필요한 조합 템플릿에서 선택적으로 활성화하는 훅으로 남아 있습니다.

`__latest__` 폴백 키는 `requestId`를 잃어버린 클라이언트가 마지막 쿼리를 내보낼 수 있게 하는 안전망입니다.

## 새 조합 템플릿 만들 때 체크리스트

1. 접두어 화이트리스트 통과 검증을 SQL 실행 전에 반드시 통과. 검증 실패 시 400.
2. 행 제한은 서버가 강제하지 않으므로 프롬프트로 `TOP` 또는 `OFFSET/FETCH NEXT` 포함을 강제.
3. 테이블명은 반드시 스키마 포함 (`dbo.Table`, `SalesLT.Product`) — 프롬프트로 강제.
4. `pool.request()` 후 `request.timeout = 30_000` 명시.
5. 응답 rows는 `removeSensitiveColumns()`(소문자 비교)를 반드시 통과.
6. 응답 계약: `count = rows.length`. 총 건수를 별도로 계산하지 않음.
