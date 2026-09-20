# MySQL — DB 레퍼런스

`create-database-chat` 스캐폴딩이 생성하는 MySQL 기반 템플릿(`claude-mysql`, `gemini-mysql`, `codex-mysql`)이 MySQL을 어떻게 연동하는지 기술한 참조 문서 세트입니다.

새로운 `<llm>-mysql` 조합 템플릿을 만들거나 기존 템플릿을 수정할 때 이 문서를 참고하세요.

## 핵심 원칙

- **`mysql2/promise` 커넥션 풀을 사용한다.** ORM은 도입하지 않고, `pool.query()`로 직접 SQL을 실행합니다.
- **읽기 전용을 강제한다.** LLM이 보낸 SQL은 서버가 검사해 `SELECT`·`EXPLAIN`·`SHOW`·`DESCRIBE`·`DESC` 접두어만 통과시키고, `INSERT`·`UPDATE`·`DELETE`·`DROP`·`ALTER`·`CREATE`·`TRUNCATE`·`REPLACE`·`MERGE`·`EXEC`·`CALL`·`GRANT`·`REVOKE`·`LOAD DATA`·`INTO OUTFILE`·`INTO DUMPFILE`는 키워드 단위로 차단합니다.
- **민감 컬럼은 서버가 지워서 응답한다.** `password`, `pass_hash`, `passwd`, `pwd`, `secret`은 응답 rows에서 강제 제거합니다.
- **엔드포인트를 목적별로 분리한다.** 단순 `SELECT` + `WHERE`/`ORDER BY`는 `/db-query`, `JOIN`·`GROUP BY`·`HAVING`·서브쿼리는 `/db-aggregate`. LLM 프롬프트가 이 라우팅을 강제합니다.

## 문서 구성

| 파일 | 내용 |
| --- | --- |
| [`connection.md`](./connection.md) | `mysql2` 풀 생성·연결·타임아웃, 필수 환경 변수, 계정 최소 권한 |
| [`query.md`](./query.md) | `/db-query` 엔드포인트 규약 — 단순 `SELECT` 실행, 자동 `LIMIT` 부착, 민감 컬럼 제거 |
| [`join-group.md`](./join-group.md) | `/db-aggregate` 엔드포인트 규약 — `JOIN`·`GROUP BY`·`HAVING`·서브쿼리 지원, `LIMIT` 자동 부착 없음 |
| [`type-conversion.md`](./type-conversion.md) | `mysql2` 드라이버의 MySQL ↔ JavaScript 타입 매핑, timezone, `DECIMAL`/`BIGINT` 문자열화 |

## 참고 링크

- MySQL 공식 문서: <https://dev.mysql.com/doc/>
- `mysql2` 드라이버: <https://github.com/sidorares/node-mysql2>
- 기준 구현: [`templates/claude-mysql/server.ts`](../../templates/claude-mysql/server.ts)
