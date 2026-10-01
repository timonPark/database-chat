@echo off
chcp 65001 >nul: 2>nul:
:: ================================================================
::  gemini-postgresql — Install Script (Windows)
::  LLM Provider : Gemini (agy CLI)
::  Database     : PostgreSQL  (port: 5432)
::  DB Docs      : https://www.postgresql.org/docs/
:: ================================================================
::
:: [DB 조회 최적화 팁] — 자세한 내용: https://www.postgresql.org/docs/
::   - EXPLAIN ANALYZE 로 실행 계획과 실제 소요 시간을 확인하세요
::   - 자주 조회하는 컬럼에 CREATE INDEX 로 인덱스를 추가하세요
::   - pg_stat_statements 로 느린 쿼리(slow query)를 추적하세요
::   - VACUUM ANALYZE 로 통계 정보를 최신 상태로 유지하세요
::
:: ================================================================

echo.
echo ================================================================
echo   gemini-postgresql 설치 스크립트  ^(Windows^)
echo   LLM Provider : Gemini (agy CLI)
echo   Database     : PostgreSQL  ^(port: 5432^)
echo   DB Docs      : https://www.postgresql.org/docs/
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
echo   [2/5] Antigravity CLI (agy) 확인...
where agy >nul: 2>nul:
if %ERRORLEVEL% neq 0 (
  echo [!] Antigravity CLI (agy) 가 설치되어 있지 않습니다.
  echo     https://antigravity.dev 를 참고해 agy 를 설치하세요.
) else (
  for /f "tokens=*" %%v in ('agy --version 2^>nul') do echo [v] agy %%v
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
echo   [4/5] DB 접속 정보를 .env 파일에서 확인하세요 (PORT: 5432)

:: ── 5/5. 환경변수 설정 ─────────────────────────────────────────
echo.
echo   [5/5] 환경변수 설정...
if not exist .env (
  copy .env.example .env >nul:
  echo [!] .env 파일이 생성됐습니다. 아래 항목을 입력하세요:
  echo.
  echo   DB_HOST=127.0.0.1
  echo   DB_PORT=5432
  echo   DB_DATABASE=<데이터베이스명>
  echo   DB_USER_NAME=postgres
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
