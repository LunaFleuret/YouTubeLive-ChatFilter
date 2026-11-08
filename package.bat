@echo off
setlocal

echo ===================================================
echo Packaging YouTube Live Chat Filter for Distribution
echo ===================================================

set "SRC_DIR=extension"
set "OUTPUT_DIR=dist"
set "ZIP_NAME=youtube-live-chat-filter.zip"

if not exist "%SRC_DIR%" (
    echo Error: "%SRC_DIR%" directory not found.
    exit /b 1
)

if exist "%OUTPUT_DIR%" rmdir /s /q "%OUTPUT_DIR%"
mkdir "%OUTPUT_DIR%"

echo Creating ZIP archive from %SRC_DIR%...
powershell -NoProfile -Command "Compress-Archive -Path '%SRC_DIR%\*' -DestinationPath '%OUTPUT_DIR%\%ZIP_NAME%' -Force"

if exist "%OUTPUT_DIR%\%ZIP_NAME%" (
    echo Successfully generated: %OUTPUT_DIR%\%ZIP_NAME%
) else (
    echo Failed to create package archive.
)

echo Done.
endlocal
