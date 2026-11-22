@echo off
REM Builds the Windows installer of the native app: first the program folder with PyInstaller
REM (dist\wyrmdesk\), then the installer with Inno Setup 6 (dist\packages\Wyrmdesk-Setup-<version>.exe).
REM Needs a venv with ..\backend\requirements.txt, requirements.txt and requirements-build.txt, and
REM Inno Setup 6. Step by step, also for Claude: WINDOWS.md.
setlocal
cd /d "%~dp0"
set /p VERSION=<..\backend\app\VERSION

pyinstaller wyrmdesk.spec --noconfirm
if errorlevel 1 exit /b 1

set "ISCC=%ProgramFiles(x86)%\Inno Setup 6\ISCC.exe"
if not exist "%ISCC%" set "ISCC=%LOCALAPPDATA%\Programs\Inno Setup 6\ISCC.exe"
if not exist "%ISCC%" (
  echo Inno Setup 6 nicht gefunden. Installieren: winget install JRSoftware.InnoSetup
  exit /b 1
)
"%ISCC%" /DAppVersion=%VERSION% windows\wyrmdesk.iss
if errorlevel 1 exit /b 1
echo.
echo Fertig: dist\packages\Wyrmdesk-Setup-%VERSION%.exe
