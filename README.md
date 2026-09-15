# create-database-chat

자연어로 데이터베이스를 조회하는 채팅 앱을 한 줄 명령어로 생성하는 CLI 스캐폴딩 도구.

LLM 제공자(Claude / Gemini / Codex)와 데이터베이스(MongoDB / MySQL / PostgreSQL / Oracle / MSSQL)를 선택하면 바로 실행 가능한 프로젝트를 생성합니다.

```
$ npx create-database-chat my-app
```

---

## 동작 방식

```
사용자 자연어 입력
       ↓
   LLM (Claude 등)
       ↓  curl로 내부 API 호출
  Express 서버
       ↓
   데이터베이스
       ↓
  HTML 채팅 UI 출력
```

LLM은 직접 DB에 접근하지 않고 서버 내부 HTTP 엔드포인트(`/db-query`, `/db-aggregate`)에 curl로 요청합니다. DB 자격증명이 LLM에 노출되지 않으며, 커넥션 풀도 서버가 관리합니다.

---

## 빠른 시작

### 요구사항

- Node.js 18 이상
- 선택한 LLM의 CLI 또는 API 키
- 연결할 데이터베이스

### 프로젝트 생성

```bash
npx create-database-chat my-app
```

대화형 프롬프트에서 LLM 제공자와 데이터베이스를 선택합니다.

```
┌  create-database-chat
│
◆  LLM provider:
│  ● Claude          Anthropic — claude-haiku / sonnet
│  ○ Gemini          Google — coming soon
│  ○ Codex           OpenAI — coming soon
└

◆  Database:
│  ● MongoDB          document
│  ○ MySQL            coming soon
│  ...
└

◆  Package manager:
│  ● npm
│  ○ pnpm
│  ○ yarn
└
```

### 프로젝트 실행

```bash
cd my-app
cp .env.example .env
# .env에 DB 접속 정보 입력

npm run schema
# DB에 접속해 컬렉션(테이블) 목록·건수·필드를 추출하고
# LLM이 index.md / collection-mapping.md 를 자동 생성합니다

npm start
# → http://localhost:3111
```

> **`npm run schema` 동작 방식**
> 1. `scripts/extract-schema.ts` — .env를 읽어 DB에 접속, 스키마 정보만 stdout 출력 (자격증명 미노출)
> 2. `scripts/generate-schema.sh` — 출력된 스키마를 프롬프트에 주입해 LLM 호출
> 3. LLM이 `index.md` / `collection-mapping.md` (SQL DB는 `table-mapping.md`) 생성

---

## 지원 조합 현황

| | MongoDB | MySQL | PostgreSQL | Oracle | MSSQL |
|---|:---:|:---:|:---:|:---:|:---:|
| **Claude** | ✅ | 🔜 | 🔜 | 🔜 | 🔜 |
| **Gemini** | 🔜 | 🔜 | 🔜 | 🔜 | 🔜 |
| **Codex**  | 🔜 | 🔜 | 🔜 | 🔜 | 🔜 |

✅ 사용 가능 · 🔜 준비 중

---

## 생성된 프로젝트 구조 (claude-mongodb 기준)

```
my-app/
├── server.ts                  # Express 서버 + LLM spawn 로직
├── public/
│   └── index.html             # 채팅 UI (단일 파일, 빌드 없음)
├── scripts/
│   ├── extract-schema.ts      # DB 접속 → 스키마 추출 (자격증명 LLM 미노출)
│   ├── generate-schema-prompt.md  # LLM에게 전달할 인덱스 생성 프롬프트
│   └── generate-schema.sh     # schema 추출 → LLM 호출 → 파일 생성 오케스트레이터
├── collections/               # 컬렉션별 필드 스키마 마크다운
├── index.md                   # 전체 컬렉션 목록 (npm run schema로 자동 생성)
├── collection-mapping.md      # 자연어 ↔ 컬렉션명 매핑 (npm run schema로 자동 생성)
├── docker/
│   └── docker-compose.yml     # 로컬 DB 컨테이너
├── .env.example               # 환경변수 템플릿
└── package.json
```

### 주요 API 엔드포인트

