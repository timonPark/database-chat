# Oracle Join / Group — 복합 SELECT 패턴

`JOIN`·`GROUP BY`·`HAVING`·서브쿼리·분석 함수(analytic functions)·계층 쿼리(`CONNECT BY`)처럼 복잡한 SELECT를 조립하는 Oracle 관례를 정리합니다.

> **엔드포인트는 하나** — Oracle 템플릿에는 별도의 집계 엔드포인트가 없습니다. 이 문서에 나오는 SQL은 모두 [`/db-query`](./query.md) 엔드포인트로 동일하게 전송합니다. 파일이 분리된 것은 SQL 패턴을 참조하기 쉽게 하기 위함일 뿐, 서버 라우팅과는 관계없습니다.
>
> 참고: MongoDB·MySQL 템플릿은 `/db-query`와 `/db-aggregate`를 나눠 라우팅합니다. PostgreSQL·Oracle 템플릿은 단일 엔드포인트입니다.

기준 구현: [`templates/claude-oracle/server.ts:359`](../../templates/claude-oracle/server.ts)

## 행 제한 규약

- 모든 복합 SELECT는 `FETCH FIRST ${limit} ROWS ONLY`(Oracle 12c+) 또는 `ROWNUM <= ${limit}`(이전 버전)을 SQL 안에 반드시 포함합니다.
- 서버는 추가로 드라이버 `maxRows: limit` 옵션을 통해 최종 상한을 강제 — 안전망 역할.
- 정렬을 함께 사용할 때 `ROWNUM`은 반드시 인라인 뷰로 감싸야 정확한 상위 N건을 얻을 수 있습니다: `SELECT * FROM (SELECT ... ORDER BY ...) WHERE ROWNUM <= N`.

## CTE(`WITH`)의 제약

Oracle은 `WITH cte AS (...) SELECT ...` 문법을 12c부터 표준 지원하지만, **서버의 SQL 접두어 화이트리스트에 `WITH`가 없어** 이 접두어로 시작하는 SQL은 400으로 거절됩니다.

우회 방법:

```sql
-- ❌ 거절됨 — 접두어 WITH가 화이트리스트에 없음
WITH recent AS (SELECT * FROM orders WHERE created_at >= DATE '2024-01-01')
SELECT user_id, SUM(amount) FROM recent GROUP BY user_id FETCH FIRST 20 ROWS ONLY;

-- ✅ 인라인 뷰로 대체
SELECT user_id, SUM(amount) FROM (
  SELECT * FROM orders WHERE created_at >= DATE '2024-01-01'
) GROUP BY user_id FETCH FIRST 20 ROWS ONLY;
```

