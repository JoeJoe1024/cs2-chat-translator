@echo off
title CS2 Chat Translator
cd /d "%~dp0"
echo Starting CS2 Chat Translator...
echo.
start "CS2 Chat Translator" runtime\node.exe bin/cs2-chat-translator.js
timeout /t 2 /nobreak >nul
start "" "http://127.0.0.1:7420"
echo Browser opened: http://127.0.0.1:7420
echo.
echo To stop the translator, close the "CS2 Chat Translator" window.

