@echo off
rem Double-click to play ReLive: starts the world server and opens the game in your default browser.
rem Friends on the same Wi-Fi: run "Play ReLive.cmd -Lan" once as administrator, then they open http://<this PC's IP>:8799/
rem Keep the black window open while you play; close it to stop the server. The world is saved in data\world.txt.
title ReLive server
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0server\relive-server.ps1" -Open %*
