$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath (Split-Path -Parent $PSScriptRoot)
if (-not (Test-Path -LiteralPath 'storage/local-voice/Scripts/python.exe')) {
    python -m venv storage/local-voice
    if ($LASTEXITCODE -ne 0) { throw 'Python venv creation failed' }
}
& storage/local-voice/Scripts/python.exe -m pip install piper-tts==1.3.0
if ($LASTEXITCODE -ne 0) { throw 'Piper installation failed' }
New-Item -ItemType Directory -Force storage/models | Out-Null
& storage/local-voice/Scripts/python.exe -m piper.download_voices vi_VN-vais1000-medium --download-dir storage/models
if ($LASTEXITCODE -ne 0) { throw 'Vietnamese model download failed' }
Invoke-WebRequest -Uri 'https://huggingface.co/rhasspy/piper-voices/resolve/main/vi/vi_VN/vais1000/medium/MODEL_CARD' -OutFile storage/models/vi_VN-vais1000-MODEL_CARD.txt
Write-Output 'Local voice ready. Review the retained model card in storage/models.'
