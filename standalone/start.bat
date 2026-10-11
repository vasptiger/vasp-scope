@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo ============================================================
echo   VASP 任务面板 - 独立版启动器
echo ============================================================

where node >nul 2>nul
if errorlevel 1 (
  echo [错误] 未找到 node 命令。
  echo        请先安装 Node.js 18 或更高版本： https://nodejs.org/
  echo.
  pause
  exit /b 1
)

if not exist "config.json" (
  echo [提示] 没找到 config.json，正在从 config.example.json 复制一份...
  copy /y "config.example.json" "config.json" >nul
  echo [提示] 请用记事本打开 config.json，填好 sshHost 与 roots，
  echo        保存后再次双击本脚本启动。
  echo.
  notepad "config.json"
  pause
  exit /b 0
)

echo [1/2] 检查 ssh 是否可用...
where ssh >nul 2>nul
if errorlevel 1 (
  echo [警告] 没找到 ssh 命令。Windows 10/11 可在“设置 - 应用 - 可选功能”里安装 "OpenSSH 客户端"。
) else (
  echo       ssh 可用
)

echo [2/2] 启动本地服务并打开浏览器...
start "" http://127.0.0.1:8787/
node server.js

echo.
echo 服务已停止。
pause
