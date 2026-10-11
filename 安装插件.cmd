@echo off
chcp 936 >nul
setlocal EnableExtensions EnableDelayedExpansion
title HTML 自动分组导入 - 安装

set "SRC=%~dp0plugin"
set "NAME=HTML自动分组导入_v0.1.0"
set "ROOT=%APPDATA%\Adobe\UXP\Plugins\External"
set "DEST=%ROOT%\%NAME%"

echo.
echo   ============================================
echo     HTML 自动分组导入 v0.1.0  安装程序
echo   ============================================
echo.

if not exist "%SRC%\manifest.json" (
    echo   [错误] 没有找到 plugin\manifest.json
    echo.
    echo   请把“安装插件.cmd”和 plugin 文件夹放在同一个目录里再运行。
    echo.
    pause
    exit /b 1
)

tasklist /fi "imagename eq Photoshop.exe" 2>nul | find /i "Photoshop.exe" >nul
if not errorlevel 1 (
    echo   [提示] Photoshop 正在运行。请先完全退出 Photoshop 再安装，
    echo          否则新面板要等下次启动才出现。
    echo.
)

if not exist "%ROOT%" md "%ROOT%" >nul 2>&1
if exist "%DEST%" rd /s /q "%DEST%" >nul 2>&1

xcopy "%SRC%" "%DEST%\" /e /i /q /y >nul 2>&1
if errorlevel 1 (
    echo   [失败] 写入被拒绝，请关闭 Photoshop 后重试。
    echo          目标位置：%DEST%
    echo.
    pause
    exit /b 1
)

echo   [完成] 插件已安装到：
echo          %DEST%
echo.
echo   接下来三步：
echo     1. 完全退出 Photoshop（不是最小化），再重新打开
echo     2. 顶部菜单 - 增效工具 - HTML 自动分组导入
echo     3. 双击本目录的“启动渲染服务.cmd”，保持窗口开着
echo.
echo   卸载请运行同目录的“卸载插件.cmd”。
echo.
pause
exit /b 0
