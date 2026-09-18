# Gemini 환경 변수

`gemini-<db>` 템플릿이 사용할 Gemini 관련 환경 변수입니다. DB 접속 변수(`DB_*`)는 각 DB 문서를 참고하세요. 실행 대상 CLI는 `agy` — 배경은 [`AGY_MIGRATION.md`](../../AGY_MIGRATION.md).

## 변수 목록

| 변수 | 필수 | 기본값 | 설명 |
| --- | --- | --- | --- |
| `GEMINI_MODEL` | 아니오 | `gemini-3.8-flash-medium` | `--model` 인자로 전달할 모델 ID. [models.md](./models.md) 참고. |
| `GEMINI_PRINT_TIMEOUT` | 아니오 | `5m` | `agy --print-timeout` 값 |
| `AGY_CLI_PATH` | 아니오 | — | `agy` 절대경로. PATH에 없을 때만 지정. |

**API 키 변수는 없습니다.** 인증은 Antigravity IDE 로그인으로 keyring에 저장된 토큰을 `agy`가 재사용합니다. `GEMINI_API_KEY` 유형의 변수는 추가하지 마세요.

## `.env.example` 표준 (템플릿 생성 시 사용)

```
# Gemini 모델 (agy models 로 목록 확인)
GEMINI_MODEL=gemini-3.8-flash-medium

# agy --print-timeout 값
GEMINI_PRINT_TIMEOUT=5m

# agy CLI 경로 (PATH에 agy가 없을 때만)
# AGY_CLI_PATH=/opt/homebrew/bin/agy
```

## 서버 코드에서의 로딩

```ts
const GEMINI_MODEL: string          = process.env.GEMINI_MODEL?.trim() || 'gemini-3.8-flash-medium';
const GEMINI_PRINT_TIMEOUT: string  = process.env.GEMINI_PRINT_TIMEOUT?.trim() || '5m';
```

CLI 경로 폴백이 필요하면 Codex 템플릿의 `resolveCodexCli()` 패턴을 그대로 따르세요 — `[process.env.AGY_CLI_PATH, 'agy', '/opt/homebrew/bin/agy']` 순으로 `--version`이 성공하는 첫 항목 사용.

## 인증 관련 트러블슈팅

`agy 프로세스 실행 실패` 또는 `ENOENT`가 뜨는 경우:

1. `which agy` — CLI 설치 여부 확인. 실패하면 `brew install --cask antigravity-cli` 후 `$(brew --prefix)/Caskroom/antigravity-cli/*/antigravity install` 실행.
2. Antigravity IDE(`/Applications/Antigravity.app`) 실행 후 Google 계정 로그인 — keyring 토큰이 저장돼야 함.
3. `agy -p "hello" --dangerously-skip-permissions` — 응답이 나오는지 확인.

이 3단계가 통과되면 서버는 별도 인증 설정 없이 곧바로 동작합니다.

## 관련 문서

- [spawn.md](./spawn.md) — 이 변수들이 실제로 CLI 인자로 어떻게 매핑되는지
- [models.md](./models.md) — `GEMINI_MODEL`에 넣을 수 있는 값
- [`AGY_MIGRATION.md`](../../AGY_MIGRATION.md) — `gemini` CLI → `agy` 이관 배경
