# `agy` CLI Spawn

서버가 Antigravity CLI(`agy`)를 자식 프로세스로 실행하는 방식과, 응답을 SSE로 중계하는 규약을 정리합니다. 배경은 [`AGY_MIGRATION.md`](../../AGY_MIGRATION.md) 참조.

## 왜 CLI를 스폰하는가

- **구독 인증 재사용.** Antigravity IDE 로그인으로 keyring에 저장된 토큰을 `agy`가 그대로 사용하므로 서버 코드에 API 키가 필요 없습니다.
- **툴/셸 실행 위임.** `agy`가 자체적으로 `curl`을 반복 실행하고 결과를 다시 프롬프트로 되먹이도록 두고, 서버는 스트림 이벤트를 SSE로 중계만 합니다.

## 실행 인자 (`agy --help` v1.2.5 기준)

| 목적 | `agy` 인자 | 비고 |
| --- | --- | --- |
| 원샷 프롬프트 실행 | `-p, --print` | 프롬프트는 마지막 positional 인자로 전달 |
| 이벤트 스트림 | `--output-format stream-json` | NDJSON 이벤트 스트림 (Claude 스타일 파싱 가능) |
| 툴 권한 자동 승인 | `--dangerously-skip-permissions` | **헤드리스에서는 필수** — 없으면 승인 프롬프트 불가로 자동 거부됨 |
| 모델 지정 | `--model <id>` | `agy models`로 목록 확인 ([models.md](./models.md)) |
| 추론 강도 | `--effort low\|medium\|high` | 모델별 지원 여부 상이 |
| 타임아웃 | `--print-timeout <duration>` | 기본 `5m0s` |
| 대화 이어가기 | `-c, --continue` / `--conversation <id>` | 서버는 사용하지 않음 (매 요청 신규) |
| 시스템 프롬프트 | (없음) | **프롬프트 앞에 인라인** (Codex 스타일) — [system-prompt.md](./system-prompt.md) 참고 |
| 최대 턴 수 | (없음) | 프롬프트 규칙 블록에서 "결과 나오면 즉시 응답" 명시로 통제 |
| 툴 화이트리스트 | (개별 제한 없음) | `--dangerously-skip-permissions`는 전부 허용/거부 이분법 |

## Spawn 뼈대 (Claude 스타일 · stream-json 파싱)

```ts
import { spawn, type ChildProcess } from 'node:child_process';

const child: ChildProcess = spawn('agy', [
  '-p', buildGeminiPrompt(message.trim(), requestId, limit),
  '--output-format', 'stream-json',
  '--model', GEMINI_MODEL,
  '--dangerously-skip-permissions',
  '--print-timeout', GEMINI_PRINT_TIMEOUT,
], { stdio: ['ignore', 'pipe', 'pipe'] });
```

`buildGeminiPrompt`는 [system-prompt.md](./system-prompt.md)의 인라인 방식을 사용합니다.

stdout 을 개행으로 버퍼링해 NDJSON 이벤트를 파싱하고 SSE로 중계 — [Claude spawn.md](../claude/spawn.md#이벤트-스트림-파싱)의 코드 재사용.

## SSE 프로토콜

Claude/Codex 템플릿과 동일한 5종 이벤트를 프런트엔드에 전송합니다: `progress` / `log` / `result` / `error` / `cancelled`. 종료 시 `data: [DONE]` 마커. 이 계약은 변경 금지입니다.

```ts
const send: SendFn = (type, msg) =>
  res.write(`data: ${JSON.stringify({ type, message: msg })}\n\n`);
```

## 취소 처리

`Map<requestId, ChildProcess>`에 프로세스를 등록해 두고 `POST /chat/cancel`에서 `child.kill()`. Claude/Codex 코드를 그대로 복제하세요.

## 오류 처리

- `child.on('error', err)` — CLI 미설치 시 `err.code === 'ENOENT'`로 감지해 `"Antigravity CLI(agy)가 설치되어 있지 않습니다. brew install --cask antigravity-cli 후 재시도하세요."` 반환.
- `stderr` 누적 후 실패 시 앞 200자를 클라이언트에 전달.
- 헤드리스에서 도구 승인 관련 오류(`jetski: no output produced — a tool required the "command" permission…`)가 뜨면 `--dangerously-skip-permissions` 누락. 이 플래그를 항상 포함하세요.

## 새 DB 조합 템플릿 만들 때 체크리스트

1. Claude 템플릿의 `server.ts`를 복제해 spawn 대상을 `gemini` → `agy`로 교체.
2. 위 [실행 인자] 표대로 인자 세팅 (`stream-json`, `--dangerously-skip-permissions` 필수).
3. `buildSystemPrompt` → 인라인 방식으로 프롬프트 앞에 결합 ([system-prompt.md](./system-prompt.md)).
4. 해당 DB(SQL/NoSQL)에 맞춰 스키마 요약·엔드포인트 규칙 재작성.
5. `activeJobs` 취소 로직과 SSE 프로토콜은 그대로 유지.
