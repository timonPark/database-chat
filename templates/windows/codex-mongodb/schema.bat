@echo off
chcp 65001 >nul: 2>nul:
cd /d "%~dp0"
:: codex-mongodb — 스키마 인덱스 생성 (npm run schema)
::   - DB 컬렉션 목록/건수/필드를 추출하고 AI CLI 로 다음 파일을 갱신합니다.
::     index.md · collection-mapping.md · collections/*.md
::   - 대화형: AI 모델 선택 + 업데이트 범위(전체/누락/직접 지정) 를 물어봅니다.

if not exist node_modules goto :no_modules
if not exist .env goto :no_env
goto :run

:no_modules
echo [!] node_modules 가 없습니다. install.bat 를 먼저 실행하세요.
pause
exit /b 1

:no_env
echo [!] .env 파일이 없습니다. install.bat 를 먼저 실행하세요.
pause
exit /b 1

:run
call npm run schema
pause
