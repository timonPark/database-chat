# Gemini 모델

`--model` 인자 또는 `GEMINI_MODEL` 환경 변수로 지정하는 모델 ID입니다. 실제 목록은 `agy models`로 확인하세요.

## 지원 모델 (`agy models` v1.2.5 기준)

| 모델 ID | 이름 | 티어 |
| --- | --- | --- |
| `gemini-3.8-flash-high` | Gemini 3.8 Flash (High) | Flash |
| `gemini-3.8-flash-medium` | Gemini 3.8 Flash (Medium) | Flash (**기본값 권장**) |
| `gemini-3.8-flash-low` | Gemini 3.8 Flash (Low) | Flash |
| `gemini-3.7-flash-*` | Gemini 3.7 Flash (High/Medium/Low) | Flash |
| `gemini-3.6-flash-*` | Gemini 3.6 Flash (High/Medium/Low) | Flash |
| `gemini-3.1-pro-high` | Gemini 3.1 Pro (High) | Pro |
| `gemini-3.1-pro-low` | Gemini 3.1 Pro (Low) | Pro |

> `agy`는 Antigravity 카탈로그에 따라 Claude/GPT-OSS 등 다른 벤더 모델도 노출할 수 있으나, 이 provider 문서는 **Gemini 계열만** 사용합니다.

접미어 `-high` / `-medium` / `-low`는 추론 강도(reasoning effort) 프리셋입니다. `--effort` 플래그로 별도 지정할 수도 있습니다.

## 선택 기준

| 용도 | 추천 |
| --- | --- |
| **기본 (빠름·저비용)** | `gemini-3.8-flash-medium` |
| **더 빠르게** | `gemini-3.8-flash-low` |
| **정확도 우선** | `gemini-3.1-pro-high` |

- Flash 계열을 기본으로. 스키마·규칙이 시스템 프롬프트에 잘 정리돼 있으면 Flash로 충분합니다.
- Pro는 케이스별 오버라이드. `.env`의 `GEMINI_MODEL`만 바꿔 선택적으로 사용하세요.

서버 코드 폴백:

```ts
const GEMINI_MODEL: string = process.env.GEMINI_MODEL?.trim() || 'gemini-3.8-flash-medium';
```

## 오버라이드 방법

`.env`:

```
GEMINI_MODEL=gemini-3.1-pro-high
```

또는 셸에서 임시로:

```
GEMINI_MODEL=gemini-3.1-pro-high npm start
```

## 모델 ID 갱신 정책

- `agy`가 새 모델을 노출하면(`agy models` 결과에 새 ID 등장) 각 `gemini-<db>/server.ts`의 폴백 값과 `.env.example` 주석을 함께 갱신하세요. 이 문서의 목록도 잊지 말고 갱신합니다.
- 사용자가 `.env`에 명시적으로 값을 넣은 경우가 많으므로, 기본값만 바꾸는 것은 파괴적이지 않습니다.

## 참고

- 모델 카드: <https://ai.google.dev/gemini-api/docs/models>
- Antigravity: <https://antigravity.google>
- 자매 문서: [`../claude/models.md`](../claude/models.md), [`../codex/models.md`](../codex/models.md)
