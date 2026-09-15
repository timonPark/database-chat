# TODO

> 마지막 업데이트: 2026-09-14

---

## 완료

- [x] CLI 스캐폴딩 (`src/index.ts`) — 5단계 대화형 프롬프트, 템플릿 복사, 패키지 설치
- [x] Docker Compose 5종 (`docker/<db>/docker-compose.yml`)
- [x] Seed 스크립트 5종 (`seeds/<db>/seed.sh`)
- [x] `claude-mongodb` 템플릿 완성
- [x] 스키마 추출 스크립트 5종 (`seeds/<db>/extract-schema.ts`) — TS가 DB 접속·추출 담당, 자격증명 LLM에 미노출
- [x] 스키마 인덱스 생성 프롬프트 — Claude 버전 5종 (`seeds/<db>/generate-schema-prompt.claude.md`)
- [x] 스키마 인덱스 생성 프롬프트 — Gemini / Codex 공간 생성 (각 5종, 내용 작성 필요)
- [x] `src/index.ts` — 스캐폴딩 시 `extract-schema.ts` + `generate-schema-prompt.md` + `generate-schema.sh` 자동 생성

---

## 남은 작업

### 1. generate-schema 프롬프트 작성 (Gemini / Codex)

> 직접 작성 예정  
> 형식: `{{SCHEMA}}` · `{{DB_DATABASE}}` · `{{TODAY}}` 플레이스홀더 사용, JSON 응답 (`{"index": "...", "mapping": "..."}`)

| 파일 | 상태 |
|------|------|
| `seeds/mongodb/generate-schema-prompt.gemini.md` | ⬜ |
| `seeds/mysql/generate-schema-prompt.gemini.md` | ⬜ |
| `seeds/postgresql/generate-schema-prompt.gemini.md` | ⬜ |
| `seeds/oracle/generate-schema-prompt.gemini.md` | ⬜ |
| `seeds/mssql/generate-schema-prompt.gemini.md` | ⬜ |
| `seeds/mongodb/generate-schema-prompt.codex.md` | ⬜ |
| `seeds/mysql/generate-schema-prompt.codex.md` | ⬜ |
| `seeds/postgresql/generate-schema-prompt.codex.md` | ⬜ |
| `seeds/oracle/generate-schema-prompt.codex.md` | ⬜ |
| `seeds/mssql/generate-schema-prompt.codex.md` | ⬜ |

---

### 2. Claude + SQL 템플릿 4종

> `claude-mongodb`의 `server.ts`에서 DB 드라이버·쿼리 부분만 교체

#### 공통 교체 포인트 (`server.ts`)

| 항목 | claude-mongodb | SQL 변경 내용 |
|------|---------------|--------------|
| DB 드라이버 | `mongodb` | `mysql2` / `pg` / `oracledb` / `mssql` |
| 커넥션 풀 | `MongoClient` | 각 드라이버 Pool / Connection |
| `/db-query` | `collection.find()` | `SELECT` SQL 생성 |
| `/db-aggregate` | `collection.aggregate()` | `JOIN` / `GROUP BY` SQL 생성 |
| ObjectId 변환 | `convertOid()` | 불필요 — 제거 |
| 시스템 프롬프트 | curl 예시 MongoDB JSON 형식 | SQL 파라미터 형식으로 변경 |
| 인덱스 파일 | `collection-mapping.md` | `table-mapping.md` |

#### 템플릿별 체크리스트

- [ ] **`claude-mysql`**
  - [ ] `server.ts` — `mysql2/promise` Pool, SELECT/JOIN 쿼리
  - [ ] `.env.example` — `DB_PORT=3306`
  - [ ] `package.json` — `mysql2` 의존성
  - [ ] `index.md` / `table-mapping.md` 플레이스홀더
  - [ ] `public/index.html` / `tsconfig.json` / `_gitignore` — `claude-mongodb`에서 복사

