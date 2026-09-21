# Oracle Database — DB 레퍼런스

`create-database-chat` 스캐폴딩이 생성하는 Oracle 기반 템플릿(`claude-oracle`, `gemini-oracle`, `codex-oracle`)이 Oracle Database를 어떻게 연동하는지 기술한 참조 문서 세트입니다.

새로운 `<llm>-oracle` 조합 템플릿을 만들거나 기존 템플릿을 수정할 때 이 문서를 참고하세요.

## 핵심 원칙

- **`node-oracledb`(oracledb 6.x) 커넥션 풀을 사용한다.** ORM은 도입하지 않고, `pool.getConnection()` → `conn.execute()`로 직접 SQL을 실행합니다.
- **기본은 Thin 모드.** oracledb 6.x는 순수 JS Thin 모드가 기본이라 Oracle Instant Client를 설치할 필요가 없습니다. Thick 모드(Wallet/TLS·Advanced Queuing·XMLType 등)가 필요할 때만 [`instant-client.md`](./instant-client.md) 참고.
- **엔드포인트는 `/db-query` 하나로 통합한다.** MongoDB/MySQL 템플릿이 `/db-query`와 `/db-aggregate`를 나눈 것과 달리, Oracle 템플릿은 단순 SELECT·JOIN·집계를 모두 같은 엔드포인트에서 처리합니다.
- **읽기 전용을 강제한다.** LLM이 보낸 SQL은 서버가 검사해 `SELECT`·`EXPLAIN`·`SHOW`·`DESCRIBE`·`DESC` 접두어만 통과시킵니다.
- **민감 컬럼은 서버가 지워서 응답한다.** `password`, `pass_hash`, `passwd`, `pwd`, `secret` (Oracle의 기본 대문자 컬럼명도 소문자 비교로 매칭)은 응답 rows에서 강제 제거합니다.
- **행 제한은 SQL과 드라이버 옵션 양쪽에서 강제한다.** LLM은 `FETCH FIRST n ROWS ONLY`(Oracle 12c+) 또는 `ROWNUM <= n`을 SQL에 넣고, 서버는 `execute(..., { maxRows: limit })`로 드라이버 레벨에서 한 번 더 자르는 이중 방어.

## 문서 구성

| 파일 | 내용 |
| --- | --- |
| [`connection.md`](./connection.md) | `oracledb.createPool` 옵션·연결·타임아웃, 필수 환경 변수, 계정 최소 권한 |
| [`query.md`](./query.md) | `/db-query` 엔드포인트 규약 — SQL 접두어 검증, `FETCH FIRST`/`ROWNUM` 페이징, `maxRows`/`fetchArraySize`, `outFormat`, 민감 컬럼 제거 |
| [`join-group.md`](./join-group.md) | 복합 SELECT 패턴 — JOIN, GROUP BY/HAVING, 서브쿼리, 분석 함수, 계층 쿼리(`CONNECT BY`), 인라인 뷰 (`WITH`는 서버 검증에 걸리므로 대안 제시) |
| [`type-conversion.md`](./type-conversion.md) | `oracledb` 드라이버의 Oracle ↔ JavaScript 타입 매핑, `NUMBER`/`DATE`/`TIMESTAMP WITH TIME ZONE`, `CLOB`/`BLOB`, `RAW` |
| [`instant-client.md`](./instant-client.md) | Thin vs Thick 모드 비교, Instant Client 설치(macOS/Linux/Windows), `initOracleClient()` 활성화 방법 |

## 참고 링크

- Oracle Database 공식 문서: <https://docs.oracle.com/en/database/oracle/index.html>
- `node-oracledb`: <https://node-oracledb.readthedocs.io/>
- Oracle Instant Client: <https://www.oracle.com/database/technologies/instant-client.html>
- 기준 구현: [`templates/claude-oracle/server.ts`](../../templates/claude-oracle/server.ts)
