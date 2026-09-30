# gemini-mysql

Antigravity CLI(`agy`) 구독 계정으로 MySQL을 조회하는 자연어 채팅 서버 템플릿입니다.
Google이 개인 계정의 `@google/gemini-cli` 헤드리스 호출을 차단해서(`IneligibleTierError`)
Gemini provider는 `agy` CLI만 지원합니다. 배경은 저장소 루트 `AGY_MIGRATION.md` 참고.

## 사전 준비

1. **Antigravity 설치 & 로그인** — `agy`가 keyring에 저장된 구독 토큰을 사용합니다.
   ```bash
   brew install --cask antigravity-cli
   $(brew --prefix)/Caskroom/antigravity-cli/*/antigravity install
   ```
   설치 후 `/Applications/Antigravity.app` 실행 → Google 계정 로그인.
2. **동작 확인**:
   ```bash
   agy -p "hello" --dangerously-skip-permissions
   ```
   응답이 나오면 준비 완료. `ENOENT` 또는 승인 관련 오류가 뜨면
   [`1. llm_provider/gemini/env.md`](../../1.%20llm_provider/gemini/env.md) 트러블슈팅 참고.

> 로컬 개발기 전용입니다. 서버 배포는 Vertex AI/AI Studio API 키가 필요하며 이 템플릿 범위 밖.

## 환경변수

`.env.example`을 `.env`로 복사한 뒤 값을 채워주세요.

| 변수 | 필수 | 기본값 | 설명 |
| --- | --- | --- | --- |
| `DB_HOST` / `DB_PORT` / `DB_DATABASE` / `DB_USER_NAME` / `DB_USER_PASSWORD` | 예 | — | MySQL 접속 정보 |
| `GEMINI_MODEL` | 아니오 | `gemini-3.8-flash-medium` | `agy models`로 목록 확인 |
| `GEMINI_PRINT_TIMEOUT` | 아니오 | `5m` | `agy --print-timeout` 값 |
| `AGY_CLI_PATH` | 아니오 | — | PATH에 `agy`가 없을 때만 절대경로 지정 |

**API 키 변수는 사용하지 않습니다.** 인증은 Antigravity 로그인 세션(keyring)을 재사용합니다.

## 실행

```bash
npm install
npm run schema
npm start
```

서버는 `http://localhost:3111`에서 실행됩니다.