| 엔드포인트 | 설명 |
|-----------|------|
| `POST /chat` | LLM spawn, SSE 스트림으로 응답 |
| `POST /chat/cancel` | 진행 중인 LLM 프로세스 중단 |
| `POST /db-query` | 단순 조회 (LLM이 curl로 호출) |
| `POST /db-aggregate` | 집계·조인 쿼리 (LLM이 curl로 호출) |
| `POST /db-export` | 엑셀 내보내기용 전체 조회 |
| `GET /meta` | 컬렉션 인덱스 최종 업데이트 시각 |
| `GET /meta/table-info` | 컬렉션 목록 마크다운 (UI 모달용) |

---

## 환경변수 (.env)

| 변수명 | 설명 | 기본값 |
|--------|------|--------|
| `PORT` | 서버 포트 | `3111` |
| `DB_HOST` | DB 호스트 | — |
| `DB_PORT` | DB 포트 | `27017` |
| `DB_DATABASE` | 데이터베이스명 | — |
| `DB_USER_NAME` | DB 계정명 | — |
| `DB_USER_PASSWORD` | DB 비밀번호 | — |
| `CLAUDE_MODEL` | 사용할 Claude 모델 | `claude-haiku-4-5-20251001` |
| `CLAUDE_MAX_TURNS` | Claude 최대 턴 수 | `10` |
| `COLLECTION_MAPPING_FILE` | 매핑 파일 경로 | `./collection-mapping.md` |

---

## 컬렉션 정보 설정

LLM이 어떤 컬렉션(테이블)을 어떤 키워드로 찾아야 하는지 알려주는 파일입니다.

### 자동 생성 (권장)

```bash
npm run schema
```

DB에 실제 접속해 컬렉션 목록·건수·필드를 추출한 뒤 LLM이 `index.md`와 `collection-mapping.md`를 자동으로 작성합니다. DB 접속 정보는 LLM에 노출되지 않습니다.

### 수동 편집

자동 생성 후 내용을 직접 수정하거나, 아래 형식에 맞게 처음부터 작성할 수 있습니다.

생성된 프로젝트에서 `index.md`와 `collection-mapping.md`를 편집해 LLM이 어떤 컬렉션(테이블)을 어떤 키워드로 찾아야 하는지 알려줍니다.

**index.md** — 컬렉션 목록 요약 (UI 모달 + 시스템 프롬프트 삽입용)

```markdown
# 컬렉션 인덱스
> **database**: `mydb` — 3개 컬렉션
> 최종 업데이트: 2025-01-01

## 컬렉션 목록

| 컬렉션명 | 한글 설명 |
|---------|---------|
| `users` | 사용자 (1,200건) |
| `orders` | 주문 (45,000건) |
| `products` | 상품 (800건) |
```

**collection-mapping.md** — 자연어 키워드 매핑 (LLM이 컬렉션 선택에 활용)

```markdown
# 컬렉션 자연어 매핑

| 컬렉션명 | 자연어 키워드 | 주요 필드 | 설명 |
|---------|-------------|---------|------|
| `users` | 사용자, 유저, 회원 | `name`, `email`, `createdAt` | 가입 사용자 |
| `orders` | 주문, 구매, 결제 | `userId`, `amount`, `status` | 주문 내역 |
```

개별 필드 상세 정보가 필요하면 `collections/<컬렉션명>.md`를 추가하면 LLM이 자동으로 읽습니다.

---

## 로컬 MongoDB 사용 시

도커가 설치되어 있다면 아래 명령어로 로컬 MongoDB를 바로 띄울 수 있습니다.

```bash
docker compose -f docker/docker-compose.yml up -d
```

`.env`의 DB 접속 정보를 `docker-compose.yml`의 값과 맞추면 됩니다.

---

## 레퍼런스 문서 구조

새 템플릿을 만들 때 참고하는 구성 요소 문서 폴더입니다.  
LLM 제공자와 데이터베이스 각각의 구현 방법을 분리해 정리해두고, 이를 조합해 `templates/<llm>-<db>/`를 완성합니다.

```
1.llm_provider/          ← LLM별 연동 방법 문서
├── claude/
├── gemini/
└── codex/

2.database/              ← DB별 연동 방법 문서
├── MongoDB/
├── MySQL/
├── PostgreSQL/
├── Oracle Database/
└── Microsoft SQL Server/
```

### 1.llm_provider/\<name\>/

