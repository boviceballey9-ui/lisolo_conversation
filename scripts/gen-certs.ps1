# Génère le certificat HTTPS local avec mkcert, pour localhost, 127.0.0.1 et l'IP Wi-Fi du PC.
#
#   powershell -ExecutionPolicy Bypass -File scripts\gen-certs.ps1            # IP détectée automatiquement
#   powershell -ExecutionPolicy Bypass -File scripts\gen-certs.ps1 -Ip 192.168.1.42
#
# Les fichiers produits (nginx\certs\cert.pem et key.pem) ne sont JAMAIS commités (.gitignore).
# À relancer si l'IP du PC change (puis : docker compose restart nginx).

param([string]$Ip)

$ErrorActionPreference = "Stop"

if (-not (Get-Command mkcert -ErrorAction SilentlyContinue)) {
    throw "mkcert introuvable. Installez-le : winget install FiloSottile.mkcert, puis : mkcert -install"
}

if (-not $Ip) {
    # L'interface qui porte la passerelle par défaut = celle qui sort sur le réseau (Wi-Fi ou pont).
    $Ip = (Get-NetIPConfiguration | Where-Object { $_.IPv4DefaultGateway } | Select-Object -First 1).IPv4Address.IPAddress
    if (-not $Ip) { throw "IP locale introuvable : passez-la avec -Ip" }
}

$certs = Join-Path $PSScriptRoot "..\nginx\certs"
New-Item -ItemType Directory -Force $certs | Out-Null

mkcert -cert-file (Join-Path $certs "cert.pem") -key-file (Join-Path $certs "key.pem") localhost 127.0.0.1 ::1 $Ip
if ($LASTEXITCODE -ne 0) { throw "mkcert a échoué" }

Write-Host ""
Write-Host "Certificat créé pour : localhost, 127.0.0.1, ::1, $Ip"
Write-Host "Pensez à mettre cette IP dans .env (TURN_EXTERNAL_IP, TURN_HOST, CORS_ORIGINS)."
Write-Host "Certificat racine à installer sur un téléphone : $(mkcert -CAROOT)\rootCA.pem (JAMAIS rootCA-key.pem)"
