@echo off
title MKompact
cd /d "%~dp0"
where python >nul 2>nul || (echo No se encontro Python. Instalalo desde https://www.python.org/ & pause & exit /b 1)
python test\server.py 8765 --open
pause
