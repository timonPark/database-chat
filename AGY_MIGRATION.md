# Gemini CLI → Antigravity CLI (`agy`) 이관 정리

Google이 개인 계정(Pro 포함)의 `gemini` CLI 사용을 공식 중단하면서, 구독 기반 헤드리스 호출은 Antigravity CLI(`agy`)로만 가능해졌습니다. 이 문서는 그 배경과 설정·사용법을 정리합니다.

## 1. 이관 히스토리

### 1.1 기존 상황
- 리포지토리는 `1. llm_provider/gemini/spawn.md` 기준으로 `spawn('gemini', ...)` 패턴을 전제
- Claude Code / Codex와 동일하게 "구독 로그인 CLI를 서버가 자식 프로세스로 실행"하는 모델
- 메모리 규칙(`feedback_llm_provider_auth`): 모든 provider 템플릿은 구독 CLI spawn만 사용, API 키 금지

### 1.2 문제 발견
`@google/gemini-cli`를 npx로 실행 시 명시적 차단:

```
IneligibleTierError: This client is no longer supported for Gemini Code Assist
for individuals. To continue using Gemini, please migrate to the Antigravity
suite of products: https://antigravity.google
```

- Google이 개인 계정용 `gemini` CLI 경로를 정책적으로 차단
- Pro 구독을 결제해도 CLI 로그인 불가

### 1.3 후보 경로 검증
| 경로 | 결과 | 이유 |
|---|---|---|
| `gemini` CLI (npm) | ❌ | Google 정책 차단 |
| `~/.gemini/antigravity-cli/bin/agentapi` | ❌ | Antigravity IDE 내부용, 외부에서 붙기 위한 CSRF/포트가 동적이고 비공개 |
| Antigravity IDE만 상주 | ❌ | GUI 필요, 서버·CI 부적합 |
| Homebrew Cask `antigravity-cli`의 **`agy`** | ✅ | 스탠드얼론 CLI, `-p` 원샷 모드 지원, 구독 인증 재사용 |

### 1.4 결정
- provider 실체를 **Antigravity CLI(`agy`)** 로 정정
- `1. llm_provider/gemini/spawn.md`의 spawn 대상: `gemini` → `agy`
- Antigravity가 내부적으로 Gemini 모델을 사용하므로 사용자 관점 결과물은 동일

## 2. 헤드리스 설정 방법

### 2.1 사전 요건
- macOS (Apple Silicon 기준, Homebrew 설치돼 있어야 함)
- Google 계정 (Antigravity 무료 또는 유료 티어)

### 2.2 설치

```bash
# 1) Antigravity IDE 설치 (로그인 세션을 얻는 유일한 경로)
brew install --cask antigravity

# 2) Antigravity CLI 설치
brew install --cask antigravity-cli

# 3) CLI PATH 등록 (~/.zshrc, ~/.zprofile, ~/.bash_profile, ~/.profile에 export 추가)
$(brew --prefix)/Caskroom/antigravity-cli/*/antigravity install
```

### 2.3 로그인

1. Antigravity IDE(`/Applications/Antigravity.app`) 실행
2. Google 계정으로 로그인 완료
3. 토큰이 시스템 keyring에 저장됨 → CLI(`agy`)가 재사용

로그인 이후에는 IDE를 종료해도 `agy` 호출은 정상 동작합니다 (keyring 토큰만 필요).

### 2.4 확인

```bash
agy --version           # 예: 1.2.5
agy models              # 사용 가능한 모델 목록
agy -p "간단한 인사"     # 헤드리스 테스트
```

## 3. 사용법

### 3.1 기본 헤드리스 호출

```bash
agy -p "<프롬프트>"
```

- `-p` (또는 `--print`): 단일 프롬프트 실행 후 응답 출력하고 종료 (비대화형)
- 기본 타임아웃 5분

### 3.2 도구 사용이 필요한 프롬프트

`agy`는 필요 시 셸/웹 도구를 호출하는데, 헤드리스 모드에서는 승인 프롬프트를 띄울 수 없어 자동 거부됩니다.

```
jetski: no output produced — a tool required the "command" permission that
headless mode cannot prompt for, so it was auto-denied.
```

**해결:**

```bash
agy -p "<프롬프트>" --dangerously-skip-permissions
```

- Claude Code의 `--dangerously-skip-permissions`, Codex의 `--yolo`와 동일 개념
- 서버가 spawn할 때는 이 플래그를 붙이는 것이 표준

### 3.3 자주 쓰는 옵션

| 옵션 | 설명 |
|---|---|
| `-p, --print` | 원샷 비대화형 실행 |
| `--model <name>` | 모델 지정 (`agy models`로 확인) |
| `--print-timeout <duration>` | 응답 대기 타임아웃 (기본 `5m0s`) |
| `--dangerously-skip-permissions` | 도구 권한 프롬프트 자동 승인 |
| `--sandbox` | 터미널 제한 샌드박스 실행 |
| `-c, --continue` | 최근 대화 이어가기 |
| `--conversation <id>` | 특정 대화 ID로 재개 |

### 3.4 Node.js 서버에서 spawn 예시

```ts
import { spawn } from 'node:child_process';

const child = spawn('agy', [
  '-p', promptText,
  '--dangerously-skip-permissions',
  '--print-timeout', '10m',
], { stdio: ['ignore', 'pipe', 'pipe'] });

let buf = '';
child.stdout.on('data', (chunk) => { buf += chunk.toString(); });
child.on('close', (code) => {
  if (code !== 0) throw new Error(`agy exited ${code}`);
  console.log(buf);
});
```

Claude/Codex 템플릿의 SSE 프로토콜(`progress` / `log` / `result` / `error` / `cancelled` + `[DONE]`)을 그대로 재사용하면 됩니다.

## 4. 제약사항

- **로컬 개발기에서만 동작**: Antigravity 로그인 세션(keyring 토큰)이 있는 macOS 계정에서만 `agy` 호출 가능
- **원격 서버·CI·Docker 불가**: 헤드리스 리눅스 환경에는 Antigravity IDE 로그인 경로가 없음
- **개인 구독 라이선스 준수 필요**: 프로덕션 서버에 개인 구독을 심는 것은 라이선스 위반 가능성 있음 (Vertex AI 또는 AI Studio API 키를 별도 사용)

## 5. `create-database-chat` 적용

- `gemini-*` 템플릿의 `spawn` 대상: `gemini` → `agy`
- `--dangerously-skip-permissions` 기본 부여
- 스캐폴딩 안내 문서에 위 [2. 헤드리스 설정 방법] 링크 추가
- `.env.example`에 별도 API 키 항목 불필요 (인증은 keyring)

관련 이슈: [#3 Gemini provider 지원 (epic)](https://github.com/timonPark/database-chat/issues/3), [#12 schema prompt 5종 작성](https://github.com/timonPark/database-chat/issues/12)
