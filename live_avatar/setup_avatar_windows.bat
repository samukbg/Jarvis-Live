@echo off
rem Sets up the live avatar on this Windows Jarvis server. Safe to re-run.
rem   1. streamer_win_env - the WebRTC streamer, native Windows, port 7860
rem   2. /root/avtr-1 in WSL - the AVTR-1 GPU renderer, port 8000
rem   3. voice_env - the voice server: XTTS cloned voices on this GPU, port 8010
rem Needs: an NVIDIA driver, WSL with an Ubuntu distro
rem named Ubuntu (or Ubuntu-24.04 / Ubuntu-22.04) - or set JARVIS_WSL_DISTRO - and internet. Python 3.12 is
rem installed with winget when missing.
rem First run also needs a HuggingFace token for the models:  set HF_TOKEN=hf_...
rem Takes 30-60 minutes the first time. Then run boot.bat.
setlocal
cd /d "%~dp0.."

nvidia-smi >nul 2>&1 || goto :no_gpu

call :find_python
if defined PYEXE goto :have_python
where winget >nul 2>&1 || goto :no_py
echo ^> Installing Python 3.12 with winget...
winget install -e --id Python.Python.3.12 --silent --accept-package-agreements --accept-source-agreements
call :find_python
if not defined PYEXE goto :no_py
:have_python
echo ^> Python: %PYEXE%

rem ---- 1. Streamer env on Windows ----
echo ^> 1/3 Streamer environment: streamer_win_env
if not exist streamer_win_env\Scripts\python.exe "%PYEXE%" -m venv streamer_win_env
if not exist streamer_win_env\Scripts\python.exe goto :fail
streamer_win_env\Scripts\python.exe -m pip install --upgrade pip >nul
streamer_win_env\Scripts\python.exe -m pip install fastapi uvicorn numpy pydantic pydantic-settings httpx openai tenacity asyncstdlib typeid-python structlog attrs typer soxr websockets opentelemetry-api aiortc av anyio uuid6 python-dotenv pillow opencv-python-headless soundfile edge-tts
if errorlevel 1 goto :fail

rem ---- 2. Renderer in WSL ----
set "DISTRO=%JARVIS_WSL_DISTRO%"
for %%D in (Ubuntu Ubuntu-24.04 Ubuntu-22.04) do (
  if not defined DISTRO wsl -d %%D -e true >nul 2>&1 && set "DISTRO=%%D"
)
if not defined DISTRO goto :no_wsl
echo ^> 2/3 AVTR-1 renderer in WSL %DISTRO%: /root/avtr-1
robocopy live_avatar "\\wsl.localhost\%DISTRO%\root\avtr-1" /E /XD .pixi artifacts .ruff_cache __pycache__ .pytest_cache /XF .env *.log /NP /NFL /NDL /NJH /NJS /R:1 /W:1 >nul
if errorlevel 8 goto :fail
rem HF_TOKEN goes into WSL with the call; CRs are stripped in case git checked the script out with CRLF.
set "WSLENV=HF_TOKEN/u"
wsl -d %DISTRO% -u root -e bash -c "tr -d '\r' < /root/avtr-1/scripts/setup_renderer_wsl.sh | bash"
if errorlevel 1 goto :fail

rem ---- 3. Voice server - the avatars' cloned voices, XTTS-v2 ----
echo ^> 3/3 Voice server for the avatars' cloned voices: voice_env
call live_avatar\voice_server\setup_voice_server.bat
if errorlevel 1 goto :fail
cd /d "%~dp0.."

echo.
echo Live avatar installed. Run boot.bat to start Jarvis with the avatar.
exit /b 0

rem Python 3.12's python.exe: via the py launcher, or where winget/python.org put it -
rem a fresh install isn't on this window's PATH yet.
:find_python
set "PYEXE="
rem Only a python.exe that exists: py prints its list of Pythons, not a path, when 3.12 is missing.
for /f "delims=" %%P in ('py -3.12 -c "import sys; print(sys.executable)" 2^>nul') do if exist "%%P" set "PYEXE=%%P"
if not defined PYEXE if exist "%LOCALAPPDATA%\Programs\Python\Python312\python.exe" set "PYEXE=%LOCALAPPDATA%\Programs\Python\Python312\python.exe"
if not defined PYEXE if exist "%ProgramFiles%\Python312\python.exe" set "PYEXE=%ProgramFiles%\Python312\python.exe"
exit /b 0

:no_py
echo Python 3.12 not found and winget could not install it. Install Python 3.12 from python.org and run this again.
exit /b 1
:no_gpu
echo nvidia-smi not found: this machine needs an NVIDIA GPU and driver.
exit /b 1
:no_wsl
echo No WSL distro Ubuntu found. Install Ubuntu in WSL, or set JARVIS_WSL_DISTRO=name.
exit /b 1
:fail
echo.
echo Setup failed - see the messages above. Fix the cause and run this again; finished steps are skipped.
exit /b 1
