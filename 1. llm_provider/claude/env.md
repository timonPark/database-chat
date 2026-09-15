# Claude 환경 변수

`claude-<db>` 템플릿이 사용하는 Claude 관련 환경 변수입니다. DB 접속 변수(`DB_*`)는 각 DB 문서를 참고하세요.

## 변수 목록

| 변수 | 필수 | 기본값 | 설명 |
| --- | --- | --- | --- |
| `CLAUDE_MODEL` | 아니오 | `claude-haiku-4-5-20251001` | `--model` 인자로 전달할 모델 ID. [models.md](./models.md) 참고. |
| `CLAUDE_MAX_TURNS` | 아니오 | `10` | `--max-turns` 인자. Bash 호출·응답 사이클 상한. |

**API 키 변수는 없습니다.** 인증은 로컬 `claude` CLI에 로그인된 Claude 구독 세션이 담당합니다 (`claude` 명령을 한 번 실행해 OAuth 로그인 완료 상태 전제).

## `.env.example` 표준

```
# Claude 모델 (기본값: claude-haiku-4-5-20251001 / 고품질: claude-sonnet-4-6)
CLAUDE_MODEL=claude-haiku-4-5-20251001

# Claude 최대 턴 수 (기본값: 10)
CLAUDE_MAX_TURNS=10
```

기준 구현: [`templates/claude-mongodb/.env.example`](../../templates/claude-mongodb/.env.example).

## 서버 코드에서의 로딩

`templates/claude-mongodb/server.ts:18`

```ts
const CLAUDE_MODEL: string    = process.env.CLAUDE_MODEL ?? 'claude-haiku-4-5-20251001';
const CLAUDE_MAX_TURNS: string = process.env.CLAUDE_MAX_TURNS ?? '10';
```

두 변수 모두 옵션이며, 미설정 시 코드 내 기본값이 적용됩니다. `DB_*` 변수와 달리 부재 시 서버가 중단되지 않습니다.

## `CLAUDE_MAX_TURNS` 튜닝 가이드

한 턴은 "Claude 응답 1회 + 그 응답 안의 툴 호출들"에 해당합니다. 값이 너무 낮으면 복잡한 조인 쿼리 중간에 잘리고, 너무 높으면 무한 루프 시 비용이 커집니다.

- **기본 10**: 단일 쿼리 → 결과 확인 → 응답 흐름을 3~5턴 여유로 커버합니다.
- **집계·조인 위주 워크로드**: 15 정도까지 올려도 무방합니다.
- **비용 방어**: 절대 30을 넘기지 마세요. 그 이상 필요하다면 대개 시스템 프롬프트의 스키마 안내가 부족한 것입니다.

## 인증 관련 트러블슈팅

`Claude 프로세스 실행 실패` 또는 `ENOENT`가 뜨는 경우:

1. `which claude` — CLI 설치 여부 확인.
2. `claude` (인자 없이) — 브라우저 OAuth로 로그인.
3. `claude -p "hello"` — 로그인 상태에서 원샷 응답이 나오는지 확인.

이 3단계가 통과되면 서버는 별도 인증 설정 없이 곧바로 동작합니다.

## 관련 문서

- [spawn.md](./spawn.md) — 이 변수들이 실제로 CLI 인자로 어떻게 매핑되는지
- [models.md](./models.md) — `CLAUDE_MODEL`에 넣을 수 있는 값
