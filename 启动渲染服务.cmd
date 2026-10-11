@echo off
chcp 65001 >nul
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo 未找到 Node.js。请先安装 Node.js 20 或更新版本。
  pause
  exit /b 1
)
node -e "process.exit(Number(process.versions.node.split('.')[0]) >= 20 ? 0 : 1)"
if errorlevel 1 (
  echo 当前 Node.js 版本过旧，请安装 Node.js 20 或更新版本。
  pause
  exit /b 1
)
if not exist "node_modules\playwright\package.json" (
  echo 正在准备本地渲染依赖，首次启动需要联网下载 npm 包。
  call npm ci --omit=dev
  if errorlevel 1 (
    pause
    exit /b 1
  )
)
node src\server.mjs
pause
