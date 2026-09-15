# Codex 환경 변수

`codex-<db>` 템플릿이 사용하는 Codex 관련 환경 변수입니다. DB 접속 변수(`DB_*`)는 각 DB 문서를 참고하세요.

## 변수 목록

| 변수 | 필수 | 기본값 | 설명 |
| --- | --- | --- | --- |
| `CODEX_MODEL` | 아니오 | `gpt-5.6-luna` | `--model` 인자로 전달할 모델 ID. [models.md](./models.md) 참고. |
| `CODEX_CLI_PATH` | 아니오 | — | Codex CLI 절대경로. PATH에 `codex`가 없을 때 지정. |

**API 키 변수는 없습니다.** 인증은 로컬 `codex` CLI에 로그인된 ChatGPT 구독 세션이 담당합니다.

## `.env.example` 표준

```
# Codex 모델
CODEX_MODEL=gpt-5.6-luna

# Codex CLI 경로 (PATH에 codex가 없을 때)
CODEX_CLI_PATH=/Applications/ChatGPT.app/Contents/Resources/codex
```

기준 구현: [`templates/codex-mongodb/.env.example`](../../templates/codex-mongodb/.env.example).

## 서버 코드에서의 로딩

`templates/codex-mongodb/server.ts:18`

```ts
const CODEX_MODEL: string = process.env.CODEX_MODEL?.trim() || 'gpt-5.6-luna';
```

`CODEX_CLI_PATH`는 `resolveCodexCli()` 안에서 후보 배열의 첫 항목으로 조회됩니다 (`server.ts:220`). 세 후보(env → `codex` → `/Applications/ChatGPT.app/Contents/Resources/codex`) 중 `--version` 호출이 성공하는 첫 항목이 선택됩니다.

## `CODEX_CLI_PATH`가 필요한 이유

Codex CLI는 macOS에서 ChatGPT 데스크톱 앱 번들 안에 설치되는 경우가 많아 PATH에 노출되지 않을 수 있습니다. GUI 앱만 설치한 사용자를 위해 폴백 경로를 코드에 하드코딩해 두었고, 다른 위치에 설치했다면 이 변수로 지정합니다.

동일 로직을 다른 OS로 확장할 때는 `CODEX_CLI_PATHS` 배열에 후보를 추가하세요.

## 인증 관련 트러블슈팅

`Codex 프로세스 실행 실패` 또는 `ENOENT`가 뜨는 경우:

1. `codex --version` — PATH에서 CLI 접근 가능 여부 확인. 실패하면 `CODEX_CLI_PATH`에 절대경로 지정.
2. `codex login` (또는 GUI 앱에서 로그인) — ChatGPT 구독 세션 확보.
3. `codex exec "hello"` — 로그인 상태에서 원샷 응답이 나오는지 확인.

이 3단계가 통과되면 서버는 별도 인증 설정 없이 곧바로 동작합니다.

## 관련 문서

- [spawn.md](./spawn.md) — 이 변수들이 실제로 CLI 인자로 어떻게 매핑되는지
- [models.md](./models.md) — `CODEX_MODEL`에 넣을 수 있는 값
