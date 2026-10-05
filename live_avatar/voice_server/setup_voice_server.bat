@echo off
rem Sets up the Jarvis voice server (XTTS-v2 on this machine's NVIDIA GPU) in voice_env.
rem Needs: Python 3.10 to 3.12 - py launcher, or PYEXE set by setup_avatar_windows.bat -
rem an NVIDIA driver, internet. Run from anywhere.
cd /d "%~dp0..\.."
rem A python.exe that exists - py prints its list of Pythons, not a path, when a version is missing.
if defined PYEXE if not exist "%PYEXE%" set "PYEXE="
for %%V in (3.11 3.12 3.10) do if not defined PYEXE for /f "delims=" %%P in ('py -%%V -c "import sys; print(sys.executable)" 2^>nul') do if exist "%%P" set "PYEXE=%%P"
for %%V in (311 312 310) do if not defined PYEXE if exist "%LOCALAPPDATA%\Programs\Python\Python%%V\python.exe" set "PYEXE=%LOCALAPPDATA%\Programs\Python\Python%%V\python.exe"
for %%V in (311 312 310) do if not defined PYEXE if exist "%ProgramFiles%\Python%%V\python.exe" set "PYEXE=%ProgramFiles%\Python%%V\python.exe"
if not defined PYEXE goto :no_py
echo ^> Python: %PYEXE%
nvidia-smi >nul 2>&1 || (echo nvidia-smi not found: this machine needs an NVIDIA GPU and driver & exit /b 1)
if not exist voice_env\Scripts\python.exe "%PYEXE%" -m venv voice_env || exit /b 1
voice_env\Scripts\python.exe -m pip install --upgrade pip
voice_env\Scripts\python.exe -m pip install torch torchaudio --index-url https://download.pytorch.org/whl/cu124 || exit /b 1
rem coqui-tts does not cap transformers, and transformers 5 removed what XTTS imports: pin 4.x.
voice_env\Scripts\python.exe -m pip install "coqui-tts==0.27.5" "transformers>=4.57,<5" fastapi uvicorn numpy || exit /b 1
set COQUI_TOS_AGREED=1
echo Downloading the XTTS-v2 model (about 2 GB)...
voice_env\Scripts\python.exe -c "from TTS.utils.manage import ModelManager; ModelManager().download_model('tts_models/multilingual/multi-dataset/xtts_v2')" || exit /b 1
voice_env\Scripts\python.exe -c "import torch; print('CUDA available:', torch.cuda.is_available(), torch.cuda.get_device_name(0) if torch.cuda.is_available() else '')"
echo.
echo Done. boot.bat now starts the voice server (port 8010) on this machine.
exit /b 0

:no_py
echo Python 3.10 to 3.12 not found: install Python 3.12 from python.org and run this again.
exit /b 1
