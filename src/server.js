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
    artwork_url: item.album?.images?.[0]?.url || "",
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
        color-scheme: dark;
        font-family: "Segoe UI", Arial, sans-serif;
      }
      body {
        margin: 0;
        min-height: 100vh;
        display: grid;
        place-items: center;
        background: radial-gradient(circle at top left, #1f3a2b 0%, #121212 55%);
        color: #ffffff;
      }
      .player {
        width: min(760px, 92vw);
        border-radius: 18px;
        padding: 20px;
        background: linear-gradient(180deg, #1a1a1a 0%, #121212 100%);
        box-shadow: 0 20px 50px rgba(0, 0, 0, 0.45);
        border: 1px solid #2b2b2b;
      }
      .head {
        margin: 0 0 16px;
        font-size: 0.9rem;
        color: #b3b3b3;
        text-transform: uppercase;
        letter-spacing: 0.08em;
      }
      .content {
        display: grid;
        grid-template-columns: 180px 1fr;
        gap: 18px;
        align-items: center;
      }
      .cover {
        width: 180px;
        aspect-ratio: 1;
        border-radius: 10px;
        background: #262626;
        object-fit: cover;
      }
      .meta {
        min-width: 0;
      }
      .track {
        margin: 0;
        font-size: 1.35rem;
        line-height: 1.25;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .artist {
        margin-top: 4px;
        color: #b3b3b3;
        font-size: 1.02rem;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .album {
        margin-top: 2px;
        color: #8a8a8a;
        font-size: 0.92rem;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .progress-wrap {
        margin-top: 18px;
      }
      .progress-bar {
        width: 100%;
        height: 4px;
        border-radius: 999px;
        background: #4d4d4d;
        overflow: hidden;
      }
      .progress-fill {
        height: 100%;
        width: 0%;
        background: #1db954;
        transition: width 0.2s linear;
      }
      .times {
        margin-top: 6px;
        display: flex;
        justify-content: space-between;
        color: #a7a7a7;
        font-size: 0.82rem;
      }
      .actions {
        margin-top: 14px;
        font-size: 0.9rem;
        color: #b3b3b3;
      }
      a {
        color: #ffffff;
        text-decoration-color: #1db954;
      }
      @media (max-width: 620px) {
        .content {
          grid-template-columns: 1fr;
        }
        .cover {
          width: 100%;
          max-width: 260px;
        }
      }
    </style>
  </head>
  <body>
    <main class="player">
      <div class="head">Now Playing</div>
      <section class="content">
        <img id="cover" class="cover" alt="Album artwork" />
        <div class="meta">
          <h1 id="track" class="track">Loading...</h1>
          <div id="artist" class="artist"></div>
          <div id="album" class="album"></div>
          <div class="progress-wrap">
            <div class="progress-bar"><div id="progressFill" class="progress-fill"></div></div>
            <div class="times">
              <span id="progressNow">0:00</span>
              <span id="progressTotal">0:00</span>
            </div>
          </div>
          <div id="actions" class="actions"></div>
        </div>
      </section>
    </main>
    <script>
      const coverEl = document.getElementById("cover");
      const trackEl = document.getElementById("track");
      const artistEl = document.getElementById("artist");
      const albumEl = document.getElementById("album");
      const progressFillEl = document.getElementById("progressFill");
      const progressNowEl = document.getElementById("progressNow");
      const progressTotalEl = document.getElementById("progressTotal");
      const actionsEl = document.getElementById("actions");

      let liveProgressMs = 0;
      let liveDurationMs = 0;
      let liveIsPlaying = false;

      function formatMs(ms) {
        const total = Math.max(0, Math.floor(ms / 1000));
        const min = Math.floor(total / 60);
        const sec = String(total % 60).padStart(2, "0");
        return min + ":" + sec;
      }

      function renderProgress() {
        if (!liveDurationMs) {
          progressFillEl.style.width = "0%";
          progressNowEl.textContent = "0:00";
          progressTotalEl.textContent = "0:00";
          return;
        }
        const bounded = Math.min(liveProgressMs, liveDurationMs);
        const pct = (bounded / liveDurationMs) * 100;
        progressFillEl.style.width = pct.toFixed(2) + "%";
        progressNowEl.textContent = formatMs(bounded);
        progressTotalEl.textContent = formatMs(liveDurationMs);
      }

      async function loadNowPlaying() {
        try {
          const response = await fetch("/api/now-playing", { cache: "no-store" });
          const data = await response.json();

          if (!response.ok || data.error) {
            trackEl.textContent = "Unavailable";
            artistEl.textContent = data.error ? String(data.error) : "API error";
            albumEl.textContent = "";
            actionsEl.textContent = "";
            coverEl.removeAttribute("src");
            liveProgressMs = 0;
            liveDurationMs = 0;
            liveIsPlaying = false;
            renderProgress();
            return;
          }

          if (!data.is_playing) {
            trackEl.textContent = "Not Playing";
            artistEl.textContent = "Spotify is idle right now.";
            albumEl.textContent = "";
            actionsEl.textContent = "";
            coverEl.removeAttribute("src");
            liveProgressMs = 0;
            liveDurationMs = 0;
            liveIsPlaying = false;
            renderProgress();
            return;
          }

          trackEl.textContent = data.track || "Unknown Track";
          artistEl.textContent = data.artist || "Unknown Artist";
          albumEl.textContent = data.album ? "Album: " + data.album : "";
          actionsEl.innerHTML = data.url
            ? '<a href="' + data.url + '" target="_blank" rel="noopener">Open in Spotify</a> · Read-only mirror'
            : "Read-only mirror";

          if (data.artwork_url) {
            coverEl.src = data.artwork_url;
          } else {
            coverEl.removeAttribute("src");
          }

          liveProgressMs = Number(data.progress_ms || 0);
          liveDurationMs = Number(data.duration_ms || 0);
          liveIsPlaying = true;
          renderProgress();
        } catch (_err) {
          trackEl.textContent = "Unavailable";
          artistEl.textContent = "Network error";
          albumEl.textContent = "";
          actionsEl.textContent = "";
          coverEl.removeAttribute("src");
          liveProgressMs = 0;
          liveDurationMs = 0;
          liveIsPlaying = false;
          renderProgress();
        }
      }

      setInterval(() => {
        if (liveIsPlaying && liveDurationMs > 0) {
          liveProgressMs += 250;
          renderProgress();
        }
      }, 250);

      loadNowPlaying();
      setInterval(loadNowPlaying, 5000);
    </script>
  </body>
</html>`);
});

app.listen(PORT, () => {
  console.log(`spot service listening on :${PORT}`);
});
