@echo off
@chcp 65001 >nul
setlocal enabledelayedexpansion

rem Ensure we are in the project directory
cd /d "%~dp0"

set "REPO_URL=https://github.com/nekomoti0708/musicrunner-v2.git"

rem Resolve Git executable
set "GIT_EXE=git"
if exist "%ProgramFiles%\Git\cmd\git.exe" set "GIT_EXE=%ProgramFiles%\Git\cmd\git.exe"
if exist "%LocalAppData%\Programs\Git\cmd\git.exe" set "GIT_EXE=%LocalAppData%\Programs\Git\cmd\git.exe"

"%GIT_EXE%" --version >nul 2>&1
if errorlevel 1 (
    echo [ERROR] Git is not found. Install Git for Windows or add it to PATH.
    pause
    exit /b 1
)

if not exist ".git" (
    echo Initializing git repository...
    "%GIT_EXE%" init -b main
    if errorlevel 1 exit /b 1
)

rem Remote settings
"%GIT_EXE%" remote get-url origin >nul 2>&1
if errorlevel 1 (
    "%GIT_EXE%" remote add origin "%REPO_URL%"
) else (
    "%GIT_EXE%" remote set-url origin "%REPO_URL%"
)

rem User info configuration
"%GIT_EXE%" config user.name >nul 2>&1
if errorlevel 1 "%GIT_EXE%" config user.name "nekomoti0708"

"%GIT_EXE%" config user.email >nul 2>&1
if errorlevel 1 "%GIT_EXE%" config user.email "autogit@local"

rem Get timestamp
for /f "tokens=*" %%i in ('powershell -NoProfile -Command "Get-Date -Format \"yyyy-MM-dd HH:mm:ss\""') do set "TIMESTAMP=%%i"

echo.
echo ==============================================================
echo  [Step 1] Source code commit and push (main branch)
echo ==============================================================

set "HAS_CHANGES="
for /f %%i in ('"%GIT_EXE%" status --porcelain 2^>nul') do set "HAS_CHANGES=1"

if not defined HAS_CHANGES (
    echo No changes in working tree for main branch.
    goto :run_build
)

echo Staging all changes...
"%GIT_EXE%" add --all
if errorlevel 1 (
    echo [ERROR] git add failed.
    pause
    exit /b 1
)

echo Committing...
"%GIT_EXE%" commit -m "Auto commit %TIMESTAMP%"
if errorlevel 1 (
    echo [ERROR] git commit failed.
    pause
    exit /b 1
)

echo Pushing to main branch...
"%GIT_EXE%" push --set-upstream origin main
if errorlevel 1 (
    echo [ERROR] Push to main failed. Check authentication and network.
    pause
    exit /b 1
)
echo [OK] main branch updated successfully.

:run_build
echo.
echo ==============================================================
echo  [Step 2] Minify and Deploy to GitHub Pages (gh-pages branch)
echo ==============================================================

where node >nul 2>&1
if errorlevel 1 (
    echo [INFO] Node.js is not found. Minified gh-pages deploy skipped.
    goto :finish
)

if not exist "build_minify.js" (
    echo [WARN] build_minify.js not found.
    goto :finish
)

rem Clean previous dist folder if left
if exist ".dist_build" rmdir /s /q ".dist_build"

rem Run minify build
node build_minify.js
if errorlevel 1 (
    echo [WARN] Build failed.
    if exist ".dist_build" rmdir /s /q ".dist_build"
    goto :finish
)

if not exist ".dist_build" (
    echo [WARN] .dist_build folder does not exist.
    goto :finish
)

echo Deploying minified build to gh-pages branch...
pushd ".dist_build"
"%GIT_EXE%" init -b gh-pages >nul 2>&1
"%GIT_EXE%" config user.name "nekomoti0708"
"%GIT_EXE%" config user.email "autogit@local"
"%GIT_EXE%" remote add origin "%REPO_URL%" >nul 2>&1
"%GIT_EXE%" add --all
"%GIT_EXE%" commit -m "Deploy minified build %TIMESTAMP%" >nul 2>&1
"%GIT_EXE%" push --force origin gh-pages
set "PUSH_STATUS=%ERRORLEVEL%"
popd

if exist ".dist_build" rmdir /s /q ".dist_build"

if %PUSH_STATUS% equ 0 (
    echo [OK] Minified build deployed to gh-pages branch successfully!
) else (
    echo [WARN] Failed to push to gh-pages branch.
)

:finish
echo.
echo ==============================================================
echo  Done! Everything completed.
echo ==============================================================
endlocal