각 LLM 제공자 폴더에는 해당 LLM을 서버에서 호출하는 방법을 기록합니다.

| 파일 | 내용 |
|------|------|
| `README.md` | 제공자 개요, 공식 문서 링크, 사전 설치 요건 |
| `spawn.md` | 서버에서 LLM을 subprocess로 실행하는 방법 (CLI 명령어, 인수, stream 수신 방식) |
| `system-prompt.md` | DB 조회 어시스턴트용 시스템 프롬프트 작성 가이드 |
| `env.md` | 필요한 환경변수 목록 및 설명 (API 키, 모델명, 최대 턴 수 등) |
| `models.md` | 사용 가능한 모델 목록과 속도·비용·품질 비교 |

**예시 — `1.llm_provider/claude/spawn.md`**

```markdown
## Claude CLI spawn 방법

서버에서 claude CLI를 subprocess로 실행한다.

\`\`\`javascript
spawn('claude', [
  '-p', userMessage,
  '--allowedTools', 'Bash',
  '--system-prompt', systemPrompt,
  '--output-format', 'stream-json',
  '--verbose',
  '--max-turns', '10',
  '--model', 'claude-haiku-4-5-20251001',
])
\`\`\`

출력: NDJSON 스트림. 각 줄을 JSON.parse해 type 필드로 분기 처리.
- `system` → 세션 시작
- `assistant` → LLM 응답 / 도구 호출
- `user` → 도구 실행 결과
- `result` → 최종 응답 및 비용
```

---

### 2.database/\<name\>/

각 데이터베이스 폴더에는 해당 DB에 연결하고 쿼리하는 방법을 기록합니다.

| 파일 | 내용 |
|------|------|
| `README.md` | DB 개요, 드라이버/라이브러리, 공식 문서 링크 |
| `connection.md` | 커넥션 풀 설정 방법 (URI 형식, 인증, 최대 연결 수) |
| `query.md` | `/db-query` 엔드포인트 구현 방법 (단순 조회, 필터, 정렬, 페이지네이션) |
| `aggregate.md` | `/db-aggregate` 엔드포인트 구현 방법 (조인, 집계, 서브쿼리) |
| `docker-compose.yml` | 로컬 개발용 DB 컨테이너 설정 |
| `env.md` | 필요한 환경변수 목록 (호스트, 포트, 계정, 비밀번호 등) |
| `type-conversion.md` | LLM이 전달하는 JSON 값을 DB 타입으로 변환하는 규칙 (ObjectId, Date, Decimal 등) |

**예시 — `2.database/MongoDB/connection.md`**

```markdown
## MongoDB 커넥션 풀

드라이버: `mongodb` (Node.js 공식 드라이버)

\`\`\`typescript
import { MongoClient } from 'mongodb';

const uri = `mongodb://${USER}:${PASS}@${HOST}:${PORT}/${DB}?authSource=admin`;
const client = new MongoClient(uri, { maxPoolSize: 5 });
await client.connect();
\`\`\`

- `maxPoolSize: 5` — 동시 요청 수에 맞게 조정
- 서버 종료 시 `client.close()` 호출 필요
- 쿼리 타임아웃: `maxTimeMS: 30000` 옵션으로 강제 설정
```

---

### 폴더 구조와 템플릿의 관계

```
1.llm_provider/claude/     ─┐
                             ├─ 조합 → templates/claude-mongodb/
2.database/MongoDB/        ─┘
```

새 조합을 추가할 때는 각 폴더의 문서를 참고해 `server.ts`의 LLM 호출부와 DB 연동부를 작성합니다.

---

## 새 조합 템플릿 추가 (기여)

1. `1.llm_provider/<llm>/`과 `2.database/<db>/` 문서를 참고해 구현 방법을 파악합니다.
2. `templates/<llm>-<db>/` 폴더를 생성하고 필요한 파일을 작성합니다.
3. `src/index.ts`의 `AVAILABLE_COMBOS`에 `'<llm>-<db>'`를 추가합니다.
4. `npm run build`로 재빌드합니다.

```typescript
// src/index.ts
const AVAILABLE_COMBOS = new Set([
  'claude-mongodb',
  'claude-mysql',   // 추가 예시
]);
```

---

## 라이선스

MIT
