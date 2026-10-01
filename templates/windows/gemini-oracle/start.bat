@echo off
chcp 65001 >nul: 2>nul:
cd /d "%~dp0"
:: gemini-oracle — 서버 시작

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
call npm start
pause
