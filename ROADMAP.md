# ROADMAP

> 마지막 업데이트: 2026-09-14

---

## 완료된 작업

### CLI 뼈대 (`src/index.ts`)
- [x] 대화형 프롬프트 5단계 구현
  - [x] 프로젝트 이름
  - [x] LLM 제공자 선택 (Claude / Gemini / Codex)
  - [x] 데이터베이스 선택 (MongoDB / MySQL / PostgreSQL / Oracle / MSSQL)
  - [x] DB 연동 방식 (기존 DB 연동 / Docker로 새 DB 생성)
  - [x] 샘플 데이터 마이그레이션 여부 (Docker 모드 시)
- [x] 템플릿 파일 복사 + `{{PROJECT_NAME}}` 치환
- [x] `_gitignore` → `.gitignore` 자동 변환
- [x] `package.json` name 필드 자동 교체
- [x] 패키지 매니저 자동 감지 및 `npm install` 실행
- [x] coming-soon 조합 선택 시 docker-compose / seed만 생성 후 안내

### 인프라 파일
- [x] Docker Compose 5종 (`docker/<db>/docker-compose.yml`)
  - [x] MongoDB, MySQL, PostgreSQL, Oracle, MSSQL
- [x] 샘플 데이터 seed 스크립트 5종 (`seeds/<db>/seed.sh`)
  - [x] MongoDB — Atlas Sample Datasets (`mongorestore`)
  - [x] MySQL — Sakila (`mysql < schema.sql`)
  - [x] PostgreSQL — dvdrental (`pg_restore`)
  - [x] Oracle — HR Schema (`sqlplus @hr_install.sql`)
  - [x] MSSQL — AdventureWorksLT2022 (`sqlcmd RESTORE DATABASE`)

### 완성된 템플릿 (1 / 15)
- [x] `claude-mongodb` — Express + Claude CLI + MongoDB 드라이버

### 문서
- [x] `README.md` — 사용법, 지원 조합 현황, 컬렉션 설정, 레퍼런스 문서 구조, 기여 가이드

---

## 남은 작업

### 1단계 — Claude + 나머지 SQL DB 템플릿 (우선순위 높음)

Claude 조합은 LLM 호출 방식이 동일하므로 `server.ts`의 DB 연결·쿼리 부분만 교체하면 됩니다.

#### 공통 작업 (DB별 반복)
각 템플릿에 필요한 파일:

```
templates/<llm>-<db>/
├── server.ts               ← DB 드라이버 교체 핵심 작업
├── public/index.html       ← claude-mongodb와 동일 (복사)
├── docker/docker-compose.yml  ← docker/<db>/에서 복사
├── .env.example            ← DB별 환경변수 조정
├── package.json            ← DB 드라이버 의존성 교체
├── tsconfig.json           ← 동일 (복사)
├── _gitignore              ← 동일 (복사)
├── index.md                ← DB/스키마별 테이블 목록 플레이스홀더
└── table-mapping.md        ← 자연어 ↔ 테이블명 매핑 플레이스홀더
```

#### `server.ts` 교체 포인트
| 항목 | claude-mongodb 현재 | SQL DB 변경 내용 |
|------|-------------------|----------------|
| DB 드라이버 import | `mongodb` | `mysql2` / `pg` / `oracledb` / `mssql` |
| 커넥션 풀 | `MongoClient` | 각 드라이버 풀 |
| `/db-query` 구현 | `collection.find()` | `SELECT` SQL 생성 |
| `/db-aggregate` 구현 | `collection.aggregate()` | `JOIN` SQL 생성 |
| ObjectId 변환 | `convertOid()` | 불필요 (제거) |
| 시스템 프롬프트 | curl 예시가 MongoDB JSON | SQL 파라미터 형식으로 변경 |

#### 템플릿별 진행 상태
- [ ] `claude-mysql`
  - 드라이버: `mysql2/promise`
  - 포트: 3306
  - 인증: user / password
- [ ] `claude-postgresql`
  - 드라이버: `pg`
  - 포트: 5432
  - 인증: user / password
- [ ] `claude-oracle`
  - 드라이버: `oracledb`
  - 포트: 1521 / PDB: XEPDB1
  - 주의: oracledb는 Oracle Instant Client 별도 설치 필요
- [ ] `claude-mssql`
  - 드라이버: `mssql`
  - 포트: 1433
  - 인증: SA 계정

---

