@echo off
rem Выпуск новой версии. Пример: release.cmd 1.5.0
rem Сам скрипт — release.sh, его выполняет bash из Git for Windows.
chcp 65001 >nul
set "BASH="
for %%d in ("%ProgramFiles%\Git" "%LOCALAPPDATA%\Programs\Git" "%ProgramFiles(x86)%\Git") do (
  if not defined BASH if exist "%%~d\bin\bash.exe" set "BASH=%%~d\bin\bash.exe"
)
if not defined BASH (
  for /f "delims=" %%g in ('where git 2^>nul') do if not defined BASH if exist "%%~dpg..\bin\bash.exe" set "BASH=%%~dpg..\bin\bash.exe"
)
if not defined BASH (
  echo Не найден Git for Windows. Установи его: https://git-scm.com/download/win
  pause
  exit /b 1
)
"%BASH%" "%~dp0release.sh" %*
pause
