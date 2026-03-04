import express from "express";
import path from "node:path";
import { promises as fs } from "node:fs";
import { fileURLToPath } from "node:url";

const app = express();

const PORT = Number(process.env.PORT || 3000);
const PUBLIC_MODE = (process.env.PUBLIC_MODE || "true").toLowerCase() === "true";
const API_KEY = process.env.API_KEY;
const SCOPES =
  process.env.SCOPES ||
  "user-read-currently-playing user-read-playback-state user-read-recently-played";
const COUNTER_POLL_MS = Math.max(2000, Number(process.env.COUNTER_POLL_MS || 5000));
const COUNTER_FLUSH_DEBOUNCE_MS = Math.max(
  1000,
  Number(process.env.COUNTER_FLUSH_DEBOUNCE_MS || 3000)
);
const DAILY_SEED_MAX_PAGES = Math.max(1, Number(process.env.DAILY_SEED_MAX_PAGES || 24));
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const COUNTER_STATE_FILE =
  process.env.COUNTER_STATE_FILE || path.join(__dirname, "..", "data", "daily-counter.json");

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
const viewerClients = new Set();
const history = [];
let lastHistoryTrackId = "";
const dailyCounter = {
  totalsMsByDay: Object.create(null),
  lastSnapshot: null,
  dirty: false,
  flushTimer: null,
  writeInFlight: Promise.resolve(),
  pollInFlight: false
};

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

function pad2(value) {
  return String(value).padStart(2, "0");
}

