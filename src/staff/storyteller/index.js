/**
 * Storyteller — Phase 4 (ADR-001 § 9), observation MVP.
 *
 * The full Storyteller composes album showcase narration, oration
 * framing, programming-transition copy, and Kannaka's self-pondering
 * voice. That belongs co-resident with the existing showcase
 * machinery inside kannaka-radio. The staff role's tonight-MVP is
 * the planner: surface what the showcase landscape looks like next,
 * so the operator (or future automated nudger) sees an upcoming
 * narration window and can prepare.
 *
 * Tick (default 5 min):
 *   - Pull radio /api/state for current block + override + last
 *     showcase fire-times (via /api/programming if present, falling
 *     back to /api/state's `programming` block).
 *   - Compute time-to-next-scheduled-showcase from the radio's
 *     DAILY_SHOWCASES rules (today: BEND THE ARC at 11 AM + 9 PM CST).
 *   - Surface "showcase in flight" or "next showcase in HH:MM".
 *
 * No alerts in MVP — Storyteller is observational. Operators read
 * the dashboard panel.
 *
 * Routes:
 *   GET /api/storyteller
 */
"use strict";

const http = require("http");
const https = require("https");
const url = require("url");

const { readEnvMs } = require("../util");

const DEFAULTS = {
  TICK_MS: 5 * 60 * 1000,
  // The programming block and the album override live on /api/programming
  // (programming.getStatus()). /api/state carries neither, so every field
  // this role read off it was permanently null.
  PROGRAMMING_PATH: "/api/programming",
  SCHEDULED_HOURS: [11, 21],   // DAILY_SHOWCASES, local radio time
  TIMEZONE: "America/Chicago", // CST/CDT — the DST transition is the point
  WINDOW_MIN: 60,              // a showcase is "in progress" for this long
};

/**
 * Local wall-clock hour/minute in the radio's timezone (exported for
 * tests). The old code subtracted a fixed 5 hours from UTC, which is
 * right for CDT and an hour wrong for CST every winter.
 */
function localHourMinute(now, timeZone) {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone, hour: "2-digit", minute: "2-digit", hour12: false,
    }).formatToParts(now);
    const get = (t) => parseInt(parts.find((p) => p.type === t).value, 10);
    const hour = get("hour");
    return { hour: hour === 24 ? 0 : hour, minute: get("minute") };
  } catch (_) {
    // No ICU / unknown zone — fall back to the old fixed-offset guess
    // rather than failing the whole snapshot.
    return { hour: ((now.getUTCHours() - 5) + 24) % 24, minute: now.getUTCMinutes() };
  }
}

/**
 * Minutes until the next scheduled showcase, or 0 with inProgress=true
 * when we are inside one. The old arithmetic mapped "now" onto "in ~24h":
 * during the whole fire hour the countdown read 23-something hours, so
 * the operator was never told a showcase was actually running.
 */
function nextShowcase({ hour, minute }, scheduledHours, windowMin) {
  let best = null;
  for (const h of scheduledHours) {
    const mins = (h - hour) * 60 - minute;
    if (mins <= 0 && mins > -windowMin) return { inMinutes: 0, inProgress: true, hour: h };
    const candidate = mins <= 0 ? mins + 24 * 60 : mins;
    if (best == null || candidate < best.inMinutes) best = { inMinutes: candidate, inProgress: false, hour: h };
  }
  return best;
}

function probeJson(target, timeoutMs = 5000) {
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
      res.on("data", (c) => chunks.push(c));
      const settle = () => {
        const text = Buffer.concat(chunks).toString("utf8");
        try { resolve({ ok: res.statusCode < 400, json: JSON.parse(text) }); }
        catch (_) { resolve({ ok: false, raw: text.slice(0, 400) }); }
      };
      res.on("end", settle);
      res.on("close", settle);
    });
    req.on("error", (e) => resolve({ ok: false, error: e.message }));
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.end();
  });
}

function bootStoryteller(deps) {
  const RADIO_BASE = deps.radioBase;

  const cfg = {
    tickMs: readEnvMs("STORYTELLER_TICK_MS", DEFAULTS.TICK_MS),
    programmingPath: (process.env.STORYTELLER_PROGRAMMING_PATH || "").trim() || DEFAULTS.PROGRAMMING_PATH,
    timezone: (process.env.STORYTELLER_TZ || "").trim() || DEFAULTS.TIMEZONE,
    enabled: process.env.STORYTELLER_ENABLED !== "false",
  };

  const s = {
    cfg,
    bootedAt: Date.now(),
    lastTick: null,
    snapshot: null,
  };

  async function tick() {
    if (!cfg.enabled) return;
    const r = await probeJson(`${RADIO_BASE}${cfg.programmingPath}`);
    s.lastTick = Date.now();
    if (!r.ok || !r.json) {
      s.snapshot = { ok: false, error: r.error || `no ${cfg.programmingPath}` };
      return;
    }
    const j = r.json;
    // programming.getStatus() shape: { currentBlock, mood, currentAlbum,
    // override, ... }. The older /api/state-style names are still accepted
    // so a radio that has not been upgraded degrades rather than breaks.
    const override = j.override || j.programmingOverride || j.programming?.override || null;
    const overrideActive = !!(override && (override.until ? Date.now() < override.until : true));
    const local = localHourMinute(new Date(), cfg.timezone);
    const next = nextShowcase(local, DEFAULTS.SCHEDULED_HOURS, DEFAULTS.WINDOW_MIN);
    s.snapshot = {
      ok: true,
      currentAlbum: j.currentAlbum || (j.programming && j.programming.currentAlbum) || null,
      block: j.currentBlock || j.programming?.block || j.block || null,
      mood: j.mood || null,
      override: overrideActive
        ? {
            album: override.album,
            untilMs: override.until || null,
            untilHuman: override.until ? new Date(override.until).toISOString() : null,
          }
        : null,
      localTime: `${String(local.hour).padStart(2, "0")}:${String(local.minute).padStart(2, "0")} ${cfg.timezone}`,
      nextShowcase: {
        inMinutes: next ? next.inMinutes : null,
        inProgress: !!(next && next.inProgress),
        fixedSchedule: `${DEFAULTS.SCHEDULED_HOURS.map((h) => `${h}:00`).join(" + ")} ${cfg.timezone}`,
      },
    };
  }

  // unref'd so these timers never hold the event loop open on their own —
  // in production the HTTP listener does that, and a bootStoryteller() call
  // in a test must not keep the runner alive or reach a live radio fetch.
  setTimeout(() => { tick().catch((err) => console.warn(`[storyteller] first tick: ${err.message}`)); }, 90_000).unref();
  setInterval(() => { tick().catch((err) => console.warn(`[storyteller] tick: ${err.message}`)); }, cfg.tickMs).unref();

  return {
    getState() {
      return { cfg, bootedAt: s.bootedAt, lastTick: s.lastTick, snapshot: s.snapshot };
    },
    tick,
  };
}

module.exports = { bootStoryteller, localHourMinute, nextShowcase };
