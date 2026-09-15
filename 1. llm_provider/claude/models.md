# Claude 모델

`--model` 인자 또는 `CLAUDE_MODEL` 환경 변수로 지정하는 모델 ID입니다.

## 지원 모델

| 용도 | 모델 ID | 특징 |
| --- | --- | --- |
| **기본 (빠름·저비용)** | `claude-haiku-4-5-20251001` | 대부분의 DB 조회 시나리오에 충분. 응답 지연이 짧고 비용이 낮음. |
| **고품질** | `claude-sonnet-4-6` | 복잡한 조인·집계, 애매한 자연어 라우팅에서 정확도가 필요할 때. Haiku 대비 응답 지연이 길어짐. |

기준 구현의 기본값: `templates/claude-mongodb/server.ts:18`

```ts
const CLAUDE_MODEL = process.env.CLAUDE_MODEL ?? 'claude-haiku-4-5-20251001';
```

## 선택 기준

- **Haiku를 기본으로.** DB 스키마와 규칙이 시스템 프롬프트에 잘 정리돼 있으면 Haiku로 충분합니다. 반복 조회가 많은 사내 툴 성격상 응답 속도가 UX에 직접 영향을 줍니다.
- **Sonnet은 케이스별 오버라이드.** 다단 조인/집계, 도메인 용어가 많아 스키마 매핑이 어려운 경우 `.env`의 `CLAUDE_MODEL`만 바꿔 선택적으로 사용하세요. 코드 수정은 필요 없습니다.
- **Opus는 권장하지 않음.** 이 앱은 툴 호출 주도(자연어 → curl) 패턴이라 Opus 수준의 추론 예산이 필요하지 않고, 지연·비용이 UX를 해칩니다.

## 오버라이드 방법

`.env`:

```
CLAUDE_MODEL=claude-sonnet-4-6
```

또는 셸에서 임시로:

```
CLAUDE_MODEL=claude-sonnet-4-6 npm start
```

## 모델 ID 갱신 정책

- Claude 모델은 릴리스 시 새 ID가 부여됩니다 (예: Haiku 4.5 → 5.0).
- 새 ID로 업그레이드할 때는 각 `claude-<db>/server.ts`의 기본값과 `.env.example` 주석을 함께 갱신하세요. 문서에서 이 표도 잊지 말고 갱신합니다.
- 사용자가 `.env`에 명시적으로 값을 넣은 경우가 많으므로, 기본값만 바꾸는 것은 파괴적이지 않습니다.

## 참고

- 모델 카드: <https://docs.claude.com/en/docs/about-claude/models>
- Claude Code CLI에서 사용 가능한 모델: <https://docs.claude.com/en/docs/claude-code>
