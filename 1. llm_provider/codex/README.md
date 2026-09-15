# Codex — LLM Provider 레퍼런스

`create-database-chat` 스캐폴딩이 생성하는 Codex 기반 템플릿(`codex-mongodb`, 이후 `codex-mysql`/`codex-postgresql`/`codex-oracle`/`codex-mssql`)이 OpenAI Codex CLI를 어떻게 사용하는지 기술한 참조 문서 세트입니다.

새로운 `codex-<db>` 조합 템플릿을 만들거나 기존 템플릿을 수정할 때 이 문서를 참고하세요.

## 핵심 원칙

- **인증은 Codex CLI에 위임한다.** 서버 코드에는 API 키가 들어가지 않습니다. ChatGPT Plus/Team 구독으로 로컬 `codex` CLI에 로그인한 상태를 전제로 하며, 서버는 `child_process.spawn`으로 CLI를 실행합니다.
- **LLM은 직접 DB에 접근하지 않는다.** Codex가 셸 실행 권한(`--sandbox danger-full-access`)으로 `curl`을 실행해 서버의 내부 엔드포인트(`/db-query`, `/db-aggregate`)를 호출합니다. DB 자격증명은 서버에만 존재합니다.
- **최종 응답은 파일로 받는다.** Codex CLI는 stream-json이 없으므로 `--output-last-message <path>` 플래그로 임시 파일에 최종 응답을 쓰게 하고, `close` 이벤트에서 그 파일을 읽어 SSE로 중계합니다.

## Claude와 다른 점

Claude 문서와 비교해 이해하면 빠릅니다:

| 항목 | Claude | Codex |
| --- | --- | --- |
| 서브커맨드 | `-p <message>` | `exec <positional message>` |
| 시스템 프롬프트 | `--system-prompt` 별도 인자 | 프롬프트에 인라인으로 붙임 (`buildCodexPrompt`) |
| 실시간 이벤트 | `--output-format stream-json` | 없음 — stdout은 progress 신호로만 사용 |
| 최종 응답 | `result` 이벤트의 `result` 필드 | `--output-last-message`가 쓴 파일 |
| 툴 제한 | `--allowedTools Bash` | `--sandbox danger-full-access` (전체 셸) |
| CLI 경로 탐색 | `claude` (PATH) | `CODEX_CLI_PATH` → `codex` → `/Applications/ChatGPT.app/Contents/Resources/codex` |

## 문서 구성

| 파일 | 내용 |
| --- | --- |
| [`spawn.md`](./spawn.md) | Codex CLI 프로세스 실행 인자·CLI 경로 탐색·취소 처리 |
| [`system-prompt.md`](./system-prompt.md) | 시스템 프롬프트 인라인 구조와 DB별 커스터마이즈 지점 |
| [`models.md`](./models.md) | 지원 모델 ID와 선택 기준 |
| [`env.md`](./env.md) | `.env` 변수와 기본값 |

## 참고 링크

- Codex CLI: <https://github.com/openai/codex>
- 기준 구현: [`templates/codex-mongodb/server.ts`](../../templates/codex-mongodb/server.ts)
- 자매 문서: [`../claude/README.md`](../claude/README.md)
