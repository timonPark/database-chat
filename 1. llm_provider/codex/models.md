# Codex 모델

`--model` 인자 또는 `CODEX_MODEL` 환경 변수로 지정하는 모델 ID입니다.

## 기준 구현 기본값

기준 구현: `templates/codex-mongodb/server.ts:18`

```ts
const CODEX_MODEL: string = process.env.CODEX_MODEL?.trim() || 'gpt-5.6-luna';
```

`.env.example`도 동일 값을 씁니다:

```
CODEX_MODEL=gpt-5.6-luna
```

## 선택 기준

- **기본값 유지를 권장.** Codex CLI가 자체적으로 지원하는 모델 세트가 릴리스마다 달라지므로, `codex --help`로 현재 CLI 버전에서 유효한 모델 ID를 확인하고 사용하세요. 서버 코드는 문자열을 그대로 전달할 뿐 검증하지 않습니다.
- **오버라이드는 `.env`에서만.** 코드 수정 없이 `CODEX_MODEL=<id>`로 바꿀 수 있습니다. 사용자별 실험에 유리합니다.
- **응답 지연이 UX에 직접 영향.** DB 조회 앱 특성상 짧은 지연이 중요하므로, "reasoning" 계열이나 대형 모델은 필요할 때만 임시로 사용하세요.

## 오버라이드 방법

`.env`:

```
CODEX_MODEL=<사용할 모델 ID>
```

또는 셸에서 임시로:

```
CODEX_MODEL=<id> npm start
```

## 모델 ID 갱신 정책

- 새 CLI 릴리스에 맞춰 기본값을 올릴 때는 각 `codex-<db>/server.ts`의 폴백 값과 `.env.example` 주석을 함께 갱신하세요. 이 문서의 기본값도 잊지 말고 갱신합니다.
- 사용자가 `.env`에 명시적으로 값을 넣은 경우가 많으므로, 기본값만 바꾸는 것은 파괴적이지 않습니다.

## 참고

- Codex CLI 릴리스 노트: <https://github.com/openai/codex/releases>
- 자매 문서: [`../claude/models.md`](../claude/models.md)
