# Windows 환경설정 가이드

이 문서는 Windows에서 `create-database-chat` CLI를 실행하기 위해 필요한 환경설정을 설명합니다.

## 1. 사전 요구사항

- **Node.js >= 18** (프로젝트의 package.json에서 요구)
- **PowerShell** 또는 **Git Bash**
- **LLM CLI 도구** (아래 섹션 참고)
  - Claude CLI (Anthropic)
  - Codex CLI (OpenAI)
  - AGY CLI (Google Gemini)

## 2. PowerShell 실행 정책 설정

### 문제
PowerShell에서 npm 명령 실행 시 다음 오류 발생:
```
이 시스템에서 스크립트를 실행할 수 없으므로 C:\Program Files\nodejs\npx.ps1 파일을 로드할 수 없습니다.
```

### 해결 방법 (3가지)

#### 방법 1: 단일 명령만 실행 (임시)
```powershell
powershell -ExecutionPolicy Bypass -Command "npm install"
```

#### 방법 2: 현재 사용자용 정책 변경 (권장) ⭐
```powershell
Set-ExecutionPolicy -ExecutionPolicy RemoteSigned -Scope CurrentUser
```
이후 PowerShell을 재시작하면 모든 npm 명령이 정상 작동합니다.

#### 방법 3: Git Bash 사용
PowerShell 대신 Git Bash를 사용하면 이 문제가 없습니다.

## 3. LLM CLI 설치

이 프로젝트는 다양한 LLM 제공자를 지원합니다. 사용하려는 제공자의 CLI를 설치하세요.

### 3.1 Claude CLI (Anthropic) ⭐ 권장

**설치:**
```powershell
npm install -g @anthropic-ai/claude-code
```

**로그인:**
```powershell
claude login
```

**환경 변수 (선택):**
```powershell
$env:CLAUDE_MODEL = "claude-haiku-4-5-20251001"
# 또는 다른 모델: claude-opus-4-1, claude-sonnet-4, claude-haiku-3-5 등
```

**버전 확인:**
```powershell
claude --version
```

### 3.2 Codex CLI (OpenAI)

**설치:**
```powershell
npm install -g @openai/codex
```

**로그인:**
```powershell
codex login
# OpenAI 구독 계정으로 로그인해야 합니다.
```

**환경 변수 (선택):**
```powershell
$env:CODEX_MODEL = "gpt-5.6-luna"
# Windows 기본 경로 자동 감지: C:\Users\<username>\AppData\Local\ChatGPT\Codex
```

**버전 확인:**
```powershell
codex --version
```

### 3.3 AGY CLI (Google Gemini / Antigravity)

**설치:**
```powershell
npm install -g @anthropic-ai/agy
```

또는 Homebrew 사용 (Windows에서는 WSL2 필요):
```bash
brew install antigravity-ai/cli/agy
```

**인증:**
Google 계정으로 자동 인증됩니다.

**지원 모델 확인:**
```powershell
agy models
```

**버전 확인:**
```powershell
agy --version
```

## 4. 프로젝트 설정 단계

### 4.1 의존성 설치
```powershell
npm install
```

### 4.2 빌드
```powershell
npm run build
```

이 명령은 TypeScript를 JavaScript로 컴파일하고 `dist/index.js` 파일을 생성합니다.

### 4.3 CLI 등록 (중요)
```powershell
npm link
```

**이 단계가 중요합니다!** `npm link`는 로컬 패키지를 시스템 전역에 등록하여 다음과 같이 명령을 사용할 수 있게 만듭니다:
- `create-database-chat <db-type>`
- `npx create-database-chat <db-type>`

## 5. 사용 예시

### CLI 명령 실행
```powershell
create-database-chat claude-mongodb
create-database-chat claude-mysql
create-database-chat claude-postgresql
```

### 개발 모드에서 실행 (빌드 없이)
```powershell
npm run dev claude-mongodb
```

## 6. Windows와 Unix의 차이점

이 프로젝트의 `dist/index.js`에는 다음과 같은 Windows 대응이 포함되어 있습니다:

```javascript
const IS_WINDOWS = process.platform === 'win32';
const ENV_COPY_CMD = IS_WINDOWS ? 'copy .env.example .env' : 'cp .env.example .env';
```

