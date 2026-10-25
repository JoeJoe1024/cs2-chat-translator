@echo off
rem CS2 Chat Translator - one-click launcher (double-click to start).
rem This file is deliberately ASCII-only: all Chinese text is printed by the Node launcher or read from
rem scripts\messages\*.txt (UTF-8) after switching the console to code page 65001, so Chinese / spaced /
rem special-character folder names cannot break the batch parser. Do not add parenthesised blocks that
rem expand paths: a path such as "C:\Program Files (x86)\..." would close them early.
setlocal EnableExtensions
chcp 65001 >nul
title CS2 Chat Translator
cd /d "%~dp0"
set "ROOT=%~dp0"
set "NODE="

rem Portable release: bundled runtime. Development: Node.js from PATH.
if exist "%ROOT%runtime\node.exe" set "NODE=%ROOT%runtime\node.exe"
if not defined NODE for /f "delims=" %%I in ('where node 2^>nul') do if not defined NODE set "NODE=%%I"
if not defined NODE goto :no_node

if not exist "%ROOT%dist\launcher.mjs" goto :not_built

"%NODE%" "%ROOT%dist\launcher.mjs"
if errorlevel 1 goto :fail
exit /b 0

:no_node
type "%ROOT%scripts\messages\no-node.txt"
goto :fail
:not_built
type "%ROOT%scripts\messages\not-built.txt"
goto :fail

:fail
echo.
echo ----------------------------------------
pause
exit /b 1
