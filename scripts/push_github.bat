@echo off
REM ============================================================
REM  DDToolkit 推送到 GitHub（网络不稳时重试版）
REM
REM  用法 A(推荐, token 不落盘):  先设置环境变量再运行
REM      set GITHUB_TOKEN=ghp_xxx
REM      scripts\push_github.bat
REM
REM  用法 B(命令行参数):  scripts\push_github.bat ghp_xxx
REM      (注意: token 会出现在命令行历史, 不推荐)
REM
REM  前置:  1) 网络可达 github.com(浏览器能打开仓库页即可)
REM          2) PAT 已勾选 repo 权限(classic token)
REM  说明:  本脚本不修改全局 git 配置; 每次用 -c 覆盖代理/TLS 参数,
REM          token 优先从 %1 读取, 其次 %GITHUB_TOKEN%。网络抖动自动重试 5 次。
REM ============================================================
setlocal EnableDelayedExpansion

set "REPO=https://github.com/Mrslippe/DDToolkit.git"
set "BRANCH=main"

REM 读取 token: 命令行参数 %1 > 环境变量 GITHUB_TOKEN
set "TOKEN="
if not "%~1"=="" set "TOKEN=%~1"
if "%TOKEN%"=="" if not "%GITHUB_TOKEN%"=="" set "TOKEN=%GITHUB_TOKEN%"

if "%TOKEN%"=="" (
    echo [错误] 未提供 token。请先 set GITHUB_TOKEN=ghp_xxx 再运行, 或作为参数传入。
    echo 示例: set GITHUB_TOKEN=ghp_xxx ^&^& scripts\push_github.bat
    exit /b 1
)

set "URL=https://x-access-token:%TOKEN%@github.com/Mrslippe/DDToolkit.git"

echo [1/4] 验证远程连接(openssl 后端 + 禁代理 + 免证书校验)...
set /a attempt=1
:retry
git -c http.proxy= -c https.proxy= -c http.sslBackend=openssl -c http.sslVerify=false ls-remote "%URL%" >nul 2>&1
if %errorlevel%==0 goto ok
echo   第 !attempt! 次失败, 4 秒后重试...
timeout /t 4 /nobreak >nul
set /a attempt+=1
if %attempt% leq 5 goto retry
echo.
echo [错误] 连续 5 次连接失败: 网络不通或 token 无权限。
echo 请确认: 1) 浏览器能打开 https://github.com/Mrslippe/DDToolkit
echo         2) token 有效且勾选了 repo 权限 (Settings - Developer settings - PAT)
echo         3) 代理软件已启动或本机可直连
exit /b 1

:ok
echo [2/4] 连接成功。
echo [3/4] 推送 %BRANCH% 分支(代码已全部在本地 main 待推)...
git -c http.proxy= -c https.proxy= -c http.sslBackend=openssl -c http.sslVerify=false push "%URL%" %BRANCH%
if %errorlevel%==0 (
    echo.
    echo [4/4] ============ 推送成功 ============
    echo   仓库: https://github.com/Mrslippe/DDToolkit
    echo   分支: %BRANCH%
    echo   提示: 推送完成后请在 GitHub 上吊销本次 PAT(两次 token 均已在对话中出现)。
) else (
    echo.
    echo [错误] 推送失败(网络抖动可重试本脚本; 若报 403/auth failed 则是 token 权限问题)。
)
exit /b %errorlevel%
