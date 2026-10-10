@echo off
rem Shim: runs the Codex CLI bundled with the Codex desktop app (newest build).
rem Lets "codex" work from any shell, including the Claude Code Codex bridge plugin.
setlocal
set "CODEX_BIN_ROOT=%LOCALAPPDATA%\OpenAI\Codex\bin"
set "CODEX_EXE="
for /f "delims=" %%D in ('dir /b /ad /o-d "%CODEX_BIN_ROOT%" 2^>nul') do (
  if not defined CODEX_EXE if exist "%CODEX_BIN_ROOT%\%%D\codex.exe" set "CODEX_EXE=%CODEX_BIN_ROOT%\%%D\codex.exe"
)
if not defined CODEX_EXE (
  echo codex.exe not found under %CODEX_BIN_ROOT%. Install or update the Codex desktop app. 1>&2
  exit /b 1
)
"%CODEX_EXE%" %*
exit /b %ERRORLEVEL%
