/**
 * Voice — Phase 3 (ADR-001 § 4), observation MVP.
 *
 * The full Voice role owns the talk-segment lock arbitration: who can
 * speak when (peace orations vs DJ intros vs showcase narration vs
 * live broadcast). That's deep state inside kannaka-radio and not
 * portable as-is. Tonight's MVP is the observer:
 *
 *   - Tick every 90s.
 *   - Pull radio /api/state, inspect lock state (DJ talk segment,
 *     voice queue depth, ongoing oration).
 *   - Edge-trigger VOICE_LOCK_STUCK if the lock has been held longer
 *     than the configured threshold (default 5 min — the 2026-04-30
 *     stuck-lock incident was the canonical bad day).
 *   - VOICE_LOCK_RECOVERED when the lock clears after a stuck alert.
 *
 * Persistence: <ALERTS_FILE dir>/voice-state.json (last-known lock).
 *
 * Routes:
 *   GET /api/voice
 */
"use strict";

const fs = require("fs");
const http = require("http");
const https = require("https");
const path = require("path");
const url = require("url");

const { readEnvMs } = require("../util");

const DEFAULTS = {
  TICK_MS: 90 * 1000,
  STUCK_MS: 5 * 60 * 1000,
  // kannaka-radio exposes the talk-segment lock on its DJ-voice route.
  // /api/state carries only `djVoice: { enabled }` — none of the lock
  // fields this role was reading — so the lock always read as free and
  // VOICE_LOCK_STUCK could never fire.
  STATUS_PATH: "/api/dj-voice/status",
};

/**
 * Read the talk-segment lock out of a radio status payload (exported for
 * tests). Accepts the /api/dj-voice/status shape and the older
 * /api/state-style field names so a radio that has not been upgraded
 * still reports something sane.
 */
function lockFromStatus(s) {
  if (!s || typeof s !== "object") return null;
  const lockHeld = !!(
    s.inTalkSegment || s._inTalkSegment ||
    (s.talk && s.talk.locked) || (s.voice && s.voice.locked)
  );
  return {
    lockHeld,
    speaking: typeof s.speaking === "boolean" ? s.speaking : null,
    voiceQueue: s.voice && typeof s.voice.queueDepth === "number" ? s.voice.queueDepth : null,
    currentSpeaker: (s.voice && s.voice.currentSpeaker) || s.lastIntro || null,
  };
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
        catch (_) { resolve({ ok: false, json: null, raw: text.slice(0, 400) }); }
      };
      res.on("end", settle);
      res.on("close", settle);
    });
    req.on("error", (e) => resolve({ ok: false, error: e.message }));
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.end();
  });
}