- **Linux/macOS**: `cp` 명령 사용
- **Windows**: `copy` 명령 사용

또한 npm/pnpm/yarn 같은 .cmd 래퍼 명령들을 `shell: true` 옵션으로 실행하여 Windows에서 정상 작동하도록 설정되어 있습니다.

## 7. LLM 제공자 선택 가이드

### 어떤 CLI를 설치해야 할까?

| 제공자 | 비용 | 설치 | 로그인 | 장점 |
|--------|------|------|--------|------|
| **Claude (권장)** | 무료 또는 유료 | npm install | claude login | 성능 우수, 빠른 응답 |
| **Codex** | 유료 | npm install | codex login | OpenAI GPT 모델 사용 |
| **AGY (Gemini)** | 무료 또는 유료 | npm install | 자동 (Google 로그인) | Google Gemini 모델 사용 |

### CLI 버전 확인 및 트러블슈팅

**설치된 CLI 확인:**
```powershell
# 각각 설치되었는지 확인
claude --version
codex --version
agy --version
```

**경로 확인:**
```powershell
which claude
which codex
which agy
```

**환경 변수 확인:**
```powershell
$env:CLAUDE_MODEL
$env:CODEX_MODEL
```

## 8. 문제 해결

### "create-database-chat is not recognized"
→ `npm link`를 실행했는지 확인하세요.

### PowerShell 오류 발생
→ 실행 정책을 확인하세요: `Get-ExecutionPolicy -Scope CurrentUser`
→ 필요시 방법 2의 `Set-ExecutionPolicy` 명령을 실행하세요.

### 빌드 실패
→ Node.js 버전 확인: `node --version` (18 이상 필요)
→ TypeScript 재설치: `npm install`

### CLI를 찾을 수 없다는 오류
```
오류: Claude CLI(claude)를 찾을 수 없습니다.
```
→ CLI가 설치되었는지 확인: `claude --version`
→ 설치되지 않았다면: `npm install -g @anthropic-ai/claude-code`
→ PowerShell 창을 다시 열어서 PATH를 갱신하세요.

### CLI 로그인 오류
```
codex login 이 작동하지 않음
```
→ 로그인 상태 확인: `codex auth status`
→ 다시 로그인: `codex login --force`

## 9. 정리 (제거)

### create-database-chat 제거
```powershell
npm unlink create-database-chat --global
npm unlink
```

### LLM CLI 제거 (선택)

**Claude CLI 제거:**
```powershell
npm uninstall -g @anthropic-ai/claude-code
```

**Codex CLI 제거:**
```powershell
npm uninstall -g @openai/codex
```

**AGY CLI 제거:**
```powershell
npm uninstall -g @anthropic-ai/agy
```

## 10. 완전한 설정 요약

### 최소 설정 (Claude CLI만 사용)
```powershell
# 1. LLM CLI 설치 (한 번만)
npm install -g @anthropic-ai/claude-code
claude login

# 2. 실행 정책 설정 (처음 한 번만)
Set-ExecutionPolicy -ExecutionPolicy RemoteSigned -Scope CurrentUser

# 3. 프로젝트 설정 (클론 후 한 번만)
npm install
npm run build
npm link

# 4. 사용 시작
create-database-chat claude-mongodb
```

### 전체 설정 (모든 LLM 제공자 지원)
```powershell
# 1. 모든 LLM CLI 설치
npm install -g @anthropic-ai/claude-code
npm install -g @openai/codex
npm install -g @anthropic-ai/agy

# CLI 로그인
claude login
codex login
# agy는 자동 로그인 (Google 계정)

# 2. 실행 정책 설정
Set-ExecutionPolicy -ExecutionPolicy RemoteSigned -Scope CurrentUser

# 3. 프로젝트 설정
npm install
npm run build
npm link

# 4. 어떤 제공자든 사용 가능
create-database-chat claude-mongodb      # Claude 사용
create-database-chat codex-mysql         # Codex 사용
create-database-chat gemini-postgresql   # Gemini 사용
```

### 이미 설치된 후 재실행할 때 (간단함)
```powershell
cd C:\database-chat
create-database-chat claude-mongodb
```
