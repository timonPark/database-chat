# PostgreSQL Join / Group — 복합 SELECT 패턴

`JOIN`·`GROUP BY`·`HAVING`·서브쿼리·CTE(`WITH`)·윈도우 함수·JSONB 조회처럼 복잡한 SELECT를 조립하는 관례를 정리합니다.

> **엔드포인트는 하나** — PostgreSQL 템플릿에는 별도의 집계 엔드포인트가 없습니다. 이 문서에 나오는 SQL은 모두 [`/db-query`](./query.md) 엔드포인트로 동일하게 전송합니다. 파일이 분리된 것은 SQL 패턴을 참조하기 쉽게 하기 위함일 뿐, 서버 라우팅과는 관계없습니다.
>
> 참고: MongoDB·MySQL 템플릿은 `/db-query`와 `/db-aggregate`를 나눠 라우팅합니다. PostgreSQL만 단일 엔드포인트로 통합되어 있습니다.

기준 구현: [`templates/claude-postgresql/server.ts:368`](../../templates/claude-postgresql/server.ts)

## `LIMIT` 규약

- 모든 복합 SELECT는 `LIMIT ${limit}`을 SQL 안에 반드시 포함합니다. 서버는 자동 부착을 하지 않습니다.
- 집계·윈도우 함수 결과의 카디널리티가 예상보다 크면 응답 크기와 응답 시간이 폭주하므로 이 규약이 특히 중요합니다.
- 엑셀 내보내기는 저장된 SQL을 그대로 재실행하므로, LIMIT을 그대로 두면 화면에 보인 상위 N건만 파일로도 저장됩니다. 이 동작이 예상과 다르면 프롬프트에서 명시적으로 안내가 필요합니다.

## CTE (`WITH`)

서버가 `WITH`로 시작하는 SQL을 접두어 화이트리스트로 허용합니다. 중간 결과를 이름 붙여 재사용하거나 복잡한 서브쿼리를 평평하게 풀 때 사용:

```sql
WITH monthly_orders AS (
  SELECT user_id, DATE_TRUNC('month', created_at) AS month, SUM(amount) AS total
  FROM orders
  WHERE created_at >= '2024-01-01'
  GROUP BY user_id, DATE_TRUNC('month', created_at)
)
SELECT u.name, m.month, m.total
FROM monthly_orders m
JOIN users u ON u.id = m.user_id
ORDER BY m.month DESC, m.total DESC
LIMIT 20;
```

- 재귀 CTE(`WITH RECURSIVE`)도 접두어가 `WITH`로 시작하므로 통과합니다. 무한 반복 위험이 있으므로 `LIMIT`을 반드시 포함하고, `statement_timeout`(30초)이 안전망 역할을 합니다.

## JOIN

기본 4종(`INNER JOIN`, `LEFT JOIN`, `RIGHT JOIN`, `FULL OUTER JOIN`)과 `LATERAL JOIN`을 모두 사용할 수 있습니다.

```sql
SELECT u.id, u.name, COUNT(o.id) AS order_count
FROM users u
LEFT JOIN orders o ON o.user_id = u.id AND o.status = 'paid'
WHERE u.created_at >= '2024-01-01'
GROUP BY u.id, u.name
ORDER BY order_count DESC
LIMIT 20;
```

관례 (서버가 강제하지 않음, 프롬프트로 유도):

- 조인 컬럼에 인덱스가 있는지 필요하면 `EXPLAIN ANALYZE`로 확인. 시퀀셜 스캔이 큰 테이블에 걸리면 인덱스 추가 안내.
- `LEFT JOIN` 결과에 `WHERE right_table.col IS NOT NULL`을 걸면 사실상 `INNER JOIN`이 되므로, 실제 필요한 형태에 맞춰 조인 타입을 선택.

## GROUP BY / HAVING

```sql
SELECT product_id, SUM(quantity) AS total_qty, SUM(amount) AS total_amount
FROM order_items
WHERE created_at >= '2024-01-01'
GROUP BY product_id
HAVING SUM(amount) > 100000
ORDER BY total_amount DESC
LIMIT 20;
```

- SELECT 목록의 컬럼은 GROUP BY 절에 있거나 집계 함수(`SUM`·`COUNT`·`AVG`·`MAX`·`MIN`·`STRING_AGG`·`ARRAY_AGG`)로 감싼 형태만 허용됩니다.
- `WHERE`로 옮길 수 있는 조건은 `HAVING`으로 두지 말 것 — 그룹핑 이전에 걸러야 성능이 좋습니다.

