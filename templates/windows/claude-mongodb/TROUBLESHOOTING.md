# TROUBLESHOOTING (Windows)

## Claude CLI 실행 실패 — ENOENT / spawn 오류

**증상**: 서버 로그에 `ENOENT` 또는 `Claude CLI가 설치되어 있지 않습니다.`

**원인**: `resolveClaudeBin()`이 `claude.exe` 경로를 찾지 못함.

**조치**:
1. `where claude` 로 PATH 등록 확인
2. 미설치 시 `npm install -g @anthropic-ai/claude-code`
3. 설치 후 새 터미널(또는 재부팅) — PATH 갱신 필요

---

## 시스템 프롬프트 파일 오류 — ENAMETOOLONG / 응답 없음

**증상**: 대용량 스키마에서 Claude가 응답하지 않거나 오류 발생.

**원인**: `--system-prompt-file` 임시 파일 생성/읽기 실패.

**조치**:
1. `%TEMP%` 디렉토리 쓰기 권한 확인
2. 안티바이러스가 임시 파일을 차단하는 경우 예외 추가

---

## 포트 3111 이미 사용 중

**증상**: `EADDRINUSE` 오류.

**조치**: 서버가 자동으로 `taskkill /PID /F` 실행 후 재시작.
수동으로 해제하려면:
```bat
netstat -ano -p tcp | findstr :3111
taskkill /PID <PID> /F
```

---

## MongoDB 연결 실패

**증상**: `MongoDB 연결 실패: ...`

**조치**:
1. `.env` 파일의 `DB_HOST`, `DB_PORT`, `DB_USER_NAME`, `DB_USER_PASSWORD` 확인
2. Docker 컨테이너 실행 여부 확인: `docker ps`
3. 방화벽에서 27017 포트 허용 여부 확인

---

## 한글 깨짐 (콘솔 출력)

**원인**: Windows 콘솔 기본 인코딩(CP949).

**조치**: `.bat` 파일 상단 `chcp 65001` 이 UTF-8로 전환함. 터미널을 Windows Terminal로 사용 권장.