function bootVoice(deps) {
  const RADIO_BASE = deps.radioBase;
  const ALERTS_FILE = deps.alertsFile;
  const STATE_FILE = path.join(path.dirname(ALERTS_FILE), "voice-state.json");
  const bus = deps.staffBus || null;

  function publish(subject, payload) {
    if (!bus) return;
    bus.emit(subject, { ts: Date.now(), source: "voice", subject, payload });
  }

  const cfg = {
    tickMs: readEnvMs("VOICE_TICK_MS", DEFAULTS.TICK_MS),
    stuckMs: readEnvMs("VOICE_STUCK_MS", DEFAULTS.STUCK_MS),
    statusPath: (process.env.VOICE_STATUS_PATH || "").trim() || DEFAULTS.STATUS_PATH,
    enabled: process.env.VOICE_ENABLED !== "false",
  };

  const v = {
    cfg,
    bootedAt: Date.now(),
    lastTick: null,
    lockObservedAt: null,   // ms — when current lock first appeared
    lockStuckAlerted: false,
    lastSeenAt: null,       // ms — last tick that actually observed the radio
    snapshot: null,
  };

  // Deliberately NOT restoring lockObservedAt/lockStuckAlerted. The
  // held-duration is a claim about continuous observation, and a restart
  // breaks exactly that: if the radio restarted too, the lock is new but
  // the persisted timer is old, and Voice would alert "held 47 min" on a
  // lock it had watched for seconds. Starting the clock fresh costs at
  // most one stuckMs window before a genuinely stuck lock is reported.
  try {
    if (fs.existsSync(STATE_FILE)) JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
  } catch (e) { console.warn(`[voice] state load: ${e.message}`); }

  function persist() {
    try { fs.writeFileSync(STATE_FILE, JSON.stringify({ lockObservedAt: v.lockObservedAt, lockStuckAlerted: v.lockStuckAlerted }, null, 2)); }
    catch (e) { console.warn(`[voice] state save: ${e.message}`); }
  }
  function logAlert(transition, message) {
    const entry = { ts: new Date().toISOString(), probe: "voice", transition, message };
    try { fs.appendFileSync(ALERTS_FILE, JSON.stringify(entry) + "\n"); }
    catch (e) { console.warn(`[voice] alert write: ${e.message}`); }
    console.log(`[voice] ${transition}: ${message}`);
  }

  async function tick() {
    if (!cfg.enabled) return;
    const r = await probeJson(`${RADIO_BASE}${cfg.statusPath}`);
    const now = Date.now();
    v.lastTick = now;
    if (!r.ok || !r.json) {
      // We could not observe the radio. The held-duration counts OBSERVED
      // time, so discount the blind interval by pushing the start stamp
      // forward — otherwise an outage silently accrues "held" minutes and
      // trips the stuck alert (which restarts the radio) on no evidence.
      if (v.lockObservedAt != null && v.lastSeenAt != null) {
        v.lockObservedAt += now - v.lastSeenAt;
      }
      v.lastSeenAt = now;
      return;
    }
    v.lastSeenAt = now;
    const snap = lockFromStatus(r.json);
    if (!snap) return;
    const lockHeld = snap.lockHeld;
    v.snapshot = snap;
    if (lockHeld) {
      if (v.lockObservedAt == null) v.lockObservedAt = Date.now();
      const heldFor = Date.now() - v.lockObservedAt;
      if (heldFor > cfg.stuckMs && !v.lockStuckAlerted) {
        logAlert("VOICE_LOCK_STUCK", `talk-segment lock held ${Math.round(heldFor / 60000)} min — investigate`);
        v.lockStuckAlerted = true;
        publish("KANNAKA.staff.voice.lock.stuck", {
          heldForMs: heldFor,
          currentSpeaker: v.snapshot && v.snapshot.currentSpeaker,
          voiceQueue: v.snapshot && v.snapshot.voiceQueue,
        });
      }
    } else {
      if (v.lockStuckAlerted) {
        const heldFor = v.lockObservedAt ? (Date.now() - v.lockObservedAt) : 0;
        logAlert("VOICE_LOCK_RECOVERED", `lock cleared after ${Math.round(heldFor / 60000)} min`);
        publish("KANNAKA.staff.voice.lock.recovered", { heldForMs: heldFor });
      }
      v.lockObservedAt = null;
      v.lockStuckAlerted = false;
    }
    persist();
  }

  // unref'd so these timers never hold the event loop open on their own —
  // in production the HTTP listener does that, and a bootVoice() call in
  // a test must not keep the runner alive or reach a live radio fetch.
  setTimeout(() => { tick().catch((e) => console.warn(`[voice] first tick: ${e.message}`)); }, 60_000).unref();
  setInterval(() => { tick().catch((e) => console.warn(`[voice] tick: ${e.message}`)); }, cfg.tickMs).unref();

  return {
    getState() {
      return {
        cfg,
        bootedAt: v.bootedAt,
        lastTick: v.lastTick,
        snapshot: v.snapshot,
        lockObservedAt: v.lockObservedAt,
        lockHeldForMs: v.lockObservedAt ? Date.now() - v.lockObservedAt : 0,
        lockStuckAlerted: v.lockStuckAlerted,
      };
    },
    tick,
  };
}

module.exports = { bootVoice, lockFromStatus };
