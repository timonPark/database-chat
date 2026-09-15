# Claude 시스템 프롬프트

`--system-prompt` 인자로 전달하는 프롬프트의 구조와 각 DB 템플릿의 커스터마이즈 지점을 설명합니다.

## 프롬프트 5블록 구조

기준 구현: `templates/claude-mongodb/server.ts:174` (`buildSystemPrompt`).

```
1. 역할 한 줄 (설명 없이 즉시 실행 지시)
2. [스키마 요약]        — 테이블/컬렉션 목록 + 한 줄 설명
3. [선택 가이드]        — 자연어 키워드 → 스키마 매핑
4. [엔드포인트 사용법]  — /db-query, /db-aggregate curl 예시
5. 규칙                 — 민감 필드 마스킹, LIMIT, 오류 처리 등
```

블록 사이는 빈 줄로 구분합니다. Claude가 규칙을 놓치지 않도록 규칙은 짧은 불릿으로 유지하세요.

## 블록별 세부

### 1. 역할 한 줄

한 문장으로 "설명 없이 즉시 curl 실행 후 한국어로 답한다"를 못박습니다. 이 문장이 없으면 Claude가 사용자에게 계획을 설명하면서 턴을 소비합니다.

```
MongoDB 조회 어시스턴트. 설명 없이 즉시 curl로 쿼리 실행 후 결과를 한국어로 답한다.
```

### 2. 스키마 요약

`buildTableSummary()` / `buildCollectionSummary()`가 `collection-mapping.md` 또는 `index.md` 표를 파싱해 `이름 — 설명` 목록을 만듭니다. 프롬프트 토큰을 줄이기 위해 표 원본이 아닌 요약만 넣습니다.

### 3. 선택 가이드

자연어 → 스키마 매핑용 행: `이름 | 키워드 | 주요 필드 | 설명`. Claude가 "회원", "결제" 같은 애매한 요청을 스키마로 라우팅할 때 참고합니다.

### 4. 엔드포인트 사용법

정확한 curl 명령을 그대로 넣습니다. `${requestId}`, `${PORT}`, `${limit}`은 서버 런타임에 인터폴레이션됩니다. `requestId`가 프롬프트 안에 있어야 취소 매칭이 됩니다.

MongoDB 예:

```
[단일 컬렉션] curl -sX POST http://localhost:${PORT}/db-query -H 'Content-Type: application/json' -d '{"requestId":"${requestId}","collection":"...","filter":{...},"projection":{...},"limit":${limit}}'
[조인/집계]  curl -sX POST http://localhost:${PORT}/db-aggregate ...
```

SQL 예 (MySQL/PostgreSQL/Oracle/MSSQL):

```
[단순 조회] curl -sX POST http://localhost:${PORT}/db-query -H '...' -d '{"requestId":"${requestId}","sql":"SELECT ... LIMIT ${limit}"}'
[집계/조인] curl -sX POST http://localhost:${PORT}/db-aggregate -H '...' -d '{"requestId":"${requestId}","sql":"SELECT ... GROUP BY ... LIMIT ${limit}"}'
```

### 5. 규칙

모든 템플릿 공통:

- 민감 필드 마스킹 (`password`, `passHash`, `pass_hash` 등)
- 결과 없으면 즉시 `"조회된 데이터가 없습니다"`
- 오류 시 원인 설명
- `LIMIT`은 서버가 넘긴 값 사용 — 엑셀 내보내기가 동일 쿼리를 재실행하므로 값이 흔들리면 안 됨

DB별 추가 규칙:

- **MongoDB**: Extended JSON (`$date`, `$oid`, `$numberDecimal`), `$lookup` 후 `$group` 중복 제거, `$out`/`$merge` 금지
- **SQL**: `SELECT`만 허용 (INSERT/UPDATE/DELETE/DDL 금지), `EXPLAIN`으로 실행 계획 확인 가능
- **거래 내역 등 대용량 테이블**: 쿼리 실행 전 "요약 vs 로우" 여부를 되묻도록 규칙 추가

## 스키마 정보 소스

- **인덱스 파일**: `./index.md` — 자연어 키워드 → 이름 매핑 요약 (없으면 `collection-mapping.md`/`table-mapping.md`로 폴백).
- **스키마 상세**: `./collections/<name>.md` (Mongo) 또는 `./tables/<name>.md` (SQL).

Claude에게는 요약만 주입하고, 필드명이 애매하면 `cat <스키마 파일>`을 호출하도록 프롬프트에 안내합니다:

```
[필드 확인] 필드명 불확실 시: cat "${COLLECTIONS_DIR}/<컬렉션명>.md"
```

## 커스터마이즈 지점

새 `claude-<db>` 템플릿을 만들 때 바꿔야 할 것:

1. 역할 한 줄의 DB 이름
2. 스키마 요약/가이드 소스 파서 (Mongo는 컬렉션, SQL은 테이블)
3. 엔드포인트 페이로드 스키마 (`collection`+`filter` vs `sql`)
4. DB 방언별 규칙 (Extended JSON, EXPLAIN, `TOP` vs `LIMIT` 등)

`spawn` 인자, SSE 프로토콜, `activeJobs` 취소 로직은 절대 바꾸지 마세요. 프런트엔드가 그 계약에 의존합니다.
