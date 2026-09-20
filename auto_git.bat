@echo off
setlocal

rem Ensure we are in the project directory
cd /d "%~dp0"

set "REPO_URL=https://github.com/nekomoti0708/musicrunner-v2.git"

rem Resolve Git even when it is not in the PATH used by this batch file
set "GIT_EXE=git"
if exist "%ProgramFiles%\Git\cmd\git.exe" set "GIT_EXE=%ProgramFiles%\Git\cmd\git.exe"
if exist "%LocalAppData%\Programs\Git\cmd\git.exe" set "GIT_EXE=%LocalAppData%\Programs\Git\cmd\git.exe"

"%GIT_EXE%" --version >nul 2>&1
if errorlevel 1 (
    echo Git was not found. Install Git for Windows or add it to PATH.
    exit /b 1
)

if not exist ".git" (
    echo Repository not initialized yet. Initializing...
    "%GIT_EXE%" init -b main
    if errorlevel 1 exit /b 1
)

"%GIT_EXE%" remote get-url origin >nul 2>&1
if errorlevel 1 (
    "%GIT_EXE%" remote add origin "%REPO_URL%"
) else (
    "%GIT_EXE%" remote set-url origin "%REPO_URL%"
)

"%GIT_EXE%" config user.name >nul 2>&1
if errorlevel 1 "%GIT_EXE%" config user.name "nekomoti0708"

"%GIT_EXE%" config user.email >nul 2>&1
if errorlevel 1 "%GIT_EXE%" config user.email "autogit@local"

rem Check if there are any changes to commit
for /f %%i in ('"%GIT_EXE%" status --porcelain 2^>nul') do set "HAS_CHANGES=1"
if not defined HAS_CHANGES (
    echo No changes to commit.
    goto :eof
)

rem Add all changes
"%GIT_EXE%" add --all
if errorlevel 1 exit /b 1

rem Commit with a timestamped message
for /f "tokens=*" %%i in ('powershell -NoProfile -Command "Get-Date -Format \"yyyy-MM-dd HH:mm:ss\""') do set "TIMESTAMP=%%i"
"%GIT_EXE%" commit -m "Auto commit %TIMESTAMP%"
if errorlevel 1 exit /b 1

rem Push to the remote repository
"%GIT_EXE%" push --set-upstream origin main
if errorlevel 1 (
    echo Push failed. Check your GitHub authentication and network connection.
    exit /b 1
)

echo Done.
endlocal