function getLocalDayKey(ms = Date.now()) {
  const date = new Date(ms);
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

function getLocalDayStartMs(ms = Date.now()) {
  const date = new Date(ms);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

function getNextLocalDayStartMs(ms) {
  const date = new Date(ms);
  date.setHours(24, 0, 0, 0);
  return date.getTime();
}

function pruneCounterToToday() {
  const todayKey = getLocalDayKey();
  const hasToday = Object.prototype.hasOwnProperty.call(dailyCounter.totalsMsByDay, todayKey);
  const todayMs = hasToday ? Number(dailyCounter.totalsMsByDay[todayKey] || 0) : 0;
  const keys = Object.keys(dailyCounter.totalsMsByDay);
  const shouldRewrite = keys.length !== 1 || !hasToday;
  if (!shouldRewrite) {
    return todayKey;
  }

  dailyCounter.totalsMsByDay = Object.create(null);
  dailyCounter.totalsMsByDay[todayKey] = Math.max(0, Math.round(todayMs));
  dailyCounter.dirty = true;
  queueCounterFlush();
  return todayKey;
}

function getCurrentDailyMinutes() {
  const todayKey = pruneCounterToToday();
  const totalMs = Number(dailyCounter.totalsMsByDay[todayKey] || 0);
  return Math.floor(Math.max(0, totalMs) / 60_000);
}

function queueCounterFlush() {
  if (dailyCounter.flushTimer) {
    return;
  }
  dailyCounter.flushTimer = setTimeout(() => {
    dailyCounter.flushTimer = null;
    void flushDailyCounterToDisk();
  }, COUNTER_FLUSH_DEBOUNCE_MS);
  dailyCounter.flushTimer.unref?.();
}

async function flushDailyCounterToDisk(force = false) {
  dailyCounter.writeInFlight = dailyCounter.writeInFlight.then(async () => {
    if (!force && !dailyCounter.dirty) {
      return;
    }

    const payload = {
      version: 1,
      totals_ms_by_day: dailyCounter.totalsMsByDay,
      updated_at: new Date().toISOString()
    };

    const dir = path.dirname(COUNTER_STATE_FILE);
    const tmpPath = `${COUNTER_STATE_FILE}.tmp`;

    try {
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(tmpPath, JSON.stringify(payload), "utf8");
      await fs.rename(tmpPath, COUNTER_STATE_FILE);
      dailyCounter.dirty = false;
    } catch (err) {
      console.error(
        `Failed to persist daily counter at ${COUNTER_STATE_FILE}: ${err?.message || String(err)}`
      );
    }
  });

  return dailyCounter.writeInFlight;
}

function addToDailyCounter(dayKey, deltaMs) {
  if (!Number.isFinite(deltaMs) || deltaMs <= 0) {
    return;
  }
  const todayKey = pruneCounterToToday();
  if (dayKey !== todayKey) {
    return;
  }
  const current = Number(dailyCounter.totalsMsByDay[dayKey] || 0);
  dailyCounter.totalsMsByDay[dayKey] = Math.max(0, Math.round(current + deltaMs));
  dailyCounter.dirty = true;
  queueCounterFlush();
}

function addCounterDeltaAcrossDays(startObservedMs, endObservedMs, listenedDeltaMs) {
  if (
    !Number.isFinite(startObservedMs) ||
    !Number.isFinite(endObservedMs) ||
    !Number.isFinite(listenedDeltaMs)
  ) {
    return;
  }
  if (endObservedMs <= startObservedMs || listenedDeltaMs <= 0) {
    return;
  }

  const intervalMs = endObservedMs - startObservedMs;
  let cursorMs = startObservedMs;
  let allocatedMs = 0;

  while (cursorMs < endObservedMs) {
    const dayKey = getLocalDayKey(cursorMs);
    const dayEndMs = getNextLocalDayStartMs(cursorMs);
    const segmentEndMs = Math.min(endObservedMs, dayEndMs);
    const segmentDurationMs = Math.max(0, segmentEndMs - cursorMs);
    if (segmentDurationMs <= 0) {
      break;
    }

    let segmentDeltaMs = Math.round((listenedDeltaMs * segmentDurationMs) / intervalMs);
    if (segmentEndMs === endObservedMs) {
      segmentDeltaMs = Math.max(0, Math.round(listenedDeltaMs - allocatedMs));
    }
    addToDailyCounter(dayKey, segmentDeltaMs);
    allocatedMs += segmentDeltaMs;
    cursorMs = segmentEndMs;
  }
}

function observeNowPlayingForCounter(payload, observedAtMs = Date.now()) {
  const current = {
    observedAtMs,
    id: String(payload?.id || ""),
    isPlaying: payload?.is_playing === true,
    progressMs: Math.max(0, Number(payload?.progress_ms || 0)),
    durationMs: Math.max(0, Number(payload?.duration_ms || 0))
  };

  const previous = dailyCounter.lastSnapshot;
  dailyCounter.lastSnapshot = current;

  if (
    !previous ||
    !previous.isPlaying ||
    !current.isPlaying ||
    !previous.id ||
    previous.id !== current.id
  ) {
    return;
  }

  const wallDeltaMs = current.observedAtMs - previous.observedAtMs;
  if (wallDeltaMs <= 0) {
    return;
  }

  const progressDeltaMs = current.progressMs - previous.progressMs;
  if (progressDeltaMs <= 0) {
    return;
  }

  const clampedDeltaMs = Math.min(progressDeltaMs, wallDeltaMs + 3_000);
  if (clampedDeltaMs <= 0) {
    return;
  }

  addCounterDeltaAcrossDays(previous.observedAtMs, current.observedAtMs, clampedDeltaMs);
}

async function fetchDailySeedMs(dayStartMs) {
  let totalMs = 0;
  let pageCount = 0;
  let requestUrl = new URL("https://api.spotify.com/v1/me/player/recently-played");
  requestUrl.searchParams.set("limit", "50");
  requestUrl.searchParams.set("before", String(Date.now()));
  let previousBeforeCursor = Number(requestUrl.searchParams.get("before"));

  while (pageCount < DAILY_SEED_MAX_PAGES) {
    const accessToken = await getAccessToken();
    const response = await fetch(requestUrl, {
      headers: {
        Authorization: `Bearer ${accessToken}`
      }
    });

    if (!response.ok) {
      throw new Error(`Spotify recently-played fetch failed (${response.status})`);
    }

    const data = await response.json();
    const items = Array.isArray(data?.items) ? data.items : [];
    if (items.length === 0) {
      break;
    }

    let crossedStart = false;
    for (const item of items) {
      const playedAtMs = Date.parse(item?.played_at || "");
      if (!Number.isFinite(playedAtMs)) {
        continue;
      }
      if (playedAtMs < dayStartMs) {
        crossedStart = true;
        continue;
      }
      const durationMs = Number(item?.track?.duration_ms);
      if (Number.isFinite(durationMs) && durationMs > 0) {
        totalMs += durationMs;
      }
    }

    pageCount += 1;
    if (crossedStart) {
      break;
    }

    const nextHref = typeof data?.next === "string" ? data.next : "";
    if (!nextHref) {
      break;
    }

    let nextUrl;
    try {
      nextUrl = new URL(nextHref);
    } catch (_err) {
      break;
    }

    const nextBeforeCursor = Number(nextUrl.searchParams.get("before"));
    if (
      !Number.isFinite(nextBeforeCursor) ||
      nextBeforeCursor <= 0 ||
      nextBeforeCursor >= previousBeforeCursor
    ) {
      break;
    }

    requestUrl = nextUrl;
    previousBeforeCursor = nextBeforeCursor;
  }

  return Math.max(0, Math.round(totalMs));
}

function setTodaySeedIfHigher(seedMs) {
  const todayKey = pruneCounterToToday();
  const current = Number(dailyCounter.totalsMsByDay[todayKey] || 0);
  if (seedMs > current) {
    dailyCounter.totalsMsByDay[todayKey] = Math.round(seedMs);
    dailyCounter.dirty = true;
    queueCounterFlush();
  }
}

async function loadDailyCounterFromDisk() {
  try {
    const raw = await fs.readFile(COUNTER_STATE_FILE, "utf8");
    const parsed = JSON.parse(raw);
    const incoming = parsed?.totals_ms_by_day || {};
    const nextTotals = Object.create(null);

    for (const [key, value] of Object.entries(incoming)) {
      const ms = Number(value);
      if (/^\d{4}-\d{2}-\d{2}$/.test(key) && Number.isFinite(ms) && ms >= 0) {
        nextTotals[key] = Math.round(ms);
      }
    }

    dailyCounter.totalsMsByDay = nextTotals;
    pruneCounterToToday();
  } catch (err) {
    if (err?.code !== "ENOENT") {
      console.error(
        `Failed to load daily counter from ${COUNTER_STATE_FILE}: ${
          err?.message || String(err)
        }`
      );
    }
  }
}

async function sampleNowPlayingForCounter() {
  const payload = await fetchNowPlaying();
  observeNowPlayingForCounter(payload);
}

function startDailyCounterPolling() {
  const pollTimer = setInterval(async () => {
    if (dailyCounter.pollInFlight) {
      return;
    }
    dailyCounter.pollInFlight = true;
    try {
      await sampleNowPlayingForCounter();
    } catch (_err) {
      // Ignore intermittent API failures; next poll will continue tracking.
    } finally {
      dailyCounter.pollInFlight = false;
    }
  }, COUNTER_POLL_MS);
  pollTimer.unref?.();
}

async function initDailyCounter() {
  await loadDailyCounterFromDisk();
  try {
    const dayStartMs = getLocalDayStartMs();
    const seedMs = await fetchDailySeedMs(dayStartMs);
    setTodaySeedIfHigher(seedMs);
  } catch (_err) {
    // If scope is missing or endpoint fails, keep live tracking without startup seed.
  }
  try {
    await sampleNowPlayingForCounter();
  } catch (_err) {
    // Ignore startup fetch failures; polling loop will retry.
  }
  startDailyCounterPolling();
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
    observeNowPlayingForCounter(payload);
    if (payload && payload.id && payload.id !== lastHistoryTrackId) {
      lastHistoryTrackId = payload.id;
      history.unshift({
        id: payload.id,
        track: payload.track,
        artist: payload.artist,
        album: payload.album,
        artwork_url: payload.artwork_url,
        url: payload.url,
        played_at: new Date().toISOString()
      });
      if (history.length > 5) {
        history.pop();
      }
    }
    payload.viewers = viewerClients.size;
    payload.daily_minutes = getCurrentDailyMinutes();
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

app.get("/api/history", (req, res) => {
  noStore(res);
  res.json({ tracks: history });
});

app.get("/api/viewers", (req, res) => {
  noStore(res);
  res.json({ viewers: viewerClients.size });
});

app.get("/api/viewers/stream", (req, res) => {
  noStore(res);
  res.set({
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-store",
    Connection: "keep-alive"
  });
  res.flushHeaders?.();

  viewerClients.add(res);
  res.write(`data: ${viewerClients.size}\n\n`);
  for (const client of viewerClients) {
    if (client !== res) {
      client.write(`data: ${viewerClients.size}\n\n`);
    }
  }

  const heartbeat = setInterval(() => {
    res.write(": ping\n\n");
  }, 20_000);

  req.on("close", () => {
    clearInterval(heartbeat);
    viewerClients.delete(res);
    for (const client of viewerClients) {
      client.write(`data: ${viewerClients.size}\n\n`);
    }
  });
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
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 12px;
      }
      .status {
        margin-left: 8px;
        font-size: 0.72rem;
        padding: 4px 8px;
        border-radius: 999px;
        border: 1px solid var(--stroke);
        color: var(--sub);
      }
      .daily-minutes {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        font-size: 0.72rem;
        padding: 4px 10px;
        border-radius: 999px;
        border: 1px solid var(--stroke);
        color: var(--sub);
      }
      .daily-minutes strong {
        color: var(--text);
        font-weight: 600;
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
      @media (max-height: 720px) {
        .actions {
          display: none;
        }
      }
    </style>
  </head>
  <body>
    <main class="player">
      <div class="head">
        <span>Now Playing <span id="statusTag" class="status">CONNECTING</span></span>
        <span class="daily-minutes">Today <strong id="dailyMinutes">--</strong> min</span>
      </div>
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
      const dailyMinutesEl = document.getElementById("dailyMinutes");

      const IDLE_ART =
        "data:image/svg+xml;utf8," +
        encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 500 500"><rect width="500" height="500" rx="72" fill="#1ed760"/><path d="M96 180c98-34 218-25 308 28" stroke="#0b0b0b" stroke-width="34" stroke-linecap="round" fill="none"/><path d="M115 262c78-26 172-19 244 21" stroke="#0b0b0b" stroke-width="28" stroke-linecap="round" fill="none"/><path d="M133 337c57-19 124-14 176 15" stroke="#0b0b0b" stroke-width="23" stroke-linecap="round" fill="none"/></svg>');

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

      function renderDailyMinutes(minutes) {
        if (!Number.isFinite(minutes) || minutes < 0) {
          dailyMinutesEl.textContent = "--";
          return;
        }
        dailyMinutesEl.textContent = Math.floor(minutes).toLocaleString();
      }

      async function loadNowPlaying() {
        try {
          const response = await fetch("/api/now-playing", { cache: "no-store" });
          const data = await response.json();
          renderDailyMinutes(Number(data.daily_minutes));

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

let shuttingDown = false;
function handleShutdownSignal(signal) {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  clearTimeout(dailyCounter.flushTimer);
  dailyCounter.flushTimer = null;
  void flushDailyCounterToDisk(true).finally(() => {
    process.exit(signal === "SIGINT" || signal === "SIGTERM" ? 0 : 1);
  });
}

process.on("SIGINT", () => handleShutdownSignal("SIGINT"));
process.on("SIGTERM", () => handleShutdownSignal("SIGTERM"));
process.on("uncaughtException", (err) => {
  console.error(err);
  handleShutdownSignal("uncaughtException");
});
process.on("unhandledRejection", (err) => {
  console.error(err);
  handleShutdownSignal("unhandledRejection");
});

app.listen(PORT, () => {
  console.log(`spot service listening on :${PORT}`);
  initDailyCounter()
    .then(() => {
      console.log(`daily counter ready at ${COUNTER_STATE_FILE}`);
    })
    .catch((err) => {
      console.error(`daily counter init failed: ${err?.message || String(err)}`);
    });
});

