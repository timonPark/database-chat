# Codex CLI Spawn

서버가 OpenAI Codex CLI를 자식 프로세스로 실행하는 방식과, 최종 응답을 파일에서 읽어 SSE로 중계하는 규약을 정리합니다.

## 왜 CLI를 스폰하는가

- **구독 인증 재사용.** 로컬 `codex` CLI에 로그인된 ChatGPT 구독 세션을 그대로 사용하므로 서버 코드에 API 키가 필요 없습니다.
- **셸 실행 권한 위임.** Codex는 `--sandbox danger-full-access`로 스스로 셸을 열어 `curl`을 반복 실행합니다. 서버는 도구 호출 로직을 짤 필요가 없습니다.

## CLI 경로 탐색

Codex CLI는 GUI 앱(`ChatGPT.app`) 번들 안에 설치되는 경우가 많아 PATH에 없을 수 있습니다. 후보 경로를 순서대로 시도합니다:

기준 구현: `templates/codex-mongodb/server.ts:220`

```ts
const CODEX_CLI_PATHS: string[] = [
  process.env.CODEX_CLI_PATH ?? '',
  'codex',
  '/Applications/ChatGPT.app/Contents/Resources/codex',
].filter(Boolean);

function resolveCodexCli(): string {
  for (const candidate of CODEX_CLI_PATHS) {
    try {
      execSync(`"${candidate}" --version`, { stdio: 'ignore' });
      return candidate;
    } catch { /* 다음 후보 확인 */ }
  }
  return 'codex';
}
```

`--version`이 성공하는 첫 후보를 사용합니다. 모두 실패하면 문자열 `'codex'`를 반환해 `spawn`이 `ENOENT`를 던지도록 두고, 사용자에게 안내 문구를 표시합니다.

## 실행 인자

기준 구현: `templates/codex-mongodb/server.ts:722`

```ts
const outputPath = path.join('/tmp', `_codex_${requestId || Date.now()}.out`);
const codexArgs: string[] = [
  'exec',
  '--skip-git-repo-check',
  '--sandbox', 'danger-full-access',
  '--output-last-message', outputPath,
  '--model', CODEX_MODEL,
  buildCodexPrompt(message.trim(), requestId ?? '', limit),  // 프롬프트는 positional
];

const child = spawn(resolveCodexCli(), codexArgs, {
  stdio: ['ignore', 'pipe', 'pipe'],
});
```

| 인자 | 목적 |
| --- | --- |
| `exec` | 원샷 실행 서브커맨드 (대화형 REPL 미사용) |
| `--skip-git-repo-check` | 프로젝트 폴더가 git repo가 아니어도 실행 |
| `--sandbox danger-full-access` | 셸/파일 접근 허용 — 내부 endpoint로만 curl을 쓰지만 CLI 단에서는 전체 권한 필요 |
| `--output-last-message <path>` | 최종 응답을 지정 파일에 저장 (핵심) |
| `--model` | 모델 ID (env로 오버라이드 가능) |
| positional | 시스템 프롬프트 + 사용자 메시지를 합친 최종 프롬프트 |

Claude와 달리 `--system-prompt` 플래그가 없으므로 시스템 규칙을 프롬프트 앞에 인라인으로 붙입니다. [`system-prompt.md`](./system-prompt.md) 참고.

## 최종 응답 수집

Codex CLI는 stream-json 프로토콜이 없습니다. stdout은 진행 로그 성격이라 파싱하지 않고, **최종 응답은 `--output-last-message`가 쓴 파일에서 읽습니다.**

```ts
let progressSent = false;

child.stdout!.on('data', (data: Buffer) => {
  stdout += data.toString();
  if (!progressSent) {
    progressSent = true;
    send('progress', 'Codex 실행 중...');
  }
});

child.on('close', (code, signal) => {
  const finalResult = fs.existsSync(outputPath)
    ? fs.readFileSync(outputPath, 'utf-8')
    : stdout;

  if (signal === 'SIGKILL' || signal === 'SIGTERM') {
    send('cancelled', '조회가 중지되었습니다.');
  } else if (code !== 0 && !finalResult) {
    send('error', 'Codex 프로세스 실행 실패: ' + stderr.slice(0, 200));
  } else {
    send('result', finalResult.trim());
  }

  try { fs.unlinkSync(outputPath); } catch { /* 무시 */ }
});
```

- 파일이 없으면 stdout을 폴백으로 사용합니다.
- 세션 종료 후 임시 파일은 반드시 삭제합니다.

## SSE 프로토콜

Claude 템플릿과 동일한 5종 이벤트를 프런트엔드에 전송합니다: `progress` / `log` / `result` / `error` / `cancelled`. 종료 시 `data: [DONE]` 마커로 스트림을 닫습니다.

Codex는 툴 호출 단위 이벤트가 없으므로 `progress`는 세션 시작 시 1회, `result`는 종료 시 1회만 전송합니다. 프런트엔드 계약은 그대로 유지됩니다.

## 취소 처리

`Map<requestId, ChildProcess>`에 프로세스를 등록해 두고 `POST /chat/cancel`에서 `child.kill()`:

```ts
const activeJobs = new Map<string, ChildProcess>();
const activeSends = new Map<string, SendFn>();

if (requestId) activeJobs.set(requestId, child);
if (requestId) activeSends.set(requestId, send);

child.on('close', () => {
  if (requestId) activeJobs.delete(requestId);
  if (requestId) activeSends.delete(requestId);
  // ...
});
```

`activeSends`는 취소 요청에서 `send('cancelled', ...)`를 직접 호출해 브라우저에 알림을 보내기 위한 보조 맵입니다.

## 오류 처리

- `child.on('error', err)` — CLI 미설치 시 `err.code === 'ENOENT'`로 감지해 "Codex CLI가 설치되어 있지 않습니다." 반환.
- `stderr` 누적 후, exit code 0이 아니고 최종 결과도 비어 있으면 앞 200자를 클라이언트에 전달.

## 새 DB 조합 템플릿 만들 때 체크리스트

1. `spawn(resolveCodexCli(), codexArgs)` 호출부와 CLI 경로 탐색 로직을 재사용합니다.
2. `buildSystemPrompt` + `buildCodexPrompt`만 해당 DB(SQL/NoSQL)에 맞춰 재작성 ([system-prompt.md](./system-prompt.md)).
3. `--output-last-message` 파일 기반 응답 수집과 SSE 프로토콜은 그대로 유지 — 프런트엔드가 이 형식을 전제로 합니다.
4. Claude 템플릿과 달리 stream-json 이벤트 핸들러는 필요 없습니다.
