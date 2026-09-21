# MSSQL Join / Group — 복합 SELECT 패턴

`JOIN`·`GROUP BY`·`HAVING`·서브쿼리·윈도우 함수·`PIVOT`/`UNPIVOT`처럼 복잡한 T-SQL을 조립하는 관례를 정리합니다.

> **엔드포인트는 하나** — MSSQL 템플릿에는 별도의 집계 엔드포인트가 없습니다. 이 문서에 나오는 SQL은 모두 [`/db-query`](./query.md) 엔드포인트로 동일하게 전송합니다. 파일이 분리된 것은 SQL 패턴을 참조하기 쉽게 하기 위함일 뿐, 서버 라우팅과는 관계없습니다.
>
> 참고: MongoDB·MySQL 템플릿은 `/db-query`와 `/db-aggregate`를 나눠 라우팅합니다. PostgreSQL·Oracle·MSSQL 템플릿은 단일 엔드포인트입니다.

기준 구현: [`templates/claude-mssql/server.ts:358`](../../templates/claude-mssql/server.ts)

## 행 제한 규약

- 모든 복합 SELECT는 `SELECT TOP ${limit}` 또는 `OFFSET 0 ROWS FETCH NEXT ${limit} ROWS ONLY`를 SQL 안에 반드시 포함합니다.
- 서버는 SQL을 재작성하지 않고, 드라이버 옵션으로 별도 상한도 걸지 않습니다 — LLM이 SQL 안에 명시하는 것이 유일한 방어입니다.
- `OFFSET ... FETCH NEXT` 문법은 `ORDER BY`가 반드시 있어야 사용 가능. `TOP`은 `ORDER BY` 없이도 사용 가능하지만 순서가 미정.

## 테이블명 스키마 필수

