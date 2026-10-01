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

> **추가 필수 파일**: 위 6개 델타 외에 Windows 템플릿은 아래 파일을 반드시 포함해야 한다.
>
> | 파일 | 이유 | 자세히 |
> |---|---|---|
> | `scripts/generate-schema.ts` | Mac 의 `generate-schema.sh` (bash) 대체. 스캐폴더의 `hasNodeSchemaScript()` 가 이 파일 유무로 bash 생성 여부를 결정 | §5 |
> | `scripts/generate-erd.ts` | seeds 의 Mac 버전은 `spawnSync('claude', ['-p', prompt])` 라 Windows 에서 ENOENT · 길이 제한 | §8 |
> | `scripts/generate-index.ts` | 위와 동일 (스키마 생성 마지막 단계에서 호출) | §8 |
>
> 템플릿에 이 파일들이 없으면 스캐폴더가 `seeds/<db>/` 의 Mac 버전을 복사하므로 Windows 에서 깨진다.

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

스캐폴더(`src/index.ts`)의 `hasNodeSchemaScript()` 함수가 템플릿에 `scripts/generate-schema.ts` 가 있는지 확인하고, 있으면 다음 두 단계를 건너뛴다.

- `generateSchemaScript()` 의 `generate-schema.sh` 생성 (`skipBash` 옵션)
- `addSchemaToPackageScripts()` 의 `"schema": "bash scripts/generate-schema.sh"` 덮어쓰기

단, `extract-schema.ts` · `generate-index.ts` · `generate-schema-prompt.md` 등 `generate-schema.ts` 가 사용하는 공용 파일은 계속 seeds 에서 복사한다 (템플릿에 이미 있으면 보존 — §7).

이 파일이 없으면 스캐폴더가 bash 스크립트를 생성하고 package.json 을 덮어써 Windows 에서 `npm run schema` 가 `WSL ... execvpe(/bin/bash) failed` 로 실패한다.

> **이력**: 이 절이 처음 작성된 시점(c9682c7)에는 `hasNodeSchemaScript()` 가 문서에만 있고 `src/index.ts` 에는 구현되지 않았다. 그 결과 템플릿의 `"schema": "tsx scripts/generate-schema.ts"` 가 스캐폴딩 직후 bash 로 덮어써졌다. 이후 구현 완료 (`fix/windows-scaffold-template-overwrite`). **스펙에 스캐폴더 함수를 적을 때는 구현 여부를 함께 확인할 것.**

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

## 6. 프로젝트 루트 `claude-mongodb` 현황

프로젝트 루트의 `claude-mongodb/` (테스트/검증용) 는 §5 규칙을 따르며:

- `scripts/generate-schema.ts` 포함 (Windows 환경에서 실행 가능)
- `package.json` 의 `"schema"` 스크립트: `tsx scripts/generate-schema.ts`
- `.sh` bash 스크립트는 레퍼런스용으로만 보관
- `scripts/generate-erd.ts` · `scripts/generate-index.ts` 는 Windows 버전(§8) 으로 교체됨

이로써 Mac/Windows 양쪽 사용자가 동일하게 `npm run schema` 로 스키마 생성 가능. Windows 에서 bash/WSL 없이도 작동.

---

## 7. 스캐폴더는 Windows 템플릿 파일을 덮어쓰지 않는다

### 특성
스캐폴더(`src/index.ts`)는 템플릿 폴더를 복사한 뒤 여러 후처리 단계에서 파일을 **새로 생성하거나 seeds 에서 복사**한다. 이 후처리는 Mac 기준으로 작성돼 있다.

| 후처리 함수 | 생성/복사 파일 |
|---|---|
| `generateReadme()` | `README.md` (bash 코드블록 · `cp` 안내) |
| `generateInstallScripts()` | `install.sh` · `install.bat` |
| `generateStartScripts()` | `start.sh` · `start.bat` |
| `generateSchemaScript()` | seeds → `extract-schema.ts` · `generate-index.ts` · `generate-schema-prompt.md`, `generate-schema.sh` 생성 |
| `generateErdScript()` | seeds → `generate-erd.ts` |

### 영향
Windows 템플릿은 Windows 실기 검증을 거친 완성본인데, 후처리가 그 위에 Mac 기준 결과물을 덮어쓰면 검증된 Windows 대응이 사라진다. 실제 발생 사례:
- `package.json` 의 `schema` 가 bash 로 덮어써짐 → WSL bash 오류 (§5)
- `generate-erd.ts` · `generate-index.ts` 가 seeds 의 Mac 버전으로 복사됨 → `spawnSync claude ENOENT` (§8)
- 검증된 `install.bat` · `start.bat` (괄호 블록 대신 `goto` 사용) 이 생성본으로 교체되고, Windows 에 불필요한 `.sh` 가 추가됨

