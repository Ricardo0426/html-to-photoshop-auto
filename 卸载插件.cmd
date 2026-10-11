@echo off
chcp 936 >nul
setlocal EnableExtensions EnableDelayedExpansion
title HTML 自动分组导入 - 卸载

set "NAME=HTML自动分组导入_v0.1.0"
set "ROOT=%APPDATA%\Adobe\UXP\Plugins\External"
set "DEST=%ROOT%\%NAME%"

echo.
echo   ============================================
echo     HTML 自动分组导入 v0.1.0  卸载程序
echo   ============================================
echo.

if not exist "%DEST%" (
    echo   没有找到已安装的插件，无需卸载。
    echo.
    pause
    exit /b 0
)

tasklist /fi "imagename eq Photoshop.exe" 2>nul | find /i "Photoshop.exe" >nul
if not errorlevel 1 (
    echo   [提示] Photoshop 正在运行。请先完全退出 Photoshop 再卸载，
    echo          否则插件文件会被占用而删不掉。
    echo.
    pause
    exit /b 1
)

rd /s /q "%DEST%" >nul 2>&1

if exist "%DEST%" (
    echo   [失败] 删除未完成，请完全退出 Photoshop 后重试。
) else (
    echo   [完成] 插件已卸载。重新打开 Photoshop 后面板将不再出现。
)

echo.
echo   注意：本目录下的渲染服务文件、示例 PSD 和 npm 依赖没有被删除。
echo.
pause
exit /b 0
