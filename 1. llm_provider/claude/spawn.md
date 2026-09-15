# Claude CLI Spawn

서버가 Claude Code CLI를 자식 프로세스로 실행하는 방식과, 스트림 이벤트를 SSE로 중계하는 규약을 정리합니다.

## 왜 CLI를 스폰하는가

- **구독 인증 재사용.** 로컬 `claude` CLI에 로그인된 세션(구독)을 그대로 사용하므로 서버 코드에 API 키가 필요 없습니다.
- **툴 오케스트레이션 위임.** Bash 툴 반복 호출, 스트리밍 출력, 최대 턴 제한 등을 CLI가 관리합니다. 서버는 이벤트를 파싱만 하면 됩니다.

## 실행 인자

기준 구현: `templates/claude-mongodb/server.ts:643`

```ts
const child = spawn(
  'claude',
  [
    '-p', message.trim(),                                 // 사용자 메시지 (프롬프트)
    '--allowedTools', 'Bash',                             // Bash 툴만 허용 (Read/Write 등 차단)
    '--system-prompt', buildSystemPrompt(requestId, limit),
    '--output-format', 'stream-json',                     // 이벤트 스트림
    '--verbose',                                          // stream-json 필수
    '--max-turns', CLAUDE_MAX_TURNS,                      // 무한 루프 방지 (기본 10)
    '--model', CLAUDE_MODEL,                              // 모델 ID (models.md 참고)
  ],
  { stdio: ['ignore', 'pipe', 'pipe'] },
);
```

| 인자 | 목적 |
| --- | --- |
| `-p <message>` | 원샷 프롬프트 실행 (대화형 REPL 미사용) |
| `--allowedTools Bash` | curl로 내부 API만 호출하도록 툴 화이트리스트 축소 |
| `--system-prompt` | DB 스키마·규칙·엔드포인트 URL 주입 (system-prompt.md 참고) |
| `--output-format stream-json` | 이벤트 단위 JSON 라인 출력 (`--verbose`와 함께 써야 함) |
| `--max-turns` | Bash 호출·응답 사이클 상한 |
| `--model` | 모델 ID 지정 (env로 오버라이드 가능) |

`stdio: ['ignore', 'pipe', 'pipe']` — stdin은 사용하지 않고 stdout/stderr만 캡처합니다.

## 이벤트 스트림 파싱

Claude CLI는 stdout에 **JSON Lines**를 출력합니다. 한 줄이 하나의 이벤트이며, 서버는 개행 기준으로 버퍼링해서 파싱합니다.

```ts
child.stdout!.on('data', (data: Buffer) => {
  lineBuffer += data.toString();
  const lines = lineBuffer.split('\n');
  lineBuffer = lines.pop() ?? '';       // 마지막 미완성 라인은 다음 청크로 이월
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line) as ClaudeEvent;
      handleClaudeEvent(event);
      if (event.type === 'result' && event.subtype === 'success') {
        finalResult = event.result ?? '';
      }
    } catch { /* 파싱 불가 라인 무시 */ }
  }
});
```

### 이벤트 타입

| `type` | 의미 | 처리 |
| --- | --- | --- |
| `system` | 세션 시작 알림 | `progress: 준비 중...` 1회 전송 |
| `assistant` | 어시스턴트 응답 (텍스트 또는 툴 호출) | `content[]` 안의 `tool_use`/`text` 블록별로 분기 |
| `user` | 툴 실행 결과 (Bash stdout) | 필요 시 로깅 |
| `result` | 최종 응답 완료 | `subtype === 'success'`일 때 `result` 필드가 최종 답변 |

`assistant.message.content[]`의 블록 타입:

- `tool_use` — `name: 'Bash'`, `input.command`에 실행할 curl. `db-query`/`db-aggregate` 여부로 진행 문구 분기.
- `text` — 사용자에게 보낼 자연어 응답 조각.

## SSE 중계

서버는 이벤트를 `progress` / `log` / `result` / `error` / `cancelled` 5종 SSE 이벤트로 브라우저에 전달합니다:

```ts
const send = (type: SseEventType, msg: string) =>
  res.write(`data: ${JSON.stringify({ type, message: msg })}\n\n`);
```

종료 시 `data: [DONE]` 마커로 스트림을 닫습니다.

## 취소 처리

진행 중인 프로세스를 `Map<requestId, ChildProcess>`에 등록해 두고 `POST /chat/cancel`로 `child.kill()`을 호출합니다:

```ts
const activeJobs = new Map<string, ChildProcess>();
if (requestId) activeJobs.set(requestId, child);

child.on('close', (code, signal) => {
  if (requestId) activeJobs.delete(requestId);
  if (signal === 'SIGKILL' || signal === 'SIGTERM') {
    send('cancelled', '조회가 중지되었습니다.');
  } else if (code !== 0 && !finalResult) {
    send('error', 'Claude 프로세스 실행 실패: ' + stderr.slice(0, 200));
  } else {
    send('result', finalResult.trim());
  }
});
```

## 오류 처리

- `child.on('error', err)` — CLI 미설치 시 `err.code === 'ENOENT'`로 감지해 안내 문구 반환.
- `stderr` 누적 후, exit code 0이 아니고 `finalResult`도 비어 있으면 앞 200자를 클라이언트에 전달.

## 새 DB 조합 템플릿 만들 때 체크리스트

1. `spawn('claude', [...])` 호출부 재사용 — 인자·플래그를 임의로 바꾸지 않습니다.
2. `buildSystemPrompt`만 해당 DB(SQL/NoSQL)에 맞춰 재작성 ([system-prompt.md](./system-prompt.md)).
3. `activeJobs` 취소 로직과 SSE 프로토콜은 그대로 유지 — 프런트엔드가 이 형식을 전제로 합니다.
