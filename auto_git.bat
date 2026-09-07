@echo off
setlocal

rem Ensure we are in the project directory
cd /d "%~dp0"

rem Resolve Git even when it is not in the PATH used by this batch file
set "GIT_EXE=git"
if exist "%ProgramFiles%\Git\cmd\git.exe" set "GIT_EXE=%ProgramFiles%\Git\cmd\git.exe"
if exist "%LocalAppData%\Programs\Git\cmd\git.exe" set "GIT_EXE=%LocalAppData%\Programs\Git\cmd\git.exe"

"%GIT_EXE%" --version >nul 2>&1
if errorlevel 1 (
    echo Git was not found. Install Git for Windows or add it to PATH.
    exit /b 1
)

rem Check if there are any changes
"%GIT_EXE%" diff-index --quiet HEAD --
if %errorlevel% equ 0 (
    echo No changes to commit.
    goto :eof
)

rem Add all changes
"%GIT_EXE%" add .
if errorlevel 1 exit /b 1

rem Commit with a timestamped message
for /f "tokens=*" %%i in ('powershell -Command "Get-Date -Format \"yyyy-MM-dd HH:mm:ss\""') do set "TIMESTAMP=%%i"
"%GIT_EXE%" commit -m "Auto commit %TIMESTAMP%"
if errorlevel 1 exit /b 1

rem Push to the remote repository (origin/main)
"%GIT_EXE%" push origin main
if errorlevel 1 (
    echo Push failed. Check your GitHub authentication and network connection.
    exit /b 1
)

echo Done.
endlocal
