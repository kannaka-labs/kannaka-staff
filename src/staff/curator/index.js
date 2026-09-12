/**
 * Curator — third staff member online (ADR-001 § 8, Phase 2).
 *
 * The Watcher already exposes a read-only album-staleness audit on
 * the dashboard. Curator promotes that into an active staff role:
 *
 *   - Ticks every CURATOR_TICK_MS (default 30 min).
 *   - On each tick: pulls staleness data, classifies albums into
 *     fresh / aging / starving / empty.
 *   - Emits edge-triggered alerts when an album crosses the
 *     STARVING threshold (default 48h since last play). Recovery
 *     fires when it comes back into the rotation.
 *   - Emits a separate alert when an album exists in dj-engine's
 *     ALBUMS but has *never* appeared in the history window. This
 *     is the early warning for empty-album incidents like
 *     "Gifts for Humanity" (2026-05-12) — placeholder titles, no
 *     playable files, listener gets stuck on the prior track.
 *
 * Why this matters: dj-engine + programming.js will now skip empty
 * albums gracefully (loadAlbum returns null, _switchAlbumInBlock
 * tries the next candidate), but the operator still needs to KNOW
 * an album is broken so they can fix or remove it. That's Curator's
 * job — observation with teeth.
 *
 * Future hooks (TODO when needed):
 *   - rare-fire policy (e.g. Kilted Weirdo at most once/week,
 *     only after a chaos-acceptable cue track)
 *   - mood-aware track selection
 *   - no-repeat ledger correctness audits
 *
 * Alerts emitted into the same alerts.jsonl the watcher writes:
 *   CURATOR_ALBUM_STARVING    album crossed STARVING threshold
 *   CURATOR_ALBUM_REFRESHED   starving album played again
 *   CURATOR_ALBUM_NEVER_PLAYED  album in ALBUMS but absent from
 *                               the history window (suspect empty)
 *
 * Persistence: <ALERTS_FILE dir>/curator-state.json — last per-
 * album classification so restarts don't re-emit transitions.
 */
"use strict";

const fs = require("fs");
const http = require("http");
const https = require("https");
const path = require("path");
const url = require("url");

const { readEnvMs } = require("../util");

const DEFAULTS = {
  TICK_MS: 30 * 60 * 1000,            // 30 min
  STARVING_MS: 48 * 60 * 60 * 1000,   // 48 h
  AGING_MS: 12 * 60 * 60 * 1000,      // 12 h (used for color-coding, no alert)
  HISTORY_LIMIT: 200,
  // Don't fire NEVER_PLAYED / STARVING alerts until the radio's history
  // window has at least this many entries. A fresh radio restart starts
  // with 0 history — without this guard Curator's first tick after a
  // restart would emit a NEVER_PLAYED alert for *every* registered
  // album (saw 23/23 fire on 2026-05-12).
  MIN_HISTORY_FOR_ALERTS: 30,
};

function probeHttpJson(target, timeoutMs = 5000, maxBody = 200 * 1024) {
  return new Promise((resolve) => {
    const u = url.parse(target);
    const lib = u.protocol === "https:" ? https : http;
    const req = lib.request({
      method: "GET",
      hostname: u.hostname,
      port: u.port || (u.protocol === "https:" ? 443 : 80),
      path: u.pathname + (u.search || ""),
      timeout: timeoutMs,
    }, (res) => {
      const chunks = [];
      res.on("data", (c) => { chunks.push(c); });
      const settle = () => {
        const body = Buffer.concat(chunks).toString("utf8").slice(0, maxBody);
        resolve({ ok: res.statusCode >= 200 && res.statusCode < 400, status: res.statusCode, body });
      };
      res.on("end", settle);
      res.on("close", settle);
    });
    req.on("error", (e) => resolve({ ok: false, status: 0, error: e.message }));
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.end();
  });
}

async function fetchStaleness(radioBase, historyLimit) {
  const r = await probeHttpJson(`${radioBase}/api/history?limit=${historyLimit}`);
  if (!r.ok) return { ok: false, message: `HTTP ${r.status} ${r.error || ""}`, albums: [] };
  let hist;
  try { hist = JSON.parse(r.body).history || []; }
  catch (e) { return { ok: false, message: `parse: ${e.message}`, albums: [] }; }

  const now = Date.now();
  const lastByAlbum = {};
  const countByAlbum = {};
  for (const h of hist) {
    if (!h.album || h.commercial) continue;
    countByAlbum[h.album] = (countByAlbum[h.album] || 0) + 1;
    if (!lastByAlbum[h.album] || (h.playedAt || 0) > lastByAlbum[h.album]) {
      lastByAlbum[h.album] = h.playedAt || 0;
    }
  }
  const stateR = await probeHttpJson(`${radioBase}/api/state`);
  let allAlbums = [];
  if (stateR.ok) {
    try {
      const s = JSON.parse(stateR.body);
      allAlbums = (s.albums || []).map((a) => a.name || a);
    } catch (_) { /* ignore */ }
  }
  const albums = [];
  for (const album of new Set([...allAlbums, ...Object.keys(lastByAlbum)])) {
    const last = lastByAlbum[album] || 0;
    const ageMs = last ? now - last : null;
    albums.push({
      album,
      lastPlayed: last || null,
      ageMs,
      playsInWindow: countByAlbum[album] || 0,
    });
  }
  albums.sort((a, b) => {
    if (a.ageMs == null && b.ageMs == null) return 0;
    if (a.ageMs == null) return -1;
    if (b.ageMs == null) return 1;
    return b.ageMs - a.ageMs;
  });
  return { ok: true, albums, historyLen: hist.length };
}