## 윈도우 함수

`ROW_NUMBER`·`RANK`·`DENSE_RANK`·`LAG`·`LEAD`·`SUM ... OVER`·`AVG ... OVER` 모두 사용 가능:

```sql
SELECT
  order_id,
  user_id,
  amount,
  SUM(amount) OVER (PARTITION BY user_id ORDER BY created_at) AS running_total
FROM orders
WHERE created_at >= '2024-01-01'
ORDER BY user_id, created_at
LIMIT 20;
```

윈도우 함수는 GROUP BY와 달리 행 수를 줄이지 않으므로 원본 데이터가 크면 LIMIT이 특히 중요합니다.

## 서브쿼리

스칼라 서브쿼리, `IN (SELECT ...)`, `EXISTS (SELECT 1 ...)` 모두 표준 사용:

```sql
SELECT id, name
FROM users
WHERE id IN (SELECT DISTINCT user_id FROM orders WHERE status = 'paid')
LIMIT 20;
```

성능이 문제되면 CTE나 JOIN으로 평평하게 풀어 다시 조립합니다.

## JSONB 조회

컬럼 타입이 `JSONB`이면 `->`, `->>`, `#>`, `#>>`, `@>`, `?`, `jsonb_path_query` 등을 사용:

```sql
-- JSON 필드 값으로 필터
SELECT id, data
FROM events
WHERE data->>'action' = 'login'
  AND (data->>'timestamp')::timestamptz >= '2024-01-01'
LIMIT 20;

-- JSON 배열 요소 언네스팅
SELECT e.id, tag
FROM events e, jsonb_array_elements_text(e.data->'tags') AS tag
WHERE e.data ? 'tags'
LIMIT 20;
```

- `->>` 는 텍스트 반환, `->` 는 JSONB 반환. 타입 캐스팅(`::numeric`, `::timestamptz`)이 필요할 수 있습니다.
- JSONB 컬럼에 GIN 인덱스가 있으면 `@>` (contains) 연산이 매우 빠르지만, 없다면 시퀀셜 스캔이 발생.

## 숫자/문자열 이중 저장 필드

전화번호·사번·주민등록번호 등이 컬럼 정의(`text` vs `numeric`) 또는 JSONB 안에 다양한 형태로 저장돼 있을 수 있습니다. 시스템 프롬프트는 다음 규약을 따릅니다:

- 우선 값 그대로 조회 — 예: `WHERE phone = '01012345678'`.
- 결과가 0건이면 타입을 반대로 뒤집어 한 번만 재시도. 예:
  - 일반 컬럼: `WHERE phone::numeric = 01012345678`
  - JSONB 컬럼: `WHERE (data->>'phone')::numeric = 01012345678`
- 재시도도 0건이면 "조회된 데이터가 없습니다".

이 규약은 프롬프트에만 존재하며 서버는 관여하지 않습니다.

## 성능 최적화 규약

프롬프트가 유도하는 실행 계획 분석:

- `EXPLAIN ANALYZE <SQL>` — 실제 실행 시간·행 수·인덱스 사용 여부 확인. 접두어 `EXPLAIN`으로 통과.
- `pg_stat_statements` 확장이 활성화된 DB에서는 슬로우 쿼리 상위 목록을 조회해 병목을 분석할 수 있습니다.
- 필터 조건이 컬럼의 일부만 자주 쓰이면 **부분 인덱스**(`CREATE INDEX ... WHERE ...`)로 크기·비용을 절감 (인덱스 생성은 관리자 작업 — 애플리케이션 계정으로는 실행 불가).

## 새 조합 템플릿 만들 때 체크리스트

1. 모든 복합 SELECT에 `LIMIT ${limit}` 포함을 프롬프트로 강제.
2. CTE·재귀 CTE·서브쿼리·윈도우 함수는 기본적으로 허용되지만, 접두어는 `SELECT` 또는 `WITH`여야 함.
3. JSONB 컬럼이 있는 스키마는 스키마 문서(`tables/*.md`)에 필드 구조와 인덱스 존재 여부를 명시.
4. 성능 이상 시 `EXPLAIN ANALYZE`를 유도하되, 결과 해석은 프롬프트가 아닌 사용자에게 넘길 것.