**템플릿 폴더를 직접 실행해 검증하면 이 문제가 드러나지 않는다.** 반드시 스캐폴더를 거친 결과물로 검증해야 한다 (아래 검증 방법).

### 규칙
- Windows 템플릿(`templates/windows/<combo>/`) 을 사용한 경우 (`isWindowsTemplate`), **템플릿에 이미 있는 파일은 후처리가 덮어쓰지 않는다.**
  - `README.md` · `install.bat` · `start.bat` 이 템플릿에 있으면 해당 생성 함수를 건너뛴다 (`templateHas()`).
  - seeds 파일 복사는 `copySeedFile(src, dest, keepExisting)` 를 사용 — `keepExisting` 이면 기존 파일 보존.
- mac fallback (Windows 템플릿이 아직 없는 combo) 과 Mac 은 기존 동작 그대로 유지한다.
- 플랫폼 판단은 스캐폴더가 **어느 템플릿 폴더를 골랐는지**로 한다 (템플릿 파일 내부 분기 금지 원칙과 동일).

### 레퍼런스 구현
`src/index.ts` 의 `isWindowsTemplate` · `templateHas()` · `copySeedFile()`

### 검증 방법
Windows 플랫폼을 모의한 스캐폴딩 결과물을 템플릿과 diff:
```bash
# win.mjs: Object.defineProperty(process, 'platform', { value: 'win32' });
node --import ./win.mjs dist/index.js <combo>     # 대화형 선택 진행
diff -rq templates/windows/<combo> <combo> | grep -v node_modules
```
허용되는 차이는 `_gitignore → .gitignore`, `package.json` 의 `name`, seeds 에서 추가된 공용 파일(템플릿에 없던 것)뿐. 그 외 `differ` 가 나오면 후처리가 템플릿을 덮어쓴 것.

Mac 회귀 확인: 수정 전/후 스캐폴더로 각각 생성한 결과물을 `diff -r -x node_modules -x package-lock.json` 해서 동일해야 한다.

---

## 8. seeds 의 LLM 호출 스크립트 — Windows 템플릿 자체 버전 필수

### 특성
`seeds/<db>/generate-erd.ts` · `seeds/<db>/generate-index.ts` 는 Claude CLI 를 다음처럼 호출한다.
```ts
spawnSync('claude', ['-p', prompt, '--model', MODEL, '--allowedTools', 'Bash'], { stdio: ['ignore', ...] })
```

### 영향
- `'claude'` 문자열 그대로 `shell: false` 실행 → npm 설치 CLI 는 `claude.cmd` shim 이라 `spawnSync claude ENOENT` (§1)
- 프롬프트(인덱스 + 매핑 + 컬렉션 상세, 수십 KB) 를 `-p` 인자로 전달 → 커맨드라인 길이 제한 (§2)
- `erd.bat` 실행 시 즉시 실패, `schema.bat` 은 마지막 enrichment 단계(`generate-index.ts`) 에서 실패

### 규칙
Windows 템플릿은 `scripts/generate-erd.ts` · `scripts/generate-index.ts` 를 자체 포함한다. seeds 원본 대비 델타는 아래 3개뿐:
1. `resolveClaudeBin()` 추가 후 `spawnSync(resolveClaudeBin(), ...)` 로 호출 (§1, `generate-schema.ts` 와 동일 구현)
2. 프롬프트는 인자에서 빼고 `input: prompt` + `stdio: ['pipe', 'inherit', 'inherit']` 로 stdin 전달 (§2)
3. `shell: false` 명시 + `maxBuffer` 지정

참고: `@anthropic-ai/claude-code` 2.x 의 npm `bin` 은 `bin/claude.exe` 이므로 npm 이 생성하는 `claude.cmd` shim 에 `%dp0%\node_modules\...\claude.exe` 경로가 들어 있어 §1 regex 로 해결된다.

seeds 에 새 스크립트가 추가될 때 Claude CLI(또는 다른 LLM CLI) 를 spawn 한다면 동일하게 Windows 템플릿 버전을 만들어야 한다. 확인 방법:
```bash
grep -n "spawn" seeds/<db>/*.ts
```

### 레퍼런스 구현
`templates/windows/claude-mongodb/scripts/generate-erd.ts`, `generate-index.ts`

