@echo off
node "%~dp0dist\cli.js" settings
if errorlevel 1 pause
