@echo off
chcp 65001 >nul: 2>nul:
cd /d "%~dp0"
:: gemini-mongodb — ERD 다이어그램 생성 (npm run erd)
::   - index.md · collection-mapping.md · collections/*.md 를 AI CLI 로 분석해
::     프로젝트 루트에 erd.mmd (Mermaid ER 다이어그램) 를 생성합니다.
::   - 사전 조건: npm run schema 로 collections/ 및 index.md 가 먼저 만들어져 있어야 합니다.

if not exist node_modules goto :no_modules
if not exist .env goto :no_env
if not exist collections goto :no_collections
if not exist index.md goto :no_index
goto :run

:no_modules
echo [!] node_modules 가 없습니다. install.bat 를 먼저 실행하세요.
pause
exit /b 1

:no_env
echo [!] .env 파일이 없습니다. install.bat 를 먼저 실행하세요.
pause
exit /b 1

:no_collections
echo [!] collections/ 폴더가 없습니다. schema.bat 를 먼저 실행하세요.
pause
exit /b 1

:no_index
echo [!] index.md 가 없습니다. schema.bat 를 먼저 실행하세요.
pause
exit /b 1

:run
call npm run erd
pause
