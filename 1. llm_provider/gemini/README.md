# Gemini — LLM Provider 레퍼런스

`create-database-chat` 스캐폴딩이 생성할 Gemini 기반 템플릿(`gemini-mongodb`, `gemini-mysql`, `gemini-postgresql`, `gemini-oracle`, `gemini-mssql`)이 Google Gemini CLI를 어떻게 사용할지 기술한 참조 문서 세트입니다.

> **상태**: 템플릿 자체는 아직 placeholder 상태(`templates/gemini-mongodb/README.md` 참조). 이 문서는 실제 템플릿을 구현할 때 따라야 할 규약을 미리 확정해 둔 것입니다. 첫 구현이 완료되면 이 문서의 예시 코드도 그 구현에 맞춰 정합성 검증을 다시 수행하세요.

## 핵심 원칙

- **인증은 Gemini CLI에 위임한다.** 서버 코드에는 API 키가 들어가지 않습니다. 사용자의 Google 계정으로 로컬 `gemini` CLI에 로그인된 세션을 전제로 하며, 서버는 `child_process.spawn('gemini', ...)`로 CLI를 실행합니다.
- **LLM은 직접 DB에 접근하지 않는다.** Gemini가 셸/툴 실행 권한으로 `curl`을 반복 실행해 서버의 내부 엔드포인트(`/db-query`, `/db-aggregate`)를 호출합니다. DB 자격증명은 서버에만 존재합니다.
- **SSE 프로토콜은 Claude/Codex 템플릿과 동일하게 유지한다.** 프런트엔드가 `progress` / `log` / `result` / `error` / `cancelled` 5종 이벤트와 `[DONE]` 마커를 전제로 하므로 이 계약을 지켜야 합니다.

## 자매 문서와의 관계

Gemini 템플릿은 구조적으로 Claude 템플릿을 기준으로 삼고, CLI별 특이사항은 Codex 문서의 접근을 참고해 정리합니다:

- 스트리밍 이벤트가 있으면 → Claude 스타일(파싱 후 SSE 중계)
- 스트리밍이 없고 최종 응답만 얻는 방식이면 → Codex 스타일(파일 또는 stdout 마지막 값 사용)

첫 gemini 구현자가 위 두 스타일 중 하나를 선택해서 [`spawn.md`](./spawn.md)의 예시 코드를 확정하세요.

## 문서 구성

| 파일 | 내용 |
| --- | --- |
| [`spawn.md`](./spawn.md) | Gemini CLI 프로세스 실행 인자·이벤트 수집·취소 처리 |
| [`system-prompt.md`](./system-prompt.md) | 시스템 프롬프트 구조와 DB별 커스터마이즈 지점 |
| [`models.md`](./models.md) | 지원 모델 ID와 선택 기준 |
| [`env.md`](./env.md) | `.env` 변수와 기본값 |

## 참고 링크

- Gemini CLI: <https://github.com/google-gemini/gemini-cli>
- 자매 문서: [`../claude/README.md`](../claude/README.md), [`../codex/README.md`](../codex/README.md)
