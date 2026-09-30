# Windows 플랫폼 스펙

Windows 에서만 나타나는 플랫폼 특성과 그에 맞춰 코드에 반영해야 하는 규칙을 모아둔 문서. Mac/Linux 와 근본 동작이 다른 지점만 기록한다.

관련 메모리·문서:
- `windows-support-plan.md` — Windows 지원 전략 (Mac 템플릿은 유지, Windows 전용 템플릿 신설)
- `claude-mongodb-wellcheck_windows_v2/TROUBLESHOOTING.md` — 실제 발생한 버그 사후 기록(로그)
- `claude-mongodb-wellcheck_windows/` — 옛 아키텍처 (#144 이전) Windows 실기 검증본 (read-only)
- `claude-mongodb-wellcheck_windows_v2/` — **새 아키텍처 (#144 이후, LLM 이 DB 결과 무접근) 기준 Windows 레퍼런스**. Mac 대응본은 `claude-mongodb-wellcheck/`

이 문서와 TROUBLESHOOTING 의 차이:
- 이 문서 = **스펙**: OS 특성 + 코드에서 지켜야 하는 규칙 (선행 지식)
- TROUBLESHOOTING = **사후 로그**: 실제 발생한 특정 버그 · 원인 · 조치 (사후 기록)

---

> **참고**: 이 문서 초안에는 "프로세스 인자 인코딩 (CP949)" 항목이 §1 으로 있었지만, #144 에서 아키텍처를 바꿔 **LLM 이 더 이상 curl 을 실행하지 않게 되어** 인코딩 문제가 근본에서 소멸했다. 서버가 LLM 텍스트 응답을 파싱해 직접 DB 를 조회하므로 curl 프로세스 경계 자체가 없어짐. 그래서 CP949 fallback 미들웨어 규칙은 폐기하고 아래 §1 부터 시작한다.

## 0. Mac 템플릿 → Windows 템플릿 변환 델타 (요약)

`claude-mongodb-wellcheck` (Mac, 새 아키텍처) 과 `claude-mongodb-wellcheck_windows_v2` (Windows, 새 아키텍처) 는 **아키텍처·프롬프트·이벤트 핸들러·내부 실행 함수·재쿼리 로직·UI·scripts 가 전부 동일**하다. 다른 것은 아래 6개 지점뿐. 다른 조합 (LLM · DB) 의 Windows 템플릿을 만들 때는 해당 Mac 템플릿 원본에 이 6개 델타만 그대로 얹으면 된다.

| # | 항목 | Mac | Windows | 자세히 |
|---|---|---|---|---|
| 1 | 추가 import | — | `import os from 'os'` · `import { fileURLToPath } from 'url'` · `import crypto from 'crypto'` | §2 |
| 2 | `__dirname` 파생 | `import.meta.dirname` 직접 사용 | `const __dirname = path.dirname(fileURLToPath(import.meta.url))` | §2 |
| 3 | LLM CLI 실행 파일 해결 | `spawn('claude', ...)` 문자열 그대로 | `spawn(resolveClaudeBin(), ...)` — `.cmd` shim → `.exe` 절대경로 파싱 | §1 |
| 4 | 시스템 프롬프트 전달 | `--system-prompt <inline text>` | 임시파일 write + `--system-prompt-file <path>` + close 시 cleanup | §2 |
| 5 | spawn 옵션 | 기본 (shell: false 가 default) | `{ shell: false, ... }` 명시 (인자 이스케이프 문제 방지 주석과 함께) | §1 |
| 6 | 포트 점유 해제 | \`\`\`ts\nexecSync('lsof -ti :3111')\n  .split('\\n')\n  .forEach(pid => process.kill(Number(pid), 'SIGKILL'))\n\`\`\` | \`\`\`ts\nexecSync('netstat -ano -p tcp')\n  .split('\\n')\n  .filter(l => l.includes('LISTENING') && l.match(RegExp))\n  .forEach(pid => execSync('taskkill /PID pid /F'))\n\`\`\` | §3 |

> **추가 필수 파일**: 위 6개 델타 외에 Windows 템플릿은 `scripts/generate-schema.ts` 를 반드시 포함해야 한다. Mac 의 `generate-schema.sh` 를 대체하는 Node.js 구현으로, 스캐폴더의 `hasNodeSchemaScript()` 검사가 이 파일 유무로 bash 생성 여부를 결정한다. 자세히 → §5.

**LLM CLI 별 참고 사항**:
- `claude`: `resolveClaudeBin()` 이 `where claude.cmd` 로 셈 위치를 찾아 `%dp0%\...\claude.exe` 상대 경로를 파싱
- `codex`: Windows 는 `codex.exe` 로 설치될 수 있음 (배포 방식 확인 필요), `--sandbox read-only` 는 그대로 유지
- `agy` (Gemini): Windows 배포 여부 확인 후 동일 패턴 (shim → exe 해결)

**절대 하지 말 것**:
- Mac 템플릿 파일 안에 `if (process.platform === 'win32')` 분기를 넣지 말 것. 폴더/템플릿 단위로 분리 (부록 참조).
- 위 6개 외의 로직 차이가 Windows 템플릿에서 발견되면, 그것은 Mac 이관이 누락됐거나 새로운 Windows 특성 발견을 의미. 확인 후 이 문서에 새 섹션 추가.

### 검증 방법

새 Windows 템플릿을 만든 뒤:
```bash
diff templates/<llm>-<db>/server.ts templates/<llm>-<db>-windows/server.ts
```
diff 결과가 위 표의 6개 지점에 국한되면 정상. 그 외 차이가 나오면 Mac 로직이 이관 안 됐거나 Windows 대응이 누락된 것.

---

## 1. `.cmd`/`.bat` 실행 파일과 `spawn`

### 특성
Windows 에서 npm 전역 설치 CLI (예: `claude`) 는 `.cmd` 셈(shim) 형태로 PATH 에 등록된다. Node 의 `child_process.spawn(cmd, args, { shell: false })` 는 `.cmd`/`.bat` 파일을 직접 실행할 수 없다 — 셸이 필요.

`shell: true` 로 하면 실행은 되지만 인자를 셸 문자열로 이어붙여 넘기므로 공백 포함 한글 인자가 여러 조각으로 쪼개지고 인젝션 위험도 생긴다.

### 규칙 (Windows 템플릿 필수)
`claude` 를 `spawn` 할 때 Windows 면 `where claude.cmd` 로 셈 위치를 찾아 그 안의 `claude.exe` 상대 경로를 파싱해 실제 `claude.exe` 절대 경로를 얻은 뒤 그 경로로 `shell: false` spawn 한다. 실패 시 문자열 `'claude'` 로 폴백.

**주의**: npm 버전에 따라 shim 내부의 경로 형식이 다르다.
- `%~dp0\...\claude.exe` — npm v6 이하 스타일
- `%dp0%\...\claude.exe` — npm v7+ 스타일

regex 는 두 형식을 모두 커버해야 한다: `/%~?dp0%?\\([^\s"]+claude\.exe)/i`

레퍼런스 구현: `claude-mongodb-wellcheck_windows_v2/server.ts` 의 `resolveClaudeBin()`.

---

## 2. 명령어 라인 길이 제한 — 시스템 프롬프트를 인자로 넘기지 말 것

### 특성
Windows 프로세스 커맨드라인은 `CreateProcessW` 기준 최대 32767 자, 셸을 거치면 훨씬 짧아진다 (`cmd.exe` 약 8191 자). 시스템 프롬프트에 DB 스키마 (수만 자) 를 담아 `-p` 인자로 넘기면 `ENAMETOOLONG` 발생.

### 규칙
시스템 프롬프트는 임시 파일에 쓰고 `--system-prompt-file <path>` 로 넘긴다. 파일 경로는 `os.tmpdir() + crypto.randomUUID()` 로 충돌 방지, 자식 프로세스 종료 시 삭제.

레퍼런스 구현: `claude-mongodb-wellcheck_windows_v2/server.ts` 의 `cleanupSystemPromptFile` 처리.

---

## 3. 포트 점유 프로세스 종료 — `lsof`/`kill` 대신 `netstat`/`taskkill`

### 특성
Windows 에는 `lsof` 가 없다. LISTENING 상태의 PID 는 `netstat -ano -p tcp` 로 얻고 `taskkill /PID <pid> /F` 로 종료한다.

### 규칙
서버 재시작 시 포트 점유 해제 로직은 플랫폼별 분기 필요. 레퍼런스: `killPort()` 함수.

---

## 5. `generate-schema.ts` — bash 스크립트를 Node.js 로 대체

### 특성
Mac 템플릿은 DB 스키마 생성을 `scripts/generate-schema.sh` (bash) 로 처리한다. Windows 에서 `bash` 는 대개 WSL 런처(`System32\bash.exe`)로 잡히거나 설치되지 않으며, `python3` 도 Microsoft Store stub 이라 `.sh` 를 직접 실행할 수 없다.

스캐폴더(`src/index.ts`)의 `hasNodeSchemaScript()` 함수가 템플릿에 `scripts/generate-schema.ts` 가 있는지 확인하고, 있으면 bash 기반 `.sh` 생성을 건너뛴다. 이 파일이 없으면 스캐폴더가 bash 스크립트를 생성해 Windows 에서 스키마 명령이 동작하지 않는다.

### 규칙
Windows 템플릿은 반드시 `scripts/generate-schema.ts` 를 포함해야 한다. 이 파일은 Mac 의 `generate-schema.sh` 와 동일한 흐름을 Node.js 로 구현한다:

1. 대화형 AI 모델 선택 + 업데이트 범위 선택
2. `scripts/extract-schema.ts` 로 DB 스키마 추출 (`runTsx()` — `shell: true` + npx 경유)
3. 배치 분할 후 `resolveClaudeBin()` 으로 얻은 `claude.exe` 직접 실행 (`shell: false`)
4. `scripts/generate-index.ts` 로 index.md · collection-mapping.md 생성

`npx` 는 Windows 에서도 `.cmd` 이므로 `runTsx()` 내부는 `shell: true` 를 사용해도 된다 — 인자를 외부에서 주입하지 않는 고정 문자열이기 때문에 인젝션 위험이 없다.

Claude 에게 넘기는 프롬프트는 `child.stdin.end(prompt)` 로 stdin 경유 전달 (커맨드라인 길이 제한 회피, §2 와 동일 이유).

레퍼런스 구현: `templates/windows/claude-mongodb/scripts/generate-schema.ts`

---

## 4. 자식 프로세스 환경 변수 (spawn) — 민감 키 제거

Windows 특성은 아니지만 Windows 템플릿에도 동일 적용. `spawn` 시 부모 프로세스의 `DB_HOST`, `DB_USER_PASSWORD` 등 자격 증명 키를 삭제한 env 로 전달해 LLM 자식이 유출하지 못하게 막는다.

레퍼런스: `CLAUDE_CHILD_ENV`.

---

## 부록: 추가 규칙 검토 시 체크리스트

새 Windows 특성을 발견하면 아래 형식으로 이 문서에 추가:
1. **특성**: OS 가 어떻게 다르게 동작하는가 (Mac/Linux 대비)
2. **영향**: 어떤 기능이 어떻게 깨지는가
3. **규칙**: 코드에서 지켜야 하는 처리 (플랫폼 가드 조건 포함)
4. **레퍼런스 구현**: 이미 검증된 코드 위치
5. **검증 방법**: 재현/검증 절차

**플랫폼 가드는 파일 안이 아니라 폴더/템플릿 단위에서 한다.** Windows 전용 폴더는 그 안의 모든 코드가 Windows 를 가정. `process.platform` 조건분기를 파일 내부에 넣으면 나중에 뭐가 뭔지 구분이 안 되므로 금지.
