# Microsoft SQL Server — DB 레퍼런스

`create-database-chat` 스캐폴딩이 생성하는 SQL Server 기반 템플릿(`claude-mssql`, `gemini-mssql`, `codex-mssql`)이 Microsoft SQL Server를 어떻게 연동하는지 기술한 참조 문서 세트입니다.

새로운 `<llm>-mssql` 조합 템플릿을 만들거나 기존 템플릿을 수정할 때 이 문서를 참고하세요.

## 핵심 원칙

- **`mssql` 노드 드라이버 커넥션 풀을 사용한다.** ORM은 도입하지 않고, `sql.connect()`로 `ConnectionPool`을 만들어 `pool.request().query()`로 직접 T-SQL을 실행합니다.
- **엔드포인트는 `/db-query` 하나로 통합한다.** MongoDB/MySQL 템플릿이 `/db-query`와 `/db-aggregate`를 나눈 것과 달리, MSSQL 템플릿은 단순 SELECT·JOIN·집계를 모두 같은 엔드포인트에서 처리합니다.
- **읽기 전용을 강제한다.** LLM이 보낸 SQL은 서버가 검사해 `SELECT`·`EXPLAIN`·`SHOW`·`DESCRIBE`·`DESC` 접두어만 통과시킵니다.
- **민감 컬럼은 서버가 지워서 응답한다.** `password`, `pass_hash`, `passwd`, `pwd`, `secret` (대소문자 무관 매칭)은 응답 rows에서 강제 제거합니다.
- **행 제한은 T-SQL 문법으로 SQL 안에 명시한다.** LLM은 `SELECT TOP n ...` 또는 `... OFFSET 0 ROWS FETCH NEXT n ROWS ONLY`를 SQL에 직접 넣습니다. 서버가 SQL을 재작성하거나 별도 옵션으로 잘라내지 않습니다.
- **테이블명은 항상 스키마와 함께 표기한다.** 예: `SalesLT.Product`, `dbo.ErrorLog`. SQL Server는 다중 스키마 사용이 일반적이라 스키마 없이 쓰면 사용자 기본 스키마에 따라 결과가 달라지거나 오류가 발생합니다 — 프롬프트가 이 규약을 강제합니다.

## 문서 구성

| 파일 | 내용 |
| --- | --- |
| [`connection.md`](./connection.md) | `sql.connect` 옵션·연결 풀·타임아웃, 필수 환경 변수, 계정 최소 권한 |
| [`query.md`](./query.md) | `/db-query` 엔드포인트 규약 — SQL 접두어 검증, `TOP`/`OFFSET FETCH` 페이징, `request.timeout`, 민감 컬럼 제거 |
| [`join-group.md`](./join-group.md) | 복합 SELECT 패턴 — JOIN, GROUP BY/HAVING, 서브쿼리, 윈도우 함수, 인라인 뷰 (`WITH`는 서버 검증에 걸리므로 대안 제시) |
| [`type-conversion.md`](./type-conversion.md) | `mssql` 드라이버의 T-SQL ↔ JavaScript 타입 매핑, `BIGINT`/`DECIMAL` 반환 형태, `DATETIME` vs `DATETIMEOFFSET`, `NVARCHAR`/`VARCHAR` |

## 참고 링크

- SQL Server / T-SQL 공식 문서: <https://learn.microsoft.com/ko-kr/sql/?view=sql-server-ver17>
- `mssql` (node-mssql): <https://github.com/tediousjs/node-mssql>
- 기준 구현: [`templates/claude-mssql/server.ts`](../../templates/claude-mssql/server.ts)