### 2단계 — LLM 제공자 레퍼런스 문서 작성

`1.llm_provider/<name>/` 폴더에 구현 가이드 작성.  
새 LLM 조합 템플릿을 만들 때 참고하는 문서입니다.

- [ ] `1.llm_provider/claude/`
  - [ ] `README.md` — Claude CLI 개요, 사전 설치 요건
  - [ ] `spawn.md` — subprocess spawn 방법, stream-json 파싱
  - [ ] `system-prompt.md` — DB 조회 어시스턴트용 프롬프트 작성 가이드
  - [ ] `models.md` — Haiku / Sonnet / Opus 비교 (속도·비용·품질)
  - [ ] `env.md` — `CLAUDE_MODEL`, `CLAUDE_MAX_TURNS` 설명

- [ ] `1.llm_provider/gemini/`
  - [ ] `README.md` — Gemini API 개요, API 키 발급
  - [ ] `spawn.md` — `@google/generative-ai` SDK로 호출하는 방법
  - [ ] `system-prompt.md` — Gemini용 시스템 인스트럭션 작성 가이드
  - [ ] `models.md` — gemini-1.5-flash / pro 비교
  - [ ] `env.md` — `GEMINI_API_KEY`, `GEMINI_MODEL`

- [ ] `1.llm_provider/codex/`
  - [ ] `README.md` — OpenAI API 개요, API 키 발급
  - [ ] `spawn.md` — `openai` SDK로 호출하는 방법 (tool_use / function calling)
  - [ ] `system-prompt.md` — GPT용 프롬프트 작성 가이드
  - [ ] `models.md` — gpt-4o / gpt-4o-mini 비교
  - [ ] `env.md` — `OPENAI_API_KEY`, `OPENAI_MODEL`

---

### 3단계 — DB 레퍼런스 문서 작성

`2.database/<name>/` 폴더에 구현 가이드 작성.

- [ ] `2.database/MongoDB/`
  - [ ] `README.md`, `connection.md`, `query.md`, `aggregate.md`, `type-conversion.md`
- [ ] `2.database/MySQL/`
  - [ ] `README.md`, `connection.md`, `query.md`, `aggregate.md`
- [ ] `2.database/PostgreSQL/`
  - [ ] `README.md`, `connection.md`, `query.md`, `aggregate.md`
- [ ] `2.database/Oracle Database/`
  - [ ] `README.md`, `connection.md`, `query.md`, `aggregate.md`
  - [ ] 주의: Instant Client 설치 가이드 포함
- [ ] `2.database/Microsoft SQL Server/`
  - [ ] `README.md`, `connection.md`, `query.md`, `aggregate.md`

---

### 4단계 — Gemini / Codex 템플릿 (10개)

2단계 레퍼런스 문서 완성 후 진행.

- [ ] `gemini-mongodb`
- [ ] `gemini-mysql`
- [ ] `gemini-postgresql`
- [ ] `gemini-oracle`
- [ ] `gemini-mssql`
- [ ] `codex-mongodb`
- [ ] `codex-mysql`
- [ ] `codex-postgresql`
- [ ] `codex-oracle`
- [ ] `codex-mssql`

---

### 5단계 — 배포 준비

- [ ] `npm publish` 전 점검
  - [ ] `package.json` — `version`, `author`, `license`, `repository`, `keywords` 필드 채우기
  - [ ] `files` 배열 확인 (`dist/`, `templates/`, `docker/`, `seeds/`)
  - [ ] `npm pack`으로 번들 내용물 확인
  - [ ] `npx create-database-chat`으로 E2E 테스트

- [ ] npm 패키지 배포
  - [ ] `npm login`
  - [ ] `npm publish --access public`

- [ ] GitHub 저장소
  - [ ] 초기 커밋 및 원격 저장소 연결
  - [ ] `README.md` 배지 추가 (npm version, license)
  - [ ] GitHub Actions CI 설정 (빌드 + typecheck)

---

## 지원 조합 현황

| | MongoDB | MySQL | PostgreSQL | Oracle | MSSQL |
|---|:---:|:---:|:---:|:---:|:---:|
| **Claude** | ✅ | 🔲 | 🔲 | 🔲 | 🔲 |
| **Gemini** | 🔲 | 🔲 | 🔲 | 🔲 | 🔲 |
| **Codex**  | 🔲 | 🔲 | 🔲 | 🔲 | 🔲 |

✅ 완료 · 🔲 미완료
