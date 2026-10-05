@echo off
rem Brings the renderer's WSL copy /root/avtr-1 up to date with this git checkout of
rem live_avatar, so the renderer always runs what git has. Called by boot.bat and by the
rem backend's sync-repo action. When pixi.lock changed, it updates the pixi environment.
rem Distro: JARVIS_WSL_DISTRO, else the first of Ubuntu / Ubuntu-24.04 / Ubuntu-22.04 that has /root/avtr-1.
setlocal
cd /d "%~dp0.."

set "DISTRO=%JARVIS_WSL_DISTRO%"
for %%D in (Ubuntu Ubuntu-24.04 Ubuntu-22.04) do if not defined DISTRO if exist "\\wsl.localhost\%%D\root\avtr-1" set "DISTRO=%%D"
if not defined DISTRO goto :none
set "AVTR_DIR=\\wsl.localhost\%DISTRO%\root\avtr-1"
if not exist "%AVTR_DIR%" goto :none

echo ^> Syncing live_avatar into WSL %DISTRO% /root/avtr-1...
set "DEPS_CHANGED=0"
fc /b live_avatar\pixi.lock "%AVTR_DIR%\pixi.lock" >nul 2>&1 || set "DEPS_CHANGED=1"

rem Everything git tracks, except what lives only in WSL: the pixi env, models, caches, logs.
robocopy live_avatar "%AVTR_DIR%" /E /XD .pixi artifacts .ruff_cache __pycache__ .pytest_cache /XF .env *.log /NP /NFL /NDL /NJH /NJS /R:1 /W:1 >nul
if errorlevel 8 goto :copy_failed
rem Code is mirrored, so files deleted in git are deleted in WSL too - excluded dirs are kept.
robocopy live_avatar\src "%AVTR_DIR%\src" /MIR /XD __pycache__ *.egg-info /NP /NFL /NDL /NJH /NJS /R:1 /W:1 >nul
if errorlevel 8 goto :copy_failed
if exist .env copy /Y .env "%AVTR_DIR%\.env" >nul 2>&1
rem Built-in avatar portraits from git; avatars created on this server are kept.
robocopy live_avatar\avatars "%AVTR_DIR%\artifacts\main\avatars_artifacts\reference_frames" *.png /NP /NFL /NDL /NJH /NJS /R:1 /W:1 >nul
rem AVTR-1's own portraits from Hugging Face - Maria and co - that this renderer lacks.
rem The repo is gated: needs HF_TOKEN in .env. Never fails the boot.
wsl -d %DISTRO% -u root -e bash -lc "cd /root/avtr-1 && test -x .pixi/envs/default/bin/python && .pixi/envs/default/bin/python scripts/fetch_avatar_portraits.py"

if not "%DEPS_CHANGED%"=="1" goto :done
echo ^> pixi.lock changed - updating the renderer environment in WSL %DISTRO%, this can take a while...
wsl -d %DISTRO% -u root -e bash -lc "cd /root/avtr-1 && $HOME/.pixi/bin/pixi install"
if errorlevel 1 echo ^> WARNING: pixi install failed in WSL %DISTRO% - the renderer may not start. Run it by hand to see why.
goto :done

:copy_failed
echo ^> WARNING: copying live_avatar into WSL %DISTRO% failed - the renderer keeps its previous code.
exit /b 1
:none
echo ^> No WSL distro with /root/avtr-1 - nothing to sync. See live_avatar\setup_avatar_windows.bat.
exit /b 0
:done
echo ^> WSL avtr-1 is up to date with git.
exit /b 0