// ── Pure classification/alert-edge logic (exported for tests) ──

function classifyAge(album, cfg) {
  if (album.ageMs == null) return "never";
  if (album.ageMs >= cfg.starvingMs) return "starving";
  if (album.ageMs >= cfg.agingMs) return "aging";
  return "fresh";
}

/**
 * One tick's worth of album evaluation. Returns the alerts to emit and
 * the updated state maps, without touching disk or the bus.
 *
 * Two things are load-bearing here:
 *
 *  - `everPlayed` is a ledger of every play ever observed. /api/history
 *    is a bounded window, so an album that simply hasn't played lately
 *    falls out of it and would otherwise look identical to one that has
 *    never played at all.
 *  - alert edges compare against `alerted`, not `classification`. The
 *    warmup guard suppresses writes while the history window is too
 *    short to mean anything; updating the compared-against state during
 *    that window consumed the edge permanently.
 */
function evaluateAlbums({ cfg, albums, historyLen, classification = {}, alerted = {}, everPlayed = {}, now = Date.now() }) {
  const alertsActive = historyLen >= cfg.minHistoryForAlerts;
  const nextClassification = { ...classification };
  const nextAlerted = { ...alerted };
  const nextEverPlayed = { ...everPlayed };
  const alerts = [];

  for (const raw of albums) {
    const album = { ...raw };
    if (album.lastPlayed) {
      nextEverPlayed[album.album] = Math.max(album.lastPlayed, nextEverPlayed[album.album] || 0);
    } else if (nextEverPlayed[album.album]) {
      album.lastPlayed = nextEverPlayed[album.album];
      album.ageMs = now - album.lastPlayed;
      album.agedOut = true;
    }

    const next = classifyAge(album, cfg);
    nextClassification[album.album] = next; // display state is always current

    const prev = nextAlerted[album.album];
    if (next === prev) continue;
    if (!alertsActive) continue; // edge preserved for a later, meaningful tick

    if (next === "starving") {
      const hrs = Math.round(album.ageMs / 3600000);
      const where = album.agedOut
        ? ` (aged out of the last ${historyLen} tracks)`
        : ` (plays in window: ${album.playsInWindow})`;
      alerts.push({
        transition: "CURATOR_ALBUM_STARVING",
        message: `"${album.album}" — ${hrs}h since last play${where}`,
        subject: "KANNAKA.staff.album.starving",
        payload: { album: album.album, ageMs: album.ageMs, playsInWindow: album.playsInWindow },
      });
    } else if (next === "never" && prev !== "never") {
      alerts.push({
        transition: "CURATOR_ALBUM_NEVER_PLAYED",
        message: `"${album.album}" registered but never observed playing — check that files exist`,
        subject: "KANNAKA.staff.album.never_played",
        payload: { album: album.album, historyLen },
      });
    } else if (prev === "starving" && next !== "starving") {
      alerts.push({
        transition: "CURATOR_ALBUM_REFRESHED",
        message: `"${album.album}" back in rotation`,
        subject: "KANNAKA.staff.album.refreshed",
        payload: { album: album.album },
      });
    }
    nextAlerted[album.album] = next;
  }

  return {
    alertsActive,
    alerts,
    classification: nextClassification,
    alerted: nextAlerted,
    everPlayed: nextEverPlayed,
  };
}

