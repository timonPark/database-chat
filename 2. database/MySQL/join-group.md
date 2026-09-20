# MySQL Join / Group — `/db-aggregate`

`JOIN`·`GROUP BY`·`HAVING`·서브쿼리·윈도우 함수가 필요한 SELECT를 실행하는 엔드포인트. 단순 `WHERE`/`ORDER BY`만 필요하면 [`/db-query`](./query.md)를 씁니다.

> **이름 참고** — 서버 코드의 엔드포인트 이름(`/db-aggregate`)은 MongoDB 템플릿에서 물려받은 명명이라 그대로 유지합니다. SQL에는 "aggregate query"라는 별개 개념이 없고 그냥 `SELECT` 안에서 aggregate function(`SUM`·`COUNT`·`AVG` 등)과 `JOIN`·`GROUP BY`·`HAVING` 절을 조합할 뿐이므로, 문서는 SQL 관점에 맞춰 `join-group.md`로 명명합니다.

MongoDB의 `/db-aggregate`가 파이프라인 배열을 받는 반면, MySQL은 **완성된 SQL 문자열**을 그대로 실행합니다.

기준 구현: [`templates/claude-mysql/server.ts:397`](../../templates/claude-mysql/server.ts)

## 요청 스펙

`POST /db-aggregate`

```json
{
  "requestId": "req-abc-123",
  "sql": "SELECT u.id, u.name, COUNT(o.id) AS order_count, SUM(o.amount) AS total FROM users u LEFT JOIN orders o ON o.user_id = u.id WHERE u.status = 'active' GROUP BY u.id, u.name HAVING order_count > 0 ORDER BY total DESC LIMIT 20"
}
```

| 필드 | 타입 | 필수 |
| --- | --- | --- |
| `requestId` | string | |
| `sql` | string | ✅ |

`sql`이 비어 있으면 400 반환.

> **차이점**: `/db-query`와 달리 `limit` 필드를 받지 않습니다. 집계 SQL은 `LIMIT`을 LLM이 SQL 안에 직접 넣어야 합니다.

## SQL 보안 검증

`/db-query`와 **동일한** `validateSql()` 함수를 통과시킵니다. 접두어 화이트리스트, 금지 키워드 블랙리스트 모두 동일 — [`query.md`](./query.md#sql-보안-검증) 참고.

집계 SQL도 결국은 `SELECT`로 시작하므로 같은 검증기로 충분합니다.

## `LIMIT` 자동 부착 없음

`/db-aggregate`는 `LIMIT`을 서버가 부착하지 않습니다.

- 집계 결과의 크기는 SQL 구조(`GROUP BY` 카디널리티)에 따라 크게 달라지므로 서버가 일괄로 붙이면 왜곡될 수 있습니다.
- 대신 시스템 프롬프트가 LLM에게 `LIMIT ${limit}` 포함을 강제합니다.
- LIMIT 없이 대량 결과가 나오면 응답 크기·응답 시간이 폭주할 수 있으므로 프롬프트 규약 준수가 중요합니다.

## 실행

```ts
const [rows] = await pool.query<RowDataPacket[]>({ sql, timeout: DB_TIMEOUT_MS });
```

- SQL은 저장된 문자열 그대로 실행 — 서버 측 재작성 없음.
- 30초 서버측 타임아웃 강제.

## 민감 컬럼 자동 제거

`/db-query`와 동일:

```ts
const data = rows.map(row => {
  const r = { ...row };
  SENSITIVE_COLUMNS.forEach(col => delete r[col]);
  return r;
});
```

집계 결과에서 `password`·`pass_hash`·`passwd`·`pwd`·`secret` 컬럼(정확 일치)이 제거됩니다. `MAX(password)` 같은 우회 형태는 컬럼 별칭이 바뀌므로 필터되지 않습니다 — LLM 프롬프트로 SELECT 목록에서 제외하도록 지시합니다.

## 응답 스펙

정상:

```json
{
  "count": 42,
  "data": [ { "id": 1, "name": "...", "order_count": 3, "total": "123.45" }, ... ],
  "dbTimeMs": 87
}
```

- `count = data.length`. 별도의 `SELECT COUNT(*)` 실행 없음. 사용자에게 "그룹핑 이전 원본 건수"가 필요하면 LLM이 별도 쿼리를 조립해야 합니다.
- `SUM`, `AVG`, `DECIMAL` 관련 값이 문자열로 반환되는 이유는 [`type-conversion.md`](./type-conversion.md#decimalnumericfloatdouble) 참고.

0건:

```json
{
  "count": 0,
  "data": [],
  "dbTimeMs": 12,
  "message": "조회된 데이터가 없습니다. 추가 쿼리 없이 즉시 이 메시지를 사용자에게 전달하라."
}
```

검증 실패 / 타임아웃 / 기타 오류는 `/db-query`와 동일한 응답 형식.

## 엑셀 내보내기 재실행

`requestId`가 오면 **저장된 SQL 그대로** `sqlStore`에 넣습니다. `LIMIT`을 제거하거나 재작성하지 않습니다.

```ts
if (requestId) sqlStore.set(requestId, { sql, table: tableName });
sqlStore.set('__latest__', { sql, table: tableName });
```

`POST /db-export`는 이 SQL을 그대로 재실행합니다 — 화면에 보인 것과 동일한 결과를 파일로 전달.

`tableName`은 `FROM` 뒤 첫 테이블명. `JOIN`의 오른쪽 테이블이나 서브쿼리 별칭은 잡히지 않으며, 엑셀 파일명 용도이므로 정확도가 크게 중요하지는 않습니다.

## JOIN·GROUP BY 관례

서버 코드가 강제하지 않는 관례 (프롬프트에서 규정):

- `LIMIT ${limit}` 포함 필수 — 서버 자동 부착이 없으므로 LLM이 반드시 명시.
- `JOIN` 사용 시 조인 컬럼 인덱스가 있는지 필요하면 `EXPLAIN`으로 확인. `type=ALL` 발견 시 인덱스 추가 안내.
- `GROUP BY` + `SELECT` 컬럼은 GROUP BY 절에 있거나 집계 함수로 감싼 형태만 허용 (ONLY_FULL_GROUP_BY sql_mode 준수).
- `HAVING`은 집계 결과에 대한 필터. `WHERE`로 옮길 수 있으면 옮기는 편이 효율적.

## 새 조합 템플릿 만들 때 체크리스트

1. `validateSql()` 호출을 SQL 실행 전에 반드시 통과.
2. `/db-aggregate`는 `LIMIT` 자동 부착을 **하지 않음** — 프롬프트로 강제.
3. 응답 rows는 `SENSITIVE_COLUMNS` 필터를 반드시 통과.
4. `pool.query()` 호출에 `timeout: DB_TIMEOUT_MS` 옵션 유지.
5. `sqlStore`에는 **입력받은 SQL 그대로** 저장 — 엑셀 내보내기 재실행 시 사용자가 본 결과와 형태가 일치해야 함.
