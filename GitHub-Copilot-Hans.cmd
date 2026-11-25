@echo off
chcp 65001 >nul
where node >nul 2>nul
if errorlevel 1 (
  echo 未找到 Node.js，请先安装 Node.js 22 或更高版本：https://nodejs.org/
  pause
  exit /b 1
)
node "%~dp0src\cli.mjs" %*
if "%~1"=="" pause
