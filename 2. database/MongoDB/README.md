# MongoDB — DB 레퍼런스

`create-database-chat` 스캐폴딩이 생성하는 MongoDB 기반 템플릿(`claude-mongodb`, `gemini-mongodb`, `codex-mongodb`)이 MongoDB를 어떻게 연동하는지 기술한 참조 문서 세트입니다.

새로운 `<llm>-mongodb` 조합 템플릿을 만들거나 기존 템플릿을 수정할 때 이 문서를 참고하세요.

## 핵심 원칙

- **공식 드라이버를 사용한다.** `mongodb` 노드 드라이버 하나로 `MongoClient` → `Db` → `Collection` 계층을 다루며, ORM은 도입하지 않습니다.
- **읽기 전용을 강제한다.** LLM은 서버 내부 엔드포인트(`/db-query`, `/db-aggregate`)만 호출할 수 있고, 파이프라인 단계에서 `$out`·`$merge`는 서버가 차단합니다.
- **민감 필드는 서버가 지워서 응답한다.** `password`, `passHash`는 프로젝션·집계 결과 양쪽에서 강제 제거합니다.
- **Extended JSON을 표준으로 쓴다.** LLM이 조립하는 필터·파이프라인은 `{"$oid":...}`, `{"$date":...}`, `{"$numberDecimal":...}` 형식으로 전달되며 서버가 BSON 타입으로 변환합니다.

## 문서 구성

| 파일 | 내용 |
| --- | --- |
| [`connection.md`](./connection.md) | `MongoClient` 생성·연결·풀·타임아웃과 필수 환경 변수 |
| [`query.md`](./query.md) | `/db-query` 엔드포인트 규약 — `find` 기반 단일 컬렉션 조회, count + data 2단계 실행 |
| [`aggregate.md`](./aggregate.md) | `/db-aggregate` 엔드포인트 규약 — 파이프라인 보안 검증, 자동 `$limit` 주입, `$lookup`/`$group` 관례 |
| [`type-conversion.md`](./type-conversion.md) | Extended JSON → BSON 변환 규칙 (`ObjectId`, `Date`, `Decimal128`) |

## 참고 링크

- MongoDB 공식 문서: <https://www.mongodb.com/docs/>
- Node.js 드라이버: <https://www.mongodb.com/docs/drivers/node/current/>
- Extended JSON v2: <https://www.mongodb.com/docs/manual/reference/mongodb-extended-json/>
- 기준 구현: [`templates/claude-mongodb/server.ts`](../../templates/claude-mongodb/server.ts)
