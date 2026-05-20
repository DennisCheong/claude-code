@echo off
setlocal

cd /d "%~dp0"

where bun >nul 2>nul
if errorlevel 1 (
  echo bun is required but was not found in PATH.
  exit /b 1
)

call bun install --frozen-lockfile
if errorlevel 1 exit /b 1

call bun run build
if errorlevel 1 exit /b 1

if exist "claude-config.json" copy /Y "claude-config.json" "dist\claude-config.json" >nul

echo Build complete: %CD%\dist\cli.mjs