모든 테이블·뷰 참조는 스키마를 포함해야 합니다 (`dbo.Users`, `SalesLT.Product`, `HumanResources.Employee` 등). 프롬프트가 이 규약을 강제 — 자세한 이유는 [`query.md`](./query.md#스키마-포함-테이블명-규약) 참고.

## CTE(`WITH`)의 제약

T-SQL은 `WITH cte AS (...) SELECT ...` 문법을 표준 지원하지만, **서버의 SQL 접두어 화이트리스트에 `WITH`가 없어** 이 접두어로 시작하는 SQL은 400으로 거절됩니다.

우회 방법:

```sql
-- ❌ 거절됨 — 접두어 WITH가 화이트리스트에 없음
WITH recent AS (
  SELECT * FROM Sales.Orders WHERE created_at >= '2024-01-01'
)
SELECT TOP 20 user_id, SUM(amount) AS total
FROM recent
GROUP BY user_id;

-- ✅ 인라인 뷰(파생 테이블)로 대체
SELECT TOP 20 user_id, SUM(amount) AS total
FROM (
  SELECT * FROM Sales.Orders WHERE created_at >= '2024-01-01'
) AS recent
GROUP BY user_id;
```

`WITH`는 T-SQL에서 semicolon 시작(`;WITH ...`) 관용구도 흔히 쓰이지만, 앞에 세미콜론이 있으면 접두어 매칭이 실패해 마찬가지로 거절됩니다.

서버 검증을 완화(예: 화이트리스트에 `WITH` 추가)하려면 [`query.md`](./query.md#sql-보안-검증)의 검증 로직을 먼저 갱신하고, 이 문서의 제약 안내도 함께 정리해야 합니다.

## JOIN

ANSI JOIN 문법을 표준으로 사용합니다:

```sql
SELECT TOP 20
  u.id, u.name,
  COUNT(o.id) AS order_count,
  SUM(o.amount) AS total_amount
FROM dbo.Users u
LEFT JOIN Sales.Orders o
  ON o.user_id = u.id AND o.status = 'paid'
WHERE u.created_at >= '2024-01-01'
GROUP BY u.id, u.name
ORDER BY total_amount DESC;
```

지원 조인 타입: `INNER JOIN`, `LEFT JOIN`, `RIGHT JOIN`, `FULL OUTER JOIN`, `CROSS JOIN`, `CROSS APPLY` (Oracle의 `LATERAL`에 해당), `OUTER APPLY`.

관례 (서버가 강제하지 않음, 프롬프트로 유도):

- 조인 컬럼에 인덱스가 있는지 필요하면 실행 계획으로 확인 (`SET STATISTICS IO ON;` + 쿼리 실행, 또는 `EXPLAIN`이 서버 접두어에 있지만 실제 T-SQL 문법은 아니므로 SSMS `Ctrl+M` 실행 계획 창을 프런트에서 유도).
- `LEFT JOIN` 결과에 `WHERE right_table.col IS NOT NULL`을 걸면 사실상 `INNER JOIN`이 되므로, 실제 필요한 형태에 맞춰 조인 타입을 선택.

## GROUP BY / HAVING

```sql
SELECT TOP 20
  product_id,
  SUM(quantity) AS total_qty,
  SUM(amount) AS total_amount
FROM Sales.OrderItems
WHERE created_at >= '2024-01-01'
GROUP BY product_id
HAVING SUM(amount) > 100000
ORDER BY total_amount DESC;
```

- SELECT 목록의 컬럼은 GROUP BY 절에 있거나 집계 함수(`SUM`·`COUNT`·`AVG`·`MAX`·`MIN`·`STRING_AGG`)로 감싼 형태만 허용됩니다.
- `WHERE`로 옮길 수 있는 조건은 `HAVING`으로 두지 말 것 — 그룹핑 이전에 걸러야 성능이 좋습니다.

`ROLLUP`·`CUBE`·`GROUPING SETS`로 계층적 집계를 한 번에 조립 가능:

```sql
SELECT
  region, product_id, SUM(amount) AS total
FROM Sales.Data
GROUP BY ROLLUP(region, product_id)
ORDER BY region, product_id;
```

## 윈도우 함수

`ROW_NUMBER`·`RANK`·`DENSE_RANK`·`LAG`·`LEAD`·`SUM ... OVER`·`AVG ... OVER`·`FIRST_VALUE`·`LAST_VALUE`·`NTILE` 모두 사용 가능:

```sql
SELECT TOP 20
  order_id,
  user_id,
  amount,
  SUM(amount) OVER (PARTITION BY user_id ORDER BY created_at) AS running_total
FROM Sales.Orders
WHERE created_at >= '2024-01-01'
ORDER BY user_id, created_at;
```

윈도우 함수는 GROUP BY와 달리 행 수를 줄이지 않으므로 원본 데이터가 크면 `TOP`/`FETCH NEXT`가 특히 중요합니다.

## 서브쿼리 · 인라인 뷰 · APPLY

스칼라 서브쿼리, `IN (SELECT ...)`, `EXISTS (SELECT 1 ...)`, 인라인 뷰(파생 테이블), `CROSS APPLY`/`OUTER APPLY` 모두 표준 사용:

```sql
-- 각 사용자에 대해 최근 주문 3건씩
SELECT TOP 20 u.id, u.name, o.order_id, o.created_at
FROM dbo.Users u
CROSS APPLY (
  SELECT TOP 3 order_id, created_at
  FROM Sales.Orders
  WHERE user_id = u.id
  ORDER BY created_at DESC
) o
ORDER BY u.id, o.created_at DESC;
```

`CROSS APPLY`는 왼쪽 테이블 각 행마다 오른쪽 서브쿼리를 실행. 관계형 조인만으로 표현하기 어려운 "각 그룹의 상위 N건" 패턴에 유용.

CTE를 못 쓰는 대신 인라인 뷰가 실질적으로 같은 역할을 합니다.

## PIVOT / UNPIVOT

T-SQL 특유의 행↔열 변환 구문:

```sql
SELECT TOP 20 category, [2023], [2024]
FROM (
  SELECT category, YEAR(created_at) AS yr, amount
  FROM Sales.Orders
) src
PIVOT (
  SUM(amount) FOR yr IN ([2023], [2024])
) AS p
ORDER BY category;
```

`PIVOT` 대상 값 목록은 정적으로 나열해야 하므로 동적 컬럼이 필요하면 동적 SQL(`sp_executesql`)로 조립해야 하지만, 이 채널에서는 접두어·계정 권한으로 차단됩니다 — 대안으로 애플리케이션 레벨에서 재구성.

## 숫자/문자열 이중 저장 필드

전화번호·사번·주민등록번호 등이 컬럼 정의(`NVARCHAR` vs `INT`/`BIGINT`)에 따라 다르게 저장돼 있을 수 있습니다. 시스템 프롬프트는 다음 규약을 따릅니다:

- 우선 값 그대로 조회 — 예: `WHERE phone = '01012345678'`.
- 결과가 0건이면 타입을 반대로 뒤집어 한 번만 재시도. 예:
  - 문자열 → 숫자: `WHERE TRY_CAST(phone AS INT) = 01012345678`
  - 숫자 → 문자열: `WHERE phone = CONVERT(NVARCHAR, 01012345678)`
- 재시도도 0건이면 "조회된 데이터가 없습니다".

`TRY_CAST`는 변환 실패 시 `NULL` 반환(예외 없음). `CAST`는 실패 시 예외를 던지므로 이런 우회 재시도에는 반드시 `TRY_CAST` 사용.

이 규약은 프롬프트에만 존재하며 서버는 관여하지 않습니다.

## 성능 최적화 규약

프롬프트가 유도하는 실행 계획 분석:

- `SET STATISTICS IO ON; SELECT ...` — 논리적 읽기 수·물리적 읽기 수 확인. Table scan이 큰 테이블에 걸리면 인덱스 부재 신호.
- `SET STATISTICS TIME ON;` — CPU·경과 시간 측정.
- 통계 갱신이 오래되면 옵티마이저가 비효율적 계획 선택 — DBA에게 `UPDATE STATISTICS <table>` 실행 요청.

인덱스 생성은 관리자 작업 — 애플리케이션 계정으로는 실행 불가.

## 새 조합 템플릿 만들 때 체크리스트

1. 모든 복합 SELECT에 `SELECT TOP ${limit}` 또는 `OFFSET/FETCH NEXT` 포함을 프롬프트로 강제.
2. 모든 테이블·뷰 참조에 스키마 포함(`dbo.`, `SalesLT.` 등)을 프롬프트로 강제.
3. `WITH`(CTE) 접두어는 서버 검증에 걸리므로 인라인 뷰로 대체하도록 프롬프트 안내. `;WITH` 관용구도 마찬가지로 거절되는 점 주의.
4. `CROSS APPLY`/`OUTER APPLY`는 T-SQL 강점 — "각 그룹의 상위 N건" 패턴에 적극 활용.
5. 타입 변환은 `TRY_CAST`/`TRY_CONVERT` 사용 — 실패 시 예외 없이 `NULL` 반환.
