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
  if (!data || !data.item) {
    return { is_playing: false };
  }

  const item = data.item;
  return {
    is_playing: data.is_playing === true,
    is_paused: data.is_playing === false,
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
        --bg0: #070809;
        --bg1: #0c1612;
        --card: rgba(18, 21, 23, 0.82);
        --stroke: rgba(255, 255, 255, 0.11);
        --text: #f6f6f6;
        --sub: #9da4a8;
        --accent: #1ed760;
        --accent-soft: rgba(30, 215, 96, 0.25);
        font-family: "Aptos", "Segoe UI", Arial, sans-serif;
      }
      body {
        margin: 0;
        min-height: 100vh;
        display: grid;
        place-items: center;
        background:
          radial-gradient(1000px 700px at 0% 0%, #123323 0%, transparent 60%),
          radial-gradient(900px 650px at 100% 100%, #16242f 0%, transparent 64%),
          linear-gradient(180deg, var(--bg1) 0%, var(--bg0) 100%);
        color: var(--text);
      }
      .player {
        width: min(860px, 92vw);
        border-radius: 24px;
        padding: 28px;
        background: var(--card);
        border: 1px solid var(--stroke);
        box-shadow: 0 22px 60px rgba(0, 0, 0, 0.48);
        backdrop-filter: blur(14px) saturate(140%);
      }
      .head {
        margin: 0 0 18px;
        font-size: 0.8rem;
        color: var(--sub);
        text-transform: uppercase;
        letter-spacing: 0.12em;
      }
      .status {
        margin-left: 8px;
        font-size: 0.72rem;
        padding: 4px 8px;
        border-radius: 999px;
        border: 1px solid var(--stroke);
        color: var(--sub);
      }
      .content {
        display: grid;
        grid-template-columns: 230px 1fr;
        gap: 26px;
        align-items: center;
      }
      .cover {
        width: 230px;
        aspect-ratio: 1;
        border-radius: 16px;
        background: #1f2427;
        box-shadow: 0 18px 40px rgba(0, 0, 0, 0.45);
        border: 1px solid rgba(255, 255, 255, 0.09);
        object-fit: cover;
      }
      .meta {
        min-width: 0;
      }
      .track {
        margin: 0;
        font-size: clamp(1.4rem, 2.8vw, 2.1rem);
        line-height: 1.15;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .artist {
        margin-top: 6px;
        color: #d3d7da;
        font-size: 1.06rem;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .album {
        margin-top: 4px;
        color: var(--sub);
        font-size: 0.95rem;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .progress-wrap {
        margin-top: 22px;
      }
      .progress-bar {
        width: 100%;
        height: 6px;
        border-radius: 999px;
        background: #3a3f43;
        overflow: hidden;
      }
      .progress-fill {
        height: 100%;
        width: 0%;
        background: linear-gradient(90deg, #1aa64b 0%, var(--accent) 100%);
        box-shadow: 0 0 18px var(--accent-soft);
        transition: width 0.15s linear;
      }
      .times {
        margin-top: 8px;
        display: flex;
        justify-content: space-between;
        color: var(--sub);
        font-size: 0.82rem;
      }
      .actions {
        margin-top: 16px;
        font-size: 0.9rem;
      }
      a {
        color: #ffffff;
        text-decoration: none;
        border-bottom: 1px solid var(--accent);
      }
      a:hover {
        color: var(--accent);
      }
      @media (max-width: 620px) {
        .player {
          padding: 22px;
          border-radius: 18px;
        }
        .content {
          grid-template-columns: 1fr;
        }
        .cover {
          width: min(320px, 100%);
        }
      }
    </style>
  </head>
  <body>
    <main class="player">
      <div class="head">Now Playing <span id="statusTag" class="status">CONNECTING</span></div>
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
      const statusTagEl = document.getElementById("statusTag");

      const IDLE_ART =
        "data:image/svg+xml;utf8," +
        encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 500 500"><rect width="500" height="500" rx="72" fill="#121212"/><circle cx="250" cy="250" r="178" fill="#1ed760"/><path d="M153 214c62-17 132-10 191 20" stroke="#121212" stroke-width="22" stroke-linecap="round" fill="none"/><path d="M166 266c49-13 103-8 149 15" stroke="#121212" stroke-width="19" stroke-linecap="round" fill="none"/><path d="M178 313c35-9 73-5 105 10" stroke="#121212" stroke-width="17" stroke-linecap="round" fill="none"/></svg>');

      let nowPlaying = {
        trackId: "",
        progressBaseMs: 0,
        durationMs: 0,
        anchorMs: performance.now(),
        isPlaying: false
      };

      coverEl.src = IDLE_ART;

      function formatMs(ms) {
        const total = Math.max(0, Math.floor(ms / 1000));
        const min = Math.floor(total / 60);
        const sec = String(total % 60).padStart(2, "0");
        return min + ":" + sec;
      }

      function getComputedProgressMs() {
        if (!nowPlaying.durationMs) {
          return 0;
        }
        if (!nowPlaying.isPlaying) {
          return Math.min(nowPlaying.progressBaseMs, nowPlaying.durationMs);
        }
        const elapsed = performance.now() - nowPlaying.anchorMs;
        return Math.min(nowPlaying.progressBaseMs + Math.max(0, elapsed), nowPlaying.durationMs);
      }

      function renderProgress() {
        if (!nowPlaying.durationMs) {
          progressFillEl.style.width = "0%";
          progressNowEl.textContent = "0:00";
          progressTotalEl.textContent = "0:00";
          return;
        }
        const bounded = getComputedProgressMs();
        const pct = (bounded / nowPlaying.durationMs) * 100;
        progressFillEl.style.width = pct.toFixed(2) + "%";
        progressNowEl.textContent = formatMs(bounded);
        progressTotalEl.textContent = formatMs(nowPlaying.durationMs);
      }

      function setIdleState(title, subtitle) {
        statusTagEl.textContent = "IDLE";
        trackEl.textContent = title;
        artistEl.textContent = subtitle;
        albumEl.textContent = "";
        actionsEl.textContent = "";
        coverEl.src = IDLE_ART;
        nowPlaying = {
          trackId: "",
          progressBaseMs: 0,
          durationMs: 0,
          anchorMs: performance.now(),
          isPlaying: false
        };
        renderProgress();
      }

      async function loadNowPlaying() {
        try {
          const response = await fetch("/api/now-playing", { cache: "no-store" });
          const data = await response.json();

          if (!response.ok || data.error) {
            setIdleState("Unavailable", data.error ? String(data.error) : "API error");
            return;
          }

          if (!data.id) {
            setIdleState("Not Playing", "Spotify is idle right now.");
            return;
          }

          statusTagEl.textContent = data.is_playing ? "PLAYING" : "PAUSED";

          trackEl.textContent = data.track || "Unknown Track";
          artistEl.textContent = data.artist || "Unknown Artist";
          albumEl.textContent = data.album ? "Album: " + data.album : "";
          actionsEl.innerHTML = data.url
            ? '<a href="' + data.url + '" target="_blank" rel="noopener">Open in Spotify</a>'
            : "";

          if (data.artwork_url) {
            coverEl.src = data.artwork_url;
          } else {
            coverEl.src = IDLE_ART;
          }

          const trackId = String(data.id || "");
          const incomingProgress = Number(data.progress_ms || 0);
          const incomingDuration = Number(data.duration_ms || 0);
          const sameTrack = trackId && trackId === nowPlaying.trackId;
          const currentComputed = getComputedProgressMs();
          const suspiciousZero = sameTrack && incomingProgress === 0 && currentComputed > 3000;

          if (!suspiciousZero) {
            nowPlaying = {
              trackId,
              progressBaseMs: Math.max(0, incomingProgress),
              durationMs: Math.max(0, incomingDuration),
              anchorMs: performance.now(),
              isPlaying: data.is_playing === true
            };
          }

          renderProgress();
        } catch (_err) {
          setIdleState("Unavailable", "Network error");
        }
      }

      setInterval(() => {
        if (nowPlaying.isPlaying && nowPlaying.durationMs > 0) {
          renderProgress();
        }
      }, 200);

      loadNowPlaying();
      setInterval(loadNowPlaying, 2000);
    </script>
  </body>
</html>`);
});
app.listen(PORT, () => {
  console.log(`spot service listening on :${PORT}`);
});

