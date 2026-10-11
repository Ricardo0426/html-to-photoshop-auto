@echo off
chcp 936 >nul
setlocal EnableExtensions
title HTML 自动分组导入 - 本地渲染服务
cd /d "%~dp0"

set "NODE="
where node >nul 2>nul
if not errorlevel 1 set "NODE=node"
if not defined NODE if exist "%ProgramFiles%\nodejs\node.exe" set "NODE=%ProgramFiles%\nodejs\node.exe"
if not defined NODE if exist "%ProgramFiles(x86)%\nodejs\node.exe" set "NODE=%ProgramFiles(x86)%\nodejs\node.exe"
if not defined NODE if exist "%LOCALAPPDATA%\Programs\nodejs\node.exe" set "NODE=%LOCALAPPDATA%\Programs\nodejs\node.exe"

if not defined NODE (
  echo.
  echo   [错误] 没有找到 Node.js。
  echo   本插件需要 Node.js 20 或更新版本。
  echo   请到 https://nodejs.org 下载安装，安装时保持默认选项，然后重新双击本文件。
  echo.
  pause
  exit /b 1
)

"%NODE%" -e "process.exit(Number(process.versions.node.split('.')[0]) >= 20 ? 0 : 1)"
if errorlevel 1 (
  echo.
  echo   [错误] 当前 Node.js 版本过旧，请升级到 20 或更新版本。
  echo.
  pause
  exit /b 1
)

if not exist "node_modules\playwright\package.json" (
  echo.
  echo   正在准备本地渲染依赖，首次启动需要联网下载，请稍候……
  call npm ci --omit=dev
  if errorlevel 1 (
    echo.
    echo   [错误] 依赖安装失败。请检查网络后重新双击本文件。
    echo.
    pause
    exit /b 1
  )
)

echo.
echo   ============================================
echo     HTML 自动分组导入 - 本地渲染服务
echo   ============================================
echo.
echo   保持本窗口开着，关闭窗口即停止服务。
echo   回到 Photoshop，在“增效工具 - HTML 自动分组导入”里点“重新连接”。
echo.

"%NODE%" src\server.mjs

echo.
echo   服务已停止，可以关闭本窗口。
pause