function bootCurator(deps) {
  const RADIO_BASE = deps.radioBase;
  const ALERTS_FILE = deps.alertsFile;
  const STATE_FILE = path.join(path.dirname(ALERTS_FILE), "curator-state.json");
  const bus = deps.staffBus || null;

  function publish(subject, payload) {
    if (!bus) return;
    bus.emit(subject, { ts: Date.now(), source: "curator", subject, payload });
  }

  const cfg = {
    tickMs: readEnvMs("CURATOR_TICK_MS", DEFAULTS.TICK_MS),
    starvingMs: readEnvMs("CURATOR_STARVING_MS", DEFAULTS.STARVING_MS),
    agingMs: readEnvMs("CURATOR_AGING_MS", DEFAULTS.AGING_MS),
    historyLimit: parseInt(process.env.CURATOR_HISTORY_LIMIT || "", 10) || DEFAULTS.HISTORY_LIMIT,
    minHistoryForAlerts: parseInt(process.env.CURATOR_MIN_HISTORY_FOR_ALERTS || "", 10) || DEFAULTS.MIN_HISTORY_FOR_ALERTS,
    enabled: process.env.CURATOR_ENABLED !== "false",
  };

  // classification state per album: "fresh" | "aging" | "starving" | "never"
  const c = {
    cfg,
    bootedAt: Date.now(),
    lastTick: null,
    lastSnapshot: null,
    classification: {},  // {album: "fresh|aging|starving|never"} — display
    alerted: {},         // {album: last classification we actually alerted on}
    everPlayed: {},      // {album: newest playedAt we have ever observed}
  };

  try {
    if (fs.existsSync(STATE_FILE)) {
      const persisted = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
      if (persisted && typeof persisted === "object" && persisted.classification) {
        c.classification = persisted.classification;
        // Older state files predate the alerted/everPlayed split; seeding
        // alerted from classification keeps their edges from re-firing.
        c.alerted = persisted.alerted || { ...persisted.classification };
        c.everPlayed = persisted.everPlayed || {};
      }
    }
  } catch (e) {
    console.warn(`[curator] state load: ${e.message}`);
  }

  function persist() {
    try {
      fs.writeFileSync(STATE_FILE, JSON.stringify({
        classification: c.classification,
        alerted: c.alerted,
        everPlayed: c.everPlayed,
      }, null, 2));
    } catch (e) {
      console.warn(`[curator] state save: ${e.message}`);
    }
  }

  function logAlert(transition, message) {
    const entry = {
      ts: new Date().toISOString(),
      probe: "curator",
      transition,
      message,
    };
    try {
      fs.appendFileSync(ALERTS_FILE, JSON.stringify(entry) + "\n");
    } catch (e) {
      console.warn(`[curator] alert write: ${e.message}`);
    }
    console.log(`[curator] ${transition}: ${message}`);
  }

  const classify = (album) => classifyAge(album, cfg);

  async function tick() {
    if (!cfg.enabled) return;
    const snap = await fetchStaleness(RADIO_BASE, cfg.historyLimit);
    c.lastTick = Date.now();
    if (!snap.ok) {
      console.warn(`[curator] tick skipped — ${snap.message}`);
      return;
    }
    c.lastSnapshot = snap;
    // Gate alerting until the radio has played enough tracks for the
    // history window to actually mean something. Classification still
    // updates so the dashboard reflects current state; only the
    // alerts.jsonl writes wait for signal-over-noise.
    const r = evaluateAlbums({
      cfg,
      albums: snap.albums,
      historyLen: snap.historyLen,
      classification: c.classification,
      alerted: c.alerted,
      everPlayed: c.everPlayed,
    });
    for (const a of r.alerts) {
      logAlert(a.transition, a.message);
      publish(a.subject, a.payload);
    }
    c.classification = r.classification;
    c.alerted = r.alerted;
    c.everPlayed = r.everPlayed;
    const alertsActive = r.alertsActive;
    if (!alertsActive && Object.keys(c.classification).length > 0 && snap.historyLen === 0) {
      // First-tick after a fresh restart: print one info line so the
      // operator knows Curator is alive but silent on purpose.
      console.log(`[curator] tick · history empty (${snap.albums.length} albums known) — alerts suppressed until ≥ ${cfg.minHistoryForAlerts} plays`);
    }
    persist();
  }

  // First tick deferred ~45s so the watcher's baseline probes establish
  // first; staggered from Growth's 30s so we don't burst-hit the radio.
  // unref'd so these timers never hold the event loop open on their own —
  // in production the HTTP listener does that, and a bootCurator() call
  // in a test must not keep the runner alive or reach a live radio fetch.
  setTimeout(() => { tick().catch((e) => console.warn(`[curator] first tick: ${e.message}`)); }, 45_000).unref();
  setInterval(() => { tick().catch((e) => console.warn(`[curator] tick: ${e.message}`)); }, cfg.tickMs).unref();

  return {
    getState() {
      const classes = { fresh: 0, aging: 0, starving: 0, never: 0 };
      for (const v of Object.values(c.classification)) {
        if (classes[v] != null) classes[v]++;
      }
      return {
        cfg,
        bootedAt: c.bootedAt,
        lastTick: c.lastTick,
        snapshot: c.lastSnapshot,
        classification: c.classification,
        counts: classes,
      };
    },
    tick,
    /** Albums currently classified as starving, oldest-aged first. */
    starvingAlbums() {
      const snap = c.lastSnapshot;
      if (!snap || !snap.ok) return [];
      return snap.albums
        .filter((a) => c.classification[a.album] === "starving")
        .sort((a, b) => (b.ageMs || 0) - (a.ageMs || 0));
    },
  };
}

module.exports = { bootCurator, evaluateAlbums, classifyAge };
