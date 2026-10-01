@echo off
chcp 65001 >nul: 2>nul:
:: ================================================================
::  claude-mssql — Install Script (Windows)
::  LLM Provider : Claude (Anthropic)
::  Database     : MSSQL  (port: 1433)
::  DB Docs      : https://learn.microsoft.com/ko-kr/sql/sql-server/
:: ================================================================
::
:: [DB 조회 최적화 팁] — 자세한 내용: https://learn.microsoft.com/ko-kr/sql/sql-server/
::   - SET NOCOUNT ON 으로 영향받은 행수 메시지를 억제하세요
::   - 실행 계획(Actual Execution Plan)으로 Missing Index 경고를 확인하세요
::   - WITH (NOLOCK) 힌트로 읽기 잠금을 줄일 수 있습니다 (오염 읽기 주의)
::   - 자주 조회하는 컬럼에 인덱스를 추가해 Table Scan 을 피하세요
::
:: ================================================================

echo.
echo ================================================================
echo   claude-mssql 설치 스크립트  ^(Windows^)
echo   LLM Provider : Claude (Anthropic)
echo   Database     : MSSQL  ^(port: 1433^)
echo   DB Docs      : https://learn.microsoft.com/ko-kr/sql/sql-server/
echo ================================================================
echo.

:: ── 1/5. Node.js 확인 ──────────────────────────────────────────
echo   [1/5] Node.js 확인...
where node >nul: 2>nul:
if %ERRORLEVEL% neq 0 (
  echo [오류] Node.js 가 설치되어 있지 않습니다.
  echo   https://nodejs.org 에서 Node.js 18 이상을 설치하세요.
  pause
  exit /b 1
)
for /f "tokens=*" %%v in ('node --version') do echo [v] Node.js %%v

:: ── 2/5. LLM Provider 확인 ─────────────────────────────────────
echo.
echo   [2/5] Claude CLI 확인...
where claude >nul: 2>nul:
if %ERRORLEVEL% neq 0 (
  echo [!] Claude CLI 가 설치되어 있지 않습니다.
  echo     npm install -g @anthropic-ai/claude-code 로 설치하거나
  echo     https://docs.anthropic.com/claude-code 를 참고하세요.
) else (
  for /f "tokens=*" %%v in ('claude --version 2^>nul') do echo [v] Claude CLI %%v
)

:: ── 3/5. 의존성 설치 ───────────────────────────────────────────
echo.
echo   [3/5] 의존성 설치 중 ^(npm install^)...
call npm install
if %ERRORLEVEL% neq 0 (
  echo [오류] npm install 실패
  pause
  exit /b 1
)
echo [v] 의존성 설치 완료

:: ── 4/5. Docker / DB 확인 ──────────────────────────────────────
echo.
echo   [4/5] DB 접속 정보를 .env 파일에서 확인하세요 (PORT: 1433)

:: ── 5/5. 환경변수 설정 ─────────────────────────────────────────
echo.
echo   [5/5] 환경변수 설정...
if not exist .env (
  copy .env.example .env >nul:
  echo [!] .env 파일이 생성됐습니다. 아래 항목을 입력하세요:
  echo.
  echo   DB_HOST=127.0.0.1
  echo   DB_PORT=1433
  echo   DB_DATABASE=<데이터베이스명>
  echo   DB_USER_NAME=SA
  echo   DB_USER_PASSWORD=^<DB 비밀번호^>
  echo.
  echo .env 파일 편집 후 아무 키나 누르면 서버가 시작됩니다.
  pause
) else (
  echo [v] .env 파일 확인
)

:: ── 서버 시작 ──────────────────────────────────────────────────
echo.
echo ================================================================
echo   서버 시작: http://localhost:3111
echo ================================================================
echo.
call npm start
pause