서버 검증을 완화(예: 화이트리스트에 `WITH` 추가)하려면 [`query.md`](./query.md#sql-보안-검증)의 검증 로직을 먼저 갱신하고, 이 문서의 제약 안내도 함께 정리해야 합니다.

## JOIN

ANSI JOIN 문법을 표준으로 사용합니다 (Oracle 구식 `(+)` 조인 문법은 유지보수·표준성 이유로 피함):

```sql
SELECT u.id, u.name, COUNT(o.id) AS order_count
FROM users u
LEFT JOIN orders o ON o.user_id = u.id AND o.status = 'paid'
WHERE u.created_at >= DATE '2024-01-01'
GROUP BY u.id, u.name
ORDER BY order_count DESC
FETCH FIRST 20 ROWS ONLY;
```

지원 조인 타입: `INNER JOIN`, `LEFT JOIN`, `RIGHT JOIN`, `FULL OUTER JOIN`, `CROSS JOIN`, `NATURAL JOIN`, 상관 서브쿼리, `LATERAL` (Oracle 12c+).

관례 (서버가 강제하지 않음, 프롬프트로 유도):

- 조인 컬럼에 인덱스가 있는지 필요하면 `EXPLAIN PLAN FOR <SQL>` + `SELECT * FROM TABLE(DBMS_XPLAN.DISPLAY)`로 확인.
- `LEFT JOIN` 결과에 `WHERE right_table.col IS NOT NULL`을 걸면 사실상 `INNER JOIN`이 되므로, 실제 필요한 형태에 맞춰 조인 타입을 선택.

## GROUP BY / HAVING

```sql
SELECT product_id, SUM(quantity) AS total_qty, SUM(amount) AS total_amount
FROM order_items
WHERE created_at >= DATE '2024-01-01'
GROUP BY product_id
HAVING SUM(amount) > 100000
ORDER BY total_amount DESC
FETCH FIRST 20 ROWS ONLY;
```

- SELECT 목록의 컬럼은 GROUP BY 절에 있거나 집계 함수(`SUM`·`COUNT`·`AVG`·`MAX`·`MIN`·`LISTAGG`·`COLLECT`)로 감싼 형태만 허용됩니다.
- `WHERE`로 옮길 수 있는 조건은 `HAVING`으로 두지 말 것 — 그룹핑 이전에 걸러야 성능이 좋습니다.

`ROLLUP`·`CUBE`·`GROUPING SETS`로 계층적 집계를 한 번에 조립 가능:

```sql
SELECT region, product_id, SUM(amount) AS total
FROM sales
GROUP BY ROLLUP(region, product_id)
ORDER BY region NULLS LAST, product_id NULLS LAST
FETCH FIRST 20 ROWS ONLY;
```

## 분석 함수 (Window Functions)

`ROW_NUMBER`·`RANK`·`DENSE_RANK`·`LAG`·`LEAD`·`SUM ... OVER`·`AVG ... OVER`·`FIRST_VALUE`·`LAST_VALUE` 모두 사용 가능:

```sql
SELECT
  order_id,
  user_id,
  amount,
  SUM(amount) OVER (PARTITION BY user_id ORDER BY created_at) AS running_total
FROM orders
WHERE created_at >= DATE '2024-01-01'
ORDER BY user_id, created_at
FETCH FIRST 20 ROWS ONLY;
```

분석 함수는 GROUP BY와 달리 행 수를 줄이지 않으므로 원본 데이터가 크면 `FETCH FIRST`가 특히 중요합니다.

## 서브쿼리 · 인라인 뷰

스칼라 서브쿼리, `IN (SELECT ...)`, `EXISTS (SELECT 1 ...)`, 인라인 뷰(`FROM (SELECT ...)`) 모두 표준 사용:

```sql
SELECT id, name
FROM users
WHERE id IN (SELECT DISTINCT user_id FROM orders WHERE status = 'paid')
FETCH FIRST 20 ROWS ONLY;
```

CTE를 못 쓰는 대신 인라인 뷰가 실질적으로 같은 역할을 합니다. 옵티마이저가 인라인 뷰를 병합(view merging)할 수도 있으니 성능 차이는 대부분 없습니다.

## 계층 쿼리 — `CONNECT BY`

Oracle 특유의 트리 구조 순회 구문. 조직도·카테고리 트리·BOM 등에 사용:

```sql
SELECT LEVEL, id, name, manager_id
FROM employees
START WITH manager_id IS NULL
CONNECT BY PRIOR id = manager_id
ORDER SIBLINGS BY name
FETCH FIRST 20 ROWS ONLY;
```

- `START WITH`로 루트 조건 지정.
- `CONNECT BY PRIOR`로 부모→자식 관계 방향 표시.
- `LEVEL` 의사 컬럼으로 깊이 접근.
- `ORDER SIBLINGS BY`는 형제 노드 정렬. 일반 `ORDER BY`는 계층을 깨뜨림.

## MERGE는 사용하지 않음

Oracle의 `MERGE INTO`는 INSERT/UPDATE/DELETE를 조합한 쓰기 명령이므로 접두어 화이트리스트에 없고 계정 권한(SELECT-only)에도 걸립니다. LLM이 실수로 조립하지 않도록 프롬프트로 명시적 배제.

## 숫자/문자열 이중 저장 필드

전화번호·사번·주민등록번호 등이 컬럼 정의(`VARCHAR2` vs `NUMBER`)에 따라 다르게 저장돼 있을 수 있습니다. 시스템 프롬프트는 다음 규약을 따릅니다:

- 우선 값 그대로 조회 — 예: `WHERE phone = '01012345678'`.
- 결과가 0건이면 타입을 반대로 뒤집어 한 번만 재시도. 예:
  - 문자열 → 숫자: `WHERE TO_NUMBER(phone) = 01012345678`
  - 숫자 → 문자열: `WHERE phone = TO_CHAR(01012345678)`
- 재시도도 0건이면 "조회된 데이터가 없습니다".

`TO_NUMBER('01012345678')`은 선행 0이 제거되어 정수 `1012345678`이 됩니다. 원본이 실제로 문자열(선행 0 포함)로 저장돼 있으면 이 방식으로는 매칭되지 않으므로, 실패한 경우 반대 방향으로도 시도합니다.

이 규약은 프롬프트에만 존재하며 서버는 관여하지 않습니다.

## 성능 최적화 규약

프롬프트가 유도하는 실행 계획 분석:

- `EXPLAIN PLAN FOR <SQL>;` 후 `SELECT * FROM TABLE(DBMS_XPLAN.DISPLAY);` — 실행 계획 확인. 접두어 `EXPLAIN`으로 통과.
- 대상 테이블 통계가 오래되면 옵티마이저가 비효율적인 계획을 선택 — DBA에게 `DBMS_STATS.GATHER_TABLE_STATS` 실행 요청.
- FTS(Full Table Scan)가 큰 테이블에 걸리면 인덱스 부재 신호. 인덱스 생성은 관리자 작업 — 애플리케이션 계정으로는 실행 불가.

## 새 조합 템플릿 만들 때 체크리스트

1. 모든 복합 SELECT에 `FETCH FIRST ${limit} ROWS ONLY` 또는 `ROWNUM <= ${limit}` 포함을 프롬프트로 강제.
2. `WITH`(CTE) 접두어는 서버 검증에 걸리므로 인라인 뷰로 대체하도록 프롬프트 안내.
3. ANSI JOIN 문법 사용 — 구식 `(+)` 조인 문법 지양.
4. `CONNECT BY` 계층 쿼리는 Oracle 특화 기능 — 다른 DB 마이그레이션 대상이라면 대체 방법(재귀 CTE) 필요.
5. `MERGE`는 접두어 검증과 계정 권한에서 이중으로 거절 — 프롬프트에서도 명시적 배제.