### 검증 방법
PATH 앞에 가짜 `claude` 를 두고 실행해, 인자에 프롬프트가 없고 stdin 으로 전달되는지 확인:
```bash
# fakebin/claude: echo "$*" > /tmp/args; cat > /tmp/stdin; printf 'erDiagram\n' > erd.mmd
PATH=$PWD/fakebin:$PATH npm run erd
cat /tmp/args      # → -p --model <model> --allowedTools Bash  (프롬프트 없음)
wc -c /tmp/stdin   # → 프롬프트 크기
```

---

## 9. 스캐폴더 자체의 명령 실행 규칙 (자동 설정 단계)

§1~§8 은 생성되는 템플릿 쪽 규칙이다. 스캐폴더(`src/index.ts`) 자신도 사용자 PC(Windows 포함) 에서 실행되므로 아래를 지킨다.

### 특성
- `execSync`/`spawnSync` 에 `shell: true` 또는 문자열 명령을 주면 Windows 에서는 **cmd.exe** 가 실행된다. PowerShell 이 아니다. cmd.exe 에는 `cp` · `rm` · `chmod` 등이 없다.
- `npm` · `pnpm` · `yarn` · `npx` 는 Windows 에서 `.cmd` 이므로 `shell: false` 로 실행하면 ENOENT/EINVAL.
- `shell: true` 에 인자 배열을 같이 넘기면 Node 24 에서 `DEP0190` 경고가 출력된다.

### 영향
자동 설정의 `.env 파일 생성` 단계가 `execSync('cp .env.example .env')` 로 구현돼 있어 Windows 에서 `Command failed: cp .env.example .env` 로 중단됐다.

### 규칙
- 파일 복사·삭제·권한 변경은 셸 명령 대신 Node API (`fs.copyFileSync` · `fs.rmSync` · `fs.chmodSync`) 를 쓴다. OS 분기 불필요.
- 패키지 매니저 · CLI 실행은 `run(cmd, args, opts)` 헬퍼를 쓴다. Mac/Linux 는 `spawnSync(cmd, args)`, Windows 는 고정 인자만 이어붙인 문자열을 `shell: true` 로 실행 (DEP0190 회피). **개행·사용자 입력이 들어가는 인자(긴 프롬프트 등) 에는 쓰지 말 것** — 그런 경우는 stdin 으로 전달.
- 사용자에게 보여주는 안내 명령은 플랫폼에 맞춘다 (`ENV_COPY_CMD`: Windows `copy .env.example .env` — cmd.exe · PowerShell 양쪽 동작).
- 스캐폴더 안의 플랫폼 분기는 허용된다 (템플릿 선택과 같은 레벨). 금지 대상은 **템플릿 파일 내부** 분기다.

### 레퍼런스 구현
`src/index.ts` 의 `IS_WINDOWS` · `ENV_COPY_CMD` · `run()`, `runAutoSetup()` 의 `.env 파일 생성` 단계 (`copyFileSync`)

---

## 10. 미해결 — 샘플 데이터(seed) 의 Windows 대응

Docker 모드 + 샘플 데이터 선택 시 스캐폴더가 `addSeedScript()` 로 `"seed": "bash scripts/seed.sh"` 를 설정한다. Windows 에서는 §5 와 같은 이유(WSL bash) 로 실패한다. `seeds/mongodb/seed.ts` 가 존재하지만 사용되지 않으며 데이터 경로(`data/sample.json`) 도 현재 구조와 맞지 않는다.

규칙 확정 전까지는 Windows 에서 seed 를 쓰지 않는다. 대응 방향 (미결정): Windows 템플릿에 Node 기반 `scripts/seed.ts` 를 포함하고 `hasNodeSeedScript()` 로 §5 와 같은 방식 적용.

---

## 부록: 추가 규칙 검토 시 체크리스트

새 Windows 특성을 발견하면 아래 형식으로 이 문서에 추가:
1. **특성**: OS 가 어떻게 다르게 동작하는가 (Mac/Linux 대비)
2. **영향**: 어떤 기능이 어떻게 깨지는가
3. **규칙**: 코드에서 지켜야 하는 처리 (플랫폼 가드 조건 포함)
4. **레퍼런스 구현**: 이미 검증된 코드 위치
5. **검증 방법**: 재현/검증 절차

**플랫폼 가드는 파일 안이 아니라 폴더/템플릿 단위에서 한다.** Windows 전용 폴더는 그 안의 모든 코드가 Windows 를 가정. `process.platform` 조건분기를 파일 내부에 넣으면 나중에 뭐가 뭔지 구분이 안 되므로 금지.
