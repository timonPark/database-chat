# Gemini CLI Spawn

서버가 Google Gemini CLI를 자식 프로세스로 실행하는 방식과, 응답을 SSE로 중계하는 규약을 정리합니다.

> **상태**: `gemini-<db>` 템플릿이 아직 구현되지 않았습니다. 아래 인자·플래그명은 첫 구현 시점에 실제 `gemini --help` 출력으로 검증한 뒤 확정하세요. **문서 뼈대와 SSE 계약은 그대로 유지**하는 것이 목표입니다.

## 왜 CLI를 스폰하는가

- **구독 인증 재사용.** 로컬 `gemini` CLI에 로그인된 Google 계정 세션(무료 티어 또는 유료 구독)을 그대로 사용하므로 서버 코드에 API 키가 필요 없습니다.
- **툴/셸 실행 위임.** Gemini CLI가 자체적으로 `curl`을 반복 실행하고 결과를 다시 프롬프트로 되먹이도록 두고, 서버는 최종 응답만 받아 중계합니다.

## 실행 인자 (구현 시 확정)

Claude 템플릿과 동일한 목적의 인자들이 필요합니다. Gemini CLI의 정확한 플래그명은 구현 시 확정하세요:

| 목적 | Claude 대응 인자 | Gemini에서 확인할 것 |
| --- | --- | --- |
| 원샷 프롬프트 실행 | `-p <message>` | 프롬프트를 stdin/positional/`-p` 중 어떤 방식으로 받는지 |
| 시스템 프롬프트 주입 | `--system-prompt <text>` | 별도 플래그가 있는지, 없다면 프롬프트에 인라인(Codex 방식) |
| 이벤트 스트림 | `--output-format stream-json --verbose` | JSON 이벤트 스트림 옵션 존재 여부 |
| 최종 응답 | stream-json의 `result` | 없으면 stdout 마지막 라인 또는 `--output-file` |
| 툴 제한 / 샌드박스 | `--allowedTools Bash` | 툴/YOLO/샌드박스 모드 |
| 최대 턴 수 | `--max-turns <n>` | 유사 인자 존재 여부 (없으면 프롬프트로 통제) |
| 모델 지정 | `--model <id>` | 대체로 동일 |

`spawn`의 기본 골격은 다음 두 스타일 중 하나입니다:

**A) 스트리밍 이벤트가 있을 때 (Claude 스타일)**

```ts
const child = spawn('gemini', [
  /* 프롬프트 인자 */,
  /* 시스템 프롬프트 인자 */,
  /* 모델·최대 턴·툴 제한 인자 */,
  /* stream-json 출력 옵션 */,
], { stdio: ['ignore', 'pipe', 'pipe'] });
```

stdout을 개행으로 버퍼링해 이벤트를 파싱하고 SSE로 중계 — [Claude spawn.md](../claude/spawn.md#이벤트-스트림-파싱)의 코드 그대로 재사용.

**B) 스트리밍이 없을 때 (Codex 스타일)**

```ts
const outputPath = path.join('/tmp', `_gemini_${requestId || Date.now()}.out`);
const child = spawn('gemini', [
  /* 프롬프트 */, /* 모델 */,
  /* --output-file 등 최종 응답 파일 옵션이 있다면 */
], { stdio: ['ignore', 'pipe', 'pipe'] });
```

`close` 이벤트에서 파일(또는 stdout 누적치)을 읽어 SSE로 중계 — [Codex spawn.md](../codex/spawn.md#최종-응답-수집)의 코드 재사용.

## SSE 프로토콜

Claude/Codex 템플릿과 동일한 5종 이벤트를 프런트엔드에 전송합니다: `progress` / `log` / `result` / `error` / `cancelled`. 종료 시 `data: [DONE]` 마커. 이 계약은 변경 금지입니다.

```ts
const send: SendFn = (type, msg) =>
  res.write(`data: ${JSON.stringify({ type, message: msg })}\n\n`);
```

## 취소 처리

`Map<requestId, ChildProcess>`에 프로세스를 등록해 두고 `POST /chat/cancel`에서 `child.kill()`. Claude/Codex 코드를 그대로 복제하세요.

## 오류 처리

- `child.on('error', err)` — CLI 미설치 시 `err.code === 'ENOENT'`로 감지해 "Gemini CLI가 설치되어 있지 않습니다." 반환.
- `stderr` 누적 후 실패 시 앞 200자를 클라이언트에 전달.

## 새 DB 조합 템플릿 만들 때 체크리스트

1. Claude 또는 Codex 템플릿의 `server.ts`를 복제해 spawn 대상만 `gemini`로 교체.
2. 실제 `gemini --help`로 인자를 확정하고 이 문서의 표를 실제 값으로 교체 커밋.
3. `buildSystemPrompt`만 해당 DB(SQL/NoSQL)에 맞춰 재작성 ([system-prompt.md](./system-prompt.md)).
4. `activeJobs` 취소 로직과 SSE 프로토콜은 그대로 유지 — 프런트엔드가 이 형식을 전제로 합니다.