- [ ] **`claude-postgresql`**
  - [ ] `server.ts` — `pg` Pool, SELECT/JOIN 쿼리
  - [ ] `.env.example` — `DB_PORT=5432`
  - [ ] `package.json` — `pg` 의존성
  - [ ] `index.md` / `table-mapping.md` 플레이스홀더
  - [ ] `public/index.html` / `tsconfig.json` / `_gitignore` — 복사

- [ ] **`claude-oracle`**
  - [ ] `server.ts` — `oracledb` Connection, SELECT/JOIN 쿼리
  - [ ] `.env.example` — `DB_PORT=1521`, `DB_SERVICE_NAME`
  - [ ] `package.json` — `oracledb` 의존성
  - [ ] `index.md` / `table-mapping.md` 플레이스홀더
  - [ ] `public/index.html` / `tsconfig.json` / `_gitignore` — 복사
  - [ ] Oracle Instant Client 설치 안내 추가

- [ ] **`claude-mssql`**
  - [ ] `server.ts` — `mssql` Pool, SELECT/JOIN 쿼리
  - [ ] `.env.example` — `DB_PORT=1433`
  - [ ] `package.json` — `mssql` 의존성
  - [ ] `index.md` / `table-mapping.md` 플레이스홀더
  - [ ] `public/index.html` / `tsconfig.json` / `_gitignore` — 복사

- [ ] **`src/index.ts`** — `AVAILABLE_COMBOS`에 4개 추가

---

### 3. Gemini 템플릿 5종

> 2번 완료 + 1번 Gemini 프롬프트 작성 후 진행

- [ ] `gemini-mongodb`
- [ ] `gemini-mysql`
- [ ] `gemini-postgresql`
- [ ] `gemini-oracle`
- [ ] `gemini-mssql`

---

### 4. Codex 템플릿 5종

> 2번 완료 + 1번 Codex 프롬프트 작성 후 진행

- [ ] `codex-mongodb`
- [ ] `codex-mysql`
- [ ] `codex-postgresql`
- [ ] `codex-oracle`
- [ ] `codex-mssql`

---

### 5. LLM 제공자 레퍼런스 문서 (`1.llm_provider/`)

- [ ] `claude/` — CLI 개요, spawn 방법, 시스템 프롬프트 가이드, 모델 비교, 환경변수
- [ ] `gemini/` — API 개요, SDK 호출 방법, 시스템 인스트럭션 가이드, 모델 비교, 환경변수
- [ ] `codex/` — API 개요, function calling, 프롬프트 가이드, 모델 비교, 환경변수

---

### 6. DB 레퍼런스 문서 (`2.database/`)

- [ ] `MongoDB/` — 연결, 쿼리, 집계, 타입 변환
- [ ] `MySQL/` — 연결, 쿼리, 집계
- [ ] `PostgreSQL/` — 연결, 쿼리, 집계
- [ ] `Oracle Database/` — 연결, 쿼리, 집계, Instant Client 설치
- [ ] `Microsoft SQL Server/` — 연결, 쿼리, 집계

---

### 7. 배포 준비

- [ ] `package.json` 메타 필드 채우기 (`author`, `license`, `repository`, `keywords`)
- [ ] `npm pack`으로 번들 내용물 확인
- [ ] `npx create-database-chat` E2E 테스트 (15개 조합 완성 후)
- [ ] GitHub 저장소 초기 커밋 및 원격 연결
- [ ] GitHub Actions CI 설정 (빌드 + typecheck)
- [ ] `npm publish --access public`

---

## 지원 조합 현황

| | MongoDB | MySQL | PostgreSQL | Oracle | MSSQL |
|---|:---:|:---:|:---:|:---:|:---:|
| **Claude** | ✅ | ⬜ | ⬜ | ⬜ | ⬜ |
| **Gemini** | ⬜ | ⬜ | ⬜ | ⬜ | ⬜ |
| **Codex**  | ⬜ | ⬜ | ⬜ | ⬜ | ⬜ |

✅ 완료 · ⬜ 미완료
