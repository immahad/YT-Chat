@echo off
REM ─────────────────────────────────────────────────────────────
REM  YT Chat Backend — Start Script
REM  Requires Python 3.11 (py -3.11 must be available)
REM ─────────────────────────────────────────────────────────────

echo [YT Chat] Starting backend...

REM Create venv with Python 3.11 if it doesn't exist
if not exist ".venv\Scripts\python.exe" (
    echo [YT Chat] Creating Python 3.11 virtual environment...
    py -3.11 -m venv .venv
    if errorlevel 1 (
        echo [ERROR] Python 3.11 not found. Please install from https://python.org
        pause
        exit /b 1
    )
)

REM Install / upgrade dependencies
echo [YT Chat] Installing dependencies...
.venv\Scripts\pip install -q -r requirements.txt

REM Copy .env.example to .env if not present
if not exist ".env" (
    echo [YT Chat] Creating .env from template...
    copy .env.example .env
    echo [YT Chat] Please edit .env and add your Google API key, then restart.
    notepad .env
    pause
)

REM Create storage directory
if not exist "storage\chroma_db" mkdir storage\chroma_db

REM Start the server
echo [YT Chat] Starting FastAPI server on http://localhost:8000
echo [YT Chat] Press Ctrl+C to stop.
.venv\Scripts\python -m uvicorn main:app --host localhost --port 8000 --reload

pause
