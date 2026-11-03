@echo off
rem Выпуск новой версии. Пример: release.cmd 1.5.0
chcp 65001 >nul
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0release.ps1" %*
pause
