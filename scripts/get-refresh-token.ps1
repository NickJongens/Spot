param(
  [string]$ClientId,
  [string]$ClientSecret,
  [string]$Scopes = "user-read-currently-playing user-read-playback-state",
  [string]$RedirectUri = "http://127.0.0.1:8888/callback/"
)

$ErrorActionPreference = "Stop"

function Ensure-TrailingSlash {
  param([string]$Value)
  if ($Value.EndsWith("/")) { return $Value }
  return "$Value/"
}

function Get-RequiredInput {
  param(
    [string]$CurrentValue,
    [string]$Prompt
  )
  if (-not [string]::IsNullOrWhiteSpace($CurrentValue)) {
    return $CurrentValue
  }
  return (Read-Host $Prompt).Trim()
}

try {
  $ClientId = Get-RequiredInput -CurrentValue $ClientId -Prompt "Enter Spotify Client ID"
  $ClientSecret = Get-RequiredInput -CurrentValue $ClientSecret -Prompt "Enter Spotify Client Secret"
  $RedirectUri = Ensure-TrailingSlash $RedirectUri

  if ([string]::IsNullOrWhiteSpace($ClientId) -or [string]::IsNullOrWhiteSpace($ClientSecret)) {
    throw "Client ID and Client Secret are required."
  }

  Write-Host ""
  Write-Host "Spotify app setup required before continuing:" -ForegroundColor Yellow
  Write-Host "1) Open https://developer.spotify.com/dashboard"
  Write-Host "2) Create app (or open existing app)"
  Write-Host "3) In Redirect URIs add EXACTLY: $RedirectUri"
  Write-Host "4) Save settings"
  Write-Host ""

  $ready = (Read-Host "Type YES when redirect URI is saved").Trim()
  if ($ready -ne "YES") {
    throw "Stopped. Please set redirect URI first."
  }

  $encodedRedirect = [uri]::EscapeDataString($RedirectUri)
  $encodedScopes = [uri]::EscapeDataString($Scopes)
  $authorizeUrl = "https://accounts.spotify.com/authorize?response_type=code&client_id=$ClientId&scope=$encodedScopes&redirect_uri=$encodedRedirect"

  $listener = [System.Net.HttpListener]::new()
  $listener.Prefixes.Add($RedirectUri)
  $listener.Start()

  Write-Host ""
  Write-Host "Opening Spotify authorization page in your browser..." -ForegroundColor Cyan
  Start-Process $authorizeUrl | Out-Null
  Write-Host "Waiting for Spotify callback (timeout 3 minutes)..." -ForegroundColor Cyan

  $asyncResult = $listener.BeginGetContext($null, $null)
  if (-not $asyncResult.AsyncWaitHandle.WaitOne([TimeSpan]::FromMinutes(3))) {
    throw "Timed out waiting for callback. Re-run script and try again."
  }

  $context = $listener.EndGetContext($asyncResult)
  $request = $context.Request
  $response = $context.Response

  $code = $request.QueryString["code"]
  $authError = $request.QueryString["error"]

  $html = ""
  if ($authError) {
    $html = "<html><body><h2>Spotify auth failed</h2><p>Error: $authError</p></body></html>"
  } elseif (-not $code) {
    $html = "<html><body><h2>No code received</h2><p>Try again.</p></body></html>"
  } else {
    $html = "<html><body><h2>Success</h2><p>You can close this tab and return to PowerShell.</p></body></html>"
  }

  $bytes = [Text.Encoding]::UTF8.GetBytes($html)
  $response.ContentType = "text/html; charset=utf-8"
  $response.ContentLength64 = $bytes.Length
  $response.OutputStream.Write($bytes, 0, $bytes.Length)
  $response.OutputStream.Close()
  $listener.Stop()

  if ($authError) {
    throw "Spotify authorization returned error: $authError"
  }
  if (-not $code) {
    throw "No authorization code received."
  }

  $basic = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes("$ClientId`:$ClientSecret"))
  $body = "grant_type=authorization_code&code=$([uri]::EscapeDataString($code))&redirect_uri=$([uri]::EscapeDataString($RedirectUri))"

  $token = Invoke-RestMethod -Method Post `
    -Uri "https://accounts.spotify.com/api/token" `
    -Headers @{ Authorization = "Basic $basic"; "Content-Type" = "application/x-www-form-urlencoded" } `
    -Body $body

  if (-not $token.refresh_token) {
    throw "No refresh_token in response. Ensure app uses Authorization Code flow and scopes are correct."
  }

  Write-Host ""
  Write-Host "Success. Your Spotify refresh token is:" -ForegroundColor Green
  Write-Host $token.refresh_token -ForegroundColor Green
  Write-Host ""
  Write-Host "Add this to your .env file:" -ForegroundColor Yellow
  Write-Host "SPOTIFY_REFRESH_TOKEN=$($token.refresh_token)"
  Write-Host ""
  Write-Host "Do NOT commit .env or share this token." -ForegroundColor Yellow
}
catch {
  Write-Host ""
  Write-Host "Failed: $($_.Exception.Message)" -ForegroundColor Red
  exit 1
}
