# Gemini 환경 변수

`gemini-<db>` 템플릿이 사용할 Gemini 관련 환경 변수입니다. DB 접속 변수(`DB_*`)는 각 DB 문서를 참고하세요.

> **상태**: 템플릿 미구현. 아래 규격은 Claude/Codex 문서와 일관되도록 미리 확정한 것입니다.

## 변수 목록

| 변수 | 필수 | 기본값 | 설명 |
| --- | --- | --- | --- |
| `GEMINI_MODEL` | 아니오 | Flash 계열 최신 ID (구현 시 확정) | `--model` 인자로 전달할 모델 ID. [models.md](./models.md) 참고. |
| `GEMINI_MAX_TURNS` | 아니오 | `10` | CLI에 유사 인자가 있으면 매핑. 없으면 이 변수 자체를 생략. |
| `GEMINI_CLI_PATH` | 아니오 | — | Gemini CLI 절대경로. PATH에 `gemini`가 없을 때만 지정. |

**API 키 변수는 없습니다.** 인증은 로컬 `gemini` CLI에 로그인된 Google 계정 세션이 담당합니다. `GEMINI_API_KEY` 유형의 환경 변수는 추가하지 마세요.

## `.env.example` 표준 (템플릿 생성 시 사용)

```
# Gemini 모델
GEMINI_MODEL=<구현 시 확정: 예 gemini-2.x-flash>

# Gemini 최대 턴 수 (CLI가 지원하는 경우만)
GEMINI_MAX_TURNS=10

# Gemini CLI 경로 (PATH에 gemini가 없을 때)
# GEMINI_CLI_PATH=/absolute/path/to/gemini
```

## 서버 코드에서의 로딩 (구현 시 확정)

```ts
const GEMINI_MODEL: string     = process.env.GEMINI_MODEL?.trim() || '<gemini-flash-*>';
const GEMINI_MAX_TURNS: string = process.env.GEMINI_MAX_TURNS ?? '10';
```

CLI 경로 폴백이 필요하면 Codex 템플릿의 `resolveCodexCli()` 패턴을 그대로 따르세요 — 후보 배열 순회하며 `--version`이 성공하는 첫 항목 사용.

## 인증 관련 트러블슈팅 (템플릿 생성 후 검증)

`Gemini 프로세스 실행 실패` 또는 `ENOENT`가 뜨는 경우:

1. `which gemini` — CLI 설치 여부 확인. 실패하면 `GEMINI_CLI_PATH`에 절대경로 지정.
2. Gemini CLI 로그인 절차 실행 (Google 계정 OAuth).
3. `gemini -p "hello"`(또는 CLI가 제공하는 원샷 실행 형식) — 로그인 상태에서 응답이 나오는지 확인.

이 3단계가 통과되면 서버는 별도 인증 설정 없이 곧바로 동작해야 합니다.

## 관련 문서

- [spawn.md](./spawn.md) — 이 변수들이 실제로 CLI 인자로 어떻게 매핑되는지
- [models.md](./models.md) — `GEMINI_MODEL`에 넣을 수 있는 값
