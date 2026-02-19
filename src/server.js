import express from "express";

const app = express();

const PORT = Number(process.env.PORT || 3000);
const PUBLIC_MODE = (process.env.PUBLIC_MODE || "true").toLowerCase() === "true";
const API_KEY = process.env.API_KEY;
const SCOPES =
  process.env.SCOPES || "user-read-currently-playing user-read-playback-state";

const SPOTIFY_CLIENT_ID = process.env.SPOTIFY_CLIENT_ID;
const SPOTIFY_CLIENT_SECRET = process.env.SPOTIFY_CLIENT_SECRET;
const SPOTIFY_REFRESH_TOKEN = process.env.SPOTIFY_REFRESH_TOKEN;

if (!SPOTIFY_CLIENT_ID || !SPOTIFY_CLIENT_SECRET || !SPOTIFY_REFRESH_TOKEN) {
  console.error(
    "Missing required env vars: SPOTIFY_CLIENT_ID, SPOTIFY_CLIENT_SECRET, SPOTIFY_REFRESH_TOKEN"
  );
  process.exit(1);
}

const tokenCache = {
  accessToken: null,
  expiresAt: 0
};

const limiterStore = new Map();
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX = 120;

function noStore(res) {
  res.set("Cache-Control", "no-store");
}

function requireApiAccess(req, res, next) {
  if (PUBLIC_MODE && !API_KEY) {
    return next();
  }

  if (API_KEY) {
    const auth = req.header("authorization") || "";
    if (auth === `Bearer ${API_KEY}`) {
      return next();
    }
  }

  noStore(res);
  return res.status(401).json({ error: "Unauthorized" });
}

function rateLimit(req, res, next) {
  const now = Date.now();
  const ip = req.ip || req.socket.remoteAddress || "unknown";
  const routeKey = `${ip}:${req.path}`;
  const existing = limiterStore.get(routeKey);

  if (!existing || now > existing.resetAt) {
    limiterStore.set(routeKey, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS });
    return next();
  }

  if (existing.count >= RATE_LIMIT_MAX) {
    noStore(res);
    return res.status(429).json({ error: "Too Many Requests" });
  }

  existing.count += 1;
  return next();
}

async function getAccessToken() {
  const now = Date.now();
  if (tokenCache.accessToken && now < tokenCache.expiresAt - 30_000) {
    return tokenCache.accessToken;
  }

  const basicAuth = Buffer.from(
    `${SPOTIFY_CLIENT_ID}:${SPOTIFY_CLIENT_SECRET}`,
    "utf8"
  ).toString("base64");

  const body = new URLSearchParams();
  body.set("grant_type", "refresh_token");
  body.set("refresh_token", SPOTIFY_REFRESH_TOKEN);
  body.set("scope", SCOPES);

  const response = await fetch("https://accounts.spotify.com/api/token", {
    method: "POST",
    headers: {
      Authorization: `Basic ${basicAuth}`,
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body
  });

  if (!response.ok) {
    throw new Error(`Spotify token refresh failed (${response.status})`);
  }

  const data = await response.json();
  if (!data.access_token || !data.expires_in) {
    throw new Error("Spotify token refresh returned invalid payload");
  }

  tokenCache.accessToken = data.access_token;
  tokenCache.expiresAt = now + data.expires_in * 1000;
  return tokenCache.accessToken;
}

function mapNowPlaying(data) {
  if (!data || !data.item || data.is_playing !== true) {
    return { is_playing: false };
  }

  const item = data.item;
  return {
    is_playing: true,
    track: item.name || "",
    artist: (item.artists || []).map((a) => a.name).join(", "),
    album: item.album?.name || "",
    url: item.external_urls?.spotify || "",
    id: item.id || "",
    progress_ms: Number.isFinite(data.progress_ms) ? data.progress_ms : 0,
    duration_ms: Number.isFinite(item.duration_ms) ? item.duration_ms : 0
  };
}

async function fetchNowPlaying() {
  const accessToken = await getAccessToken();
  const response = await fetch(
    "https://api.spotify.com/v1/me/player/currently-playing",
    {
      headers: {
        Authorization: `Bearer ${accessToken}`
      }
    }
  );

  if (response.status === 204) {
    return { is_playing: false };
  }

  if (!response.ok) {
    throw new Error(`Spotify currently-playing fetch failed (${response.status})`);
  }

  const data = await response.json();
  return mapNowPlaying(data);
}

app.use("/api", rateLimit, requireApiAccess);

app.get("/api/health", (req, res) => {
  noStore(res);
  res.json({ ok: true });
});

app.get("/api/now-playing", async (req, res) => {
  noStore(res);
  try {
    const payload = await fetchNowPlaying();
    res.json(payload);
  } catch (err) {
    res.status(502).json({ error: err.message || "Upstream error" });
  }
});

app.get("/api/now-playing.txt", async (req, res) => {
  noStore(res);
  res.type("text/plain; charset=utf-8");
  try {
    const payload = await fetchNowPlaying();
    if (!payload.is_playing) {
      return res.send("");
    }
    return res.send(`${payload.track} \u2014 ${payload.artist}`);
  } catch (err) {
    return res.status(502).send("");
  }
});

app.get("/", (_req, res) => {
  noStore(res);
  res.type("html");
  res.send(`<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Spotify Now Playing</title>
    <style>
      :root {
        color-scheme: light;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      }
      body {
        margin: 0;
        min-height: 100vh;
        display: grid;
        place-items: center;
        background: #f6f7f9;
        color: #151515;
      }
      .card {
        width: min(680px, 92vw);
        border: 1px solid #d9dce2;
        border-radius: 14px;
        padding: 24px;
        background: #ffffff;
      }
      h1 {
        margin: 0 0 14px;
        font-size: 1.2rem;
      }
      #status {
        font-size: 1.05rem;
      }
      #meta {
        margin-top: 8px;
        color: #556;
        font-size: 0.95rem;
      }
      a {
        color: #1e63d0;
      }
    </style>
  </head>
  <body>
    <main class="card">
      <h1>Now Playing</h1>
      <div id="status">Loading...</div>
      <div id="meta"></div>
    </main>
    <script>
      const statusEl = document.getElementById("status");
      const metaEl = document.getElementById("meta");

      async function loadNowPlaying() {
        try {
          const response = await fetch("/api/now-playing", { cache: "no-store" });
          const data = await response.json();

          if (!response.ok || data.error) {
            statusEl.textContent = "Unavailable";
            metaEl.textContent = data.error ? String(data.error) : "API error";
            return;
          }

          if (!data.is_playing) {
            statusEl.textContent = "Not playing";
            metaEl.textContent = "";
            return;
          }

          statusEl.textContent = data.track + " - " + data.artist;
          metaEl.innerHTML = data.album
            ? "Album: " + data.album + (data.url ? ' | <a href="' + data.url + '" target="_blank" rel="noopener">Open in Spotify</a>' : "")
            : (data.url ? '<a href="' + data.url + '" target="_blank" rel="noopener">Open in Spotify</a>' : "");
        } catch (_err) {
          statusEl.textContent = "Unavailable";
          metaEl.textContent = "Network error";
        }
      }

      loadNowPlaying();
      setInterval(loadNowPlaying, 5000);
    </script>
  </body>
</html>`);
});

app.listen(PORT, () => {
  console.log(`spot service listening on :${PORT}`);
});
