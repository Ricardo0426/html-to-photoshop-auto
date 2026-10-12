@echo off
chcp 936 >nul
setlocal EnableExtensions
title HTML 自动分组导入 - 本地渲染服务
cd /d "%~dp0"

rem 先把 node 解析成绝对路径，后面就能从同一目录取 npm.cmd，
rem 避免命中 PATH 里无扩展名的 npm（那是给 Git Bash 用的 sh 脚本，cmd 跑不了）。
set "NODE="
for /f "delims=" %%I in ('where node 2^>nul') do if not defined NODE set "NODE=%%I"
if not defined NODE if exist "%ProgramFiles%\nodejs\node.exe" set "NODE=%ProgramFiles%\nodejs\node.exe"
if not defined NODE if exist "%ProgramFiles(x86)%\nodejs\node.exe" set "NODE=%ProgramFiles(x86)%\nodejs\node.exe"
if not defined NODE if exist "%LOCALAPPDATA%\Programs\nodejs\node.exe" set "NODE=%LOCALAPPDATA%\Programs\nodejs\node.exe"

if not defined NODE goto :no_node

"%NODE%" -e "process.exit(Number(process.versions.node.split('.')[0]) >= 20 ? 0 : 1)"
if errorlevel 1 goto :old_node

if exist "node_modules\playwright\package.json" goto :run

set "NPM="
for %%I in ("%NODE%") do if exist "%%~dpInpm.cmd" set "NPM=%%~dpInpm.cmd"
if not defined NPM if exist "%ProgramFiles%\nodejs\npm.cmd" set "NPM=%ProgramFiles%\nodejs\npm.cmd"
if not defined NPM if exist "%ProgramFiles(x86)%\nodejs\npm.cmd" set "NPM=%ProgramFiles(x86)%\nodejs\npm.cmd"
if not defined NPM if exist "%LOCALAPPDATA%\Programs\nodejs\npm.cmd" set "NPM=%LOCALAPPDATA%\Programs\nodejs\npm.cmd"
if not defined NPM where npm.cmd >nul 2>nul
if not defined NPM if not errorlevel 1 set "NPM=npm.cmd"

if not defined NPM goto :no_npm

echo.
echo   正在准备本地渲染依赖，首次启动需要联网下载，请稍候……
echo.

call "%NPM%" ci --omit=dev
if errorlevel 1 (
  echo.
  echo   连接 npm 官方源失败，改用国内镜像重试……
  echo.
  call "%NPM%" ci --omit=dev --registry=https://registry.npmmirror.com
)
if errorlevel 1 goto :deps_failed

:run
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
exit /b 0

:no_node
echo.
echo   [错误] 没有找到 Node.js。
echo   本插件需要 Node.js 20 或更新版本。
echo   请到 https://nodejs.org 下载安装，安装时保持默认选项，然后重新双击本文件。
echo.
pause
exit /b 1

:old_node
echo.
echo   [错误] 当前 Node.js 版本过旧，请升级到 20 或更新版本。
echo.
pause
exit /b 1

:no_npm
echo.
echo   [错误] 找到了 Node.js，但没有找到 npm。
echo   npm 通常与 Node.js 装在同一个目录。请重新安装 Node.js，
echo   安装时保持默认选项，然后重新双击本文件。
echo.
pause
exit /b 1

:deps_failed
echo.
echo   [错误] 依赖安装失败，请检查网络后重新双击本文件。
echo   如果公司网络限制访问 npm，可手动执行下面两行后重试：
echo       "%NPM%" config set registry https://registry.npmmirror.com
echo       "%NPM%" ci --omit=dev
echo.
pause
exit /b 1
