# Spot

Stateless, read-only Dockerized web service for Spotify "now playing" data.

## Pattern

This implementation uses **Pattern A** (bring your own refresh token):

- You provide `SPOTIFY_REFRESH_TOKEN` externally via env var.
- Service refreshes short-lived access tokens in memory.
- No disk/database/volume persistence is used for core functionality.

## Endpoints

- `GET /` HTML page that polls every 5s
- `GET /api/now-playing` JSON
- `GET /api/now-playing.txt` plain text
- `GET /api/health` health check

All API responses include `Cache-Control: no-store`.

## Required env vars

- `SPOTIFY_CLIENT_ID`
- `SPOTIFY_CLIENT_SECRET`
- `SPOTIFY_REFRESH_TOKEN`

## Get `SPOTIFY_REFRESH_TOKEN` (Windows, easiest path)

If you do not know Spotify API details, use the helper script. It walks you through everything.

1. Create a Spotify app:
   - Go to `https://developer.spotify.com/dashboard`
   - Create app (or open existing app)
   - Copy your `Client ID` and `Client Secret`
2. Open PowerShell in this repo and run:

```powershell
.\scripts\get-refresh-token.ps1
```

3. The script will prompt for your `Client ID` and `Client Secret`.
4. The script tells you to add this redirect URI in Spotify app settings:
   - `http://127.0.0.1:8888/callback/`
5. Script opens your browser for Spotify login/consent.
6. Script captures callback automatically and prints your refresh token.
7. Put it in `.env`:

```env
SPOTIFY_REFRESH_TOKEN=your_token_here
```

Security notes:

- `SPOTIFY_REFRESH_TOKEN` is sensitive. Treat it like a password.
- Never commit `.env` or share tokens in screenshots/logs.

Advanced/manual method:

- If needed, you can still do manual Authorization Code flow using Spotify docs.

## Optional env vars

- `PORT` (default `3000`)
- `SCOPES` (default `user-read-currently-playing user-read-playback-state`)
- `PUBLIC_MODE` (default `true`)
- `API_KEY` (if set, require `Authorization: Bearer <API_KEY>` for `/api/*`)
- `BASE_URL` (not used in Pattern A; reserved for possible helper OAuth mode)

## Local run

```bash
npm install
npm start
```

## Docker run

```bash
docker compose up --build
```

No volumes are required or defined.

## GitHub Container Build

The workflow at `.github/workflows/build-and-push.yml` will:

- Build on pull requests to `main` (no push)
- Build and push to `ghcr.io/nickjongens/spot` on pushes to `main`

Important:

- Spotify secrets are **runtime env vars**, not Docker build args.
- Package publish permissions use the default `GITHUB_TOKEN` from Actions.
