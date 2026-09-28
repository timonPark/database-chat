# Windows 플랫폼 스펙

Windows 에서만 나타나는 플랫폼 특성과 그에 맞춰 코드에 반영해야 하는 규칙을 모아둔 문서. Mac/Linux 와 근본 동작이 다른 지점만 기록한다.

관련 메모리·문서:
- `windows-support-plan.md` — Windows 지원 전략 (Mac 템플릿은 유지, Windows 전용 템플릿 신설)
- `claude-mongodb-wellcheck_windows_v2/TROUBLESHOOTING.md` — 실제 발생한 버그 사후 기록(로그)
- `claude-mongodb-wellcheck_windows/` — Windows 실기 검증 완료 read-only 레퍼런스

이 문서와 TROUBLESHOOTING 의 차이:
- 이 문서 = **스펙**: OS 특성 + 코드에서 지켜야 하는 규칙 (선행 지식)
- TROUBLESHOOTING = **사후 로그**: 실제 발생한 특정 버그 · 원인 · 조치 (사후 기록)

---

> **참고**: 이 문서 초안에는 "프로세스 인자 인코딩 (CP949)" 항목이 §1 으로 있었지만, #144 에서 아키텍처를 바꿔 **LLM 이 더 이상 curl 을 실행하지 않게 되어** 인코딩 문제가 근본에서 소멸했다. 서버가 LLM 텍스트 응답을 파싱해 직접 DB 를 조회하므로 curl 프로세스 경계 자체가 없어짐. 그래서 CP949 fallback 미들웨어 규칙은 폐기하고 아래 §1 부터 시작한다.

## 1. `.cmd`/`.bat` 실행 파일과 `spawn`

### 특성
Windows 에서 npm 전역 설치 CLI (예: `claude`) 는 `.cmd` 셈(shim) 형태로 PATH 에 등록된다. Node 의 `child_process.spawn(cmd, args, { shell: false })` 는 `.cmd`/`.bat` 파일을 직접 실행할 수 없다 — 셸이 필요.

`shell: true` 로 하면 실행은 되지만 인자를 셸 문자열로 이어붙여 넘기므로 공백 포함 한글 인자가 여러 조각으로 쪼개지고 인젝션 위험도 생긴다.

### 규칙 (Windows 템플릿 필수)
`claude` 를 `spawn` 할 때 Windows 면 `where claude.cmd` 로 셈 위치를 찾아 그 안의 `%dp0%\...\claude.exe` 상대 경로를 파싱해 실제 `claude.exe` 절대 경로를 얻은 뒤 그 경로로 `shell: false` spawn 한다. 실패 시 문자열 `'claude'` 로 폴백.

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
