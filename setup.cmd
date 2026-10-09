@echo off
rem 语音助手一键安装（Windows）：双击，或者在命令行运行 setup.cmd [-Yes] [-Name 小橘] …
chcp 65001 >nul
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0setup.ps1" %*
if "%~1"=="" pause
