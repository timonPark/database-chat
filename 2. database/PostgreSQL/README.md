# PostgreSQL — DB 레퍼런스

`create-database-chat` 스캐폴딩이 생성하는 PostgreSQL 기반 템플릿(`claude-postgresql`, `gemini-postgresql`, `codex-postgresql`)이 PostgreSQL을 어떻게 연동하는지 기술한 참조 문서 세트입니다.

새로운 `<llm>-postgresql` 조합 템플릿을 만들거나 기존 템플릿을 수정할 때 이 문서를 참고하세요.

## 핵심 원칙

- **`pg` (node-postgres) 커넥션 풀을 사용한다.** ORM은 도입하지 않고, `pool.connect()` → `client.query()`로 직접 SQL을 실행합니다.
- **엔드포인트는 `/db-query` 하나로 통합한다.** MongoDB/MySQL 템플릿이 `/db-query`와 `/db-aggregate`를 나눈 것과 달리, PostgreSQL 템플릿은 단순 SELECT·CTE·JOIN·집계·윈도우 함수를 모두 같은 엔드포인트에서 처리합니다.
- **읽기 전용을 강제한다.** LLM이 보낸 SQL은 서버가 검사해 `SELECT`·`WITH`·`EXPLAIN` 접두어만 통과시키고, `INSERT`·`UPDATE`·`DELETE`·`DROP`·`TRUNCATE`·`ALTER`·`CREATE`·`REPLACE`·`GRANT`·`REVOKE`·`COPY`·`VACUUM`·`ANALYZE`는 키워드 단위로 차단합니다.
- **민감 컬럼은 서버가 지워서 응답한다.** `password`, `pass_hash`, `passwd`, `pwd`, `secret`은 응답 rows에서 강제 제거합니다.
- **파라미터 바인딩을 우선한다.** 사용자 입력·동적 값은 `$1`, `$2` placeholder + `params: []`로 전달해 SQL 인젝션 벡터를 원천 차단합니다.

## 문서 구성

| 파일 | 내용 |
| --- | --- |
| [`connection.md`](./connection.md) | `pg` 풀 생성·연결·타임아웃, 필수 환경 변수, 계정 최소 권한 |
| [`query.md`](./query.md) | `/db-query` 엔드포인트 규약 — SQL 검증, 파라미터 바인딩, `statement_timeout`, 민감 컬럼 제거 |
| [`join-group.md`](./join-group.md) | 복합 SELECT 패턴 — CTE(`WITH`), JOIN, GROUP BY/HAVING, 서브쿼리, 윈도우 함수, JSONB 조회 |
| [`type-conversion.md`](./type-conversion.md) | `pg` 드라이버의 PostgreSQL ↔ JavaScript 타입 매핑, `BIGINT`/`NUMERIC` 문자열화, `TIMESTAMP` vs `TIMESTAMPTZ` |

## 참고 링크

- PostgreSQL 공식 문서: <https://www.postgresql.org/docs/>
- `pg` (node-postgres): <https://node-postgres.com/>
- 기준 구현: [`templates/claude-postgresql/server.ts`](../../templates/claude-postgresql/server.ts)
