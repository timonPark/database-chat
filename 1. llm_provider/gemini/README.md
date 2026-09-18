# Gemini — LLM Provider 레퍼런스

`create-database-chat` 스캐폴딩이 생성할 Gemini 기반 템플릿(`gemini-mongodb`, `gemini-mysql`, `gemini-postgresql`, `gemini-oracle`, `gemini-mssql`)이 **Antigravity CLI(`agy`)** 를 어떻게 사용할지 기술한 참조 문서 세트입니다.

> **상태**: `gemini-<db>` 템플릿은 아직 미구현(placeholder). 이 문서는 첫 구현 시 따라야 할 규약이며, `agy --help` 및 실제 호출 검증 기반으로 확정된 인자·모델 정보를 담고 있습니다.

## 배경: 왜 `gemini` CLI가 아니라 `agy`인가

Google이 개인 계정(Pro 포함)의 `@google/gemini-cli` 사용을 정책적으로 차단(`IneligibleTierError`)했고, 구독 기반 헤드리스 호출은 **Antigravity CLI(`agy`)** 로만 가능합니다. 이관 배경·설정 방법은 저장소 루트 [`AGY_MIGRATION.md`](../../AGY_MIGRATION.md)에 정리돼 있습니다.

## 핵심 원칙

- **인증은 `agy` CLI에 위임한다.** 서버 코드에는 API 키가 들어가지 않습니다. Antigravity IDE에서 Google 계정으로 로그인해 발급된 keyring 토큰을 그대로 사용하며, 서버는 `child_process.spawn('agy', ...)`로 CLI를 실행합니다.
- **LLM은 직접 DB에 접근하지 않는다.** `agy`가 셸/툴 실행 권한으로 `curl`을 반복 실행해 서버의 내부 엔드포인트(`/db-query`, `/db-aggregate`)를 호출합니다. DB 자격증명은 서버에만 존재합니다.
- **SSE 프로토콜은 Claude/Codex 템플릿과 동일하게 유지한다.** 프런트엔드가 `progress` / `log` / `result` / `error` / `cancelled` 5종 이벤트와 `[DONE]` 마커를 전제로 하므로 이 계약을 지켜야 합니다.

## 네이밍 정책

- **템플릿 폴더 / 조합명 / 사용자 노출 문구**: `gemini-*` 유지
  - 이유: 사용자 관점에서 사용하는 모델은 Gemini 계열이고, `agy`는 내부 실행 도구일 뿐
- **내부 spawn 타겟**: `agy` (`spawn.md` 참고)
- **`.env` 변수 접두어**: `GEMINI_*` 유지 (모델 지정 등 의미상 Gemini)

## 자매 문서와의 관계

Gemini 템플릿은 구조적으로 Claude 템플릿을 기준으로 삼습니다:

- `agy`는 `--output-format stream-json` 을 지원하므로 **Claude 스타일(스트림 파싱 후 SSE 중계)** 을 선택합니다.
- 시스템 프롬프트 주입은 `agy`에 별도 플래그가 없으므로 **Codex 스타일(프롬프트 앞에 인라인)** 을 선택합니다.

## 문서 구성

| 파일 | 내용 |
| --- | --- |
| [`spawn.md`](./spawn.md) | `agy` 프로세스 실행 인자·이벤트 수집·취소 처리 |
| [`system-prompt.md`](./system-prompt.md) | 시스템 프롬프트 구조와 DB별 커스터마이즈 지점 |
| [`models.md`](./models.md) | 지원 모델 ID와 선택 기준 |
| [`env.md`](./env.md) | `.env` 변수와 기본값 |

## 참고 링크

- Antigravity: <https://antigravity.google>
- 이관 배경·설정: [`AGY_MIGRATION.md`](../../AGY_MIGRATION.md)
- 자매 문서: [`../claude/README.md`](../claude/README.md), [`../codex/README.md`](../codex/README.md)
