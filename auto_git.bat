@echo off
setlocal

rem Ensure we are in the project directory
cd /d "%~dp0"

rem Check if there are any changes
git diff-index --quiet HEAD --
if %errorlevel% equ 0 (
    echo No changes to commit.
    goto :eof
)

rem Add all changes
git add .

rem Commit with a timestamped message
for /f "tokens=*" %%i in ('powershell -Command "Get-Date -Format \"yyyy-MM-dd HH:mm:ss\""') do set "TIMESTAMP=%%i"
git commit -m "Auto commit %TIMESTAMP%"

rem Push to the remote repository (origin/main)
git push origin main

echo Done.
endlocal
