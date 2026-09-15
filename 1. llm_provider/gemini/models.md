# Gemini 모델

`--model` 인자 또는 `GEMINI_MODEL` 환경 변수로 지정하는 모델 ID입니다.

> **상태**: 템플릿 미구현. 아래 기본값 후보는 첫 구현 시점에 실제 CLI가 지원하는 ID로 확정하세요.

## 지원 모델 (구현 시 확정)

Gemini CLI는 릴리스마다 지원 모델 세트가 바뀝니다. `gemini --help`로 현재 CLI 버전이 지원하는 모델 ID를 확인하고 사용하세요.

일반적으로 두 티어를 선택지로 둡니다:

| 용도 | 계열 | 특징 |
| --- | --- | --- |
| **기본 (빠름·저비용)** | Flash 계열 | 대부분의 DB 조회 시나리오에 충분. 짧은 지연·낮은 비용. |
| **고품질** | Pro 계열 | 복잡한 조인·집계, 애매한 자연어 라우팅. Flash 대비 지연 증가. |

구현 시 코드 폴백은 Flash 계열 최신 ID로 설정하세요:

```ts
const GEMINI_MODEL: string = process.env.GEMINI_MODEL?.trim() || '<gemini-flash-*>';
```

## 선택 기준

- **Flash 계열을 기본으로.** 스키마와 규칙이 시스템 프롬프트에 잘 정리돼 있으면 Flash로 충분합니다. 사내 툴 특성상 응답 속도가 UX에 직접 영향을 줍니다.
- **Pro는 케이스별 오버라이드.** `.env`의 `GEMINI_MODEL`만 바꿔 선택적으로 사용하세요. 코드 수정은 필요 없습니다.

## 오버라이드 방법

`.env`:

```
GEMINI_MODEL=<사용할 모델 ID>
```

또는 셸에서 임시로:

```
GEMINI_MODEL=<id> npm start
```

## 모델 ID 갱신 정책

- 새 CLI 릴리스에 맞춰 기본값을 올릴 때는 각 `gemini-<db>/server.ts`의 폴백 값과 `.env.example` 주석을 함께 갱신하세요. 이 문서의 기본값도 잊지 말고 갱신합니다.
- 사용자가 `.env`에 명시적으로 값을 넣은 경우가 많으므로, 기본값만 바꾸는 것은 파괴적이지 않습니다.

## 참고

- 모델 카드: <https://ai.google.dev/gemini-api/docs/models>
- Gemini CLI 릴리스 노트: <https://github.com/google-gemini/gemini-cli/releases>
- 자매 문서: [`../claude/models.md`](../claude/models.md), [`../codex/models.md`](../codex/models.md)
