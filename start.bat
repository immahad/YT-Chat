@echo off
title YT Chat — RAG Backend Server
color 0a

echo.
echo  ============================================
echo    YT Chat - AI YouTube Video Assistant
echo    RAG Backend Server
echo  ============================================
echo.

:: Check if Python is installed
python --version >nul 2>&1
if errorlevel 1 (
    echo  [ERROR] Python not found. Please install Python 3.10+
    pause
    exit /b 1
)

:: Navigate to backend directory
cd /d "%~dp0backend"

:: Install dependencies if venv doesn't exist
if not exist ".venv" (
    echo  [SETUP] Creating virtual environment...
    python -m venv .venv
    echo  [SETUP] Installing dependencies (this may take a few minutes)...
    .venv\Scripts\pip install -r requirements.txt --quiet
    echo  [SETUP] Setup complete!
    echo.
)

:: Activate venv
call .venv\Scripts\activate.bat

:: Copy .env if not exists
if not exist ".env" (
    if exist ".env.example" (
        copy .env.example .env >nul
        echo  [CONFIG] Created .env file. Please edit it with your API keys!
        echo  [CONFIG] File location: %~dp0backend\.env
        echo.
        notepad .env
    )
)

echo  [INFO] Starting YT Chat server on http://localhost:8000
echo  [INFO] Press Ctrl+C to stop
echo.

python main.py

pause
