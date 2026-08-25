/**
 * Growth — second staff role online (ADR-001 § 6, Phase 1 critical).
 *
 * Watches the medium. Schedules dream consolidation on a cadence so
 * the HRM doesn't drift into the timeout-blown territory that broke
 * kannaka-ask in early May 2026.
 *
 * Decision tree on each Growth tick (default 15 min):
 *
 *   - dream already in flight  → no-op
 *   - HRM size > HARD threshold (95 MB default)  → fire lite dream NOW
 *   - HRM size > SOFT threshold (70 MB default) AND last dream > 6h ago
 *                                                → fire lite dream
 *   - last successful dream > NORMAL_INTERVAL (12h) ago
 *                                                → fire lite dream
 *   - else → no-op, sample HRM history
 *
 * Why lite, not deep: ADR-001 § Dream Maintenance — the bug is that
 * deep dreams time out on bloated mediums and the workaround was
 * routing orations through Anthropic-direct. Lite dreams complete
 * reliably and are the right tool until the deep-dream chunking
 * lands in kannaka-memory itself. When that lands, flip the default
 * via GROWTH_DEFAULT_MODE=deep.
 *
 * State persistence: <ALERTS_FILE dir>/growth-state.json. Restarts
 * preserve `lastDream` and the in-memory hrmHistory tail (so the
 * dashboard's HRM trend doesn't lose all context across a restart).
 *
 * Alerts: state transitions are logged to alerts.jsonl using the
 * watcher's writer so the operator's one alert stream still tells
 * the whole story. Transitions emitted by Growth:
 *
 *   GROWTH_DREAM_START      a dream was launched (kind: lite|deep, reason)
 *   GROWTH_DREAM_DONE       successful return; size delta in message
 *   GROWTH_DREAM_FAILED     non-zero exit OR timeout; raw stderr tail
 *   GROWTH_HRM_BLOATED      one-shot when crossing HARD threshold while
 *                           a dream is unable to run (e.g. in-flight)
 *   GROWTH_HRM_RECOVERED    HRM came back under SOFT after being bloated
 *
 * Exposed API on the http server (wired by src/index.js):
 *   GET  /api/growth  →  { lastTick, hrm, lastDream, dreamHistory, hrmHistory }
 */
"use strict";

const { exec } = require("child_process");
const fs = require("fs");
const path = require("path");

const { readEnvMs, statusCachePathFor } = require("../util");

const DEFAULTS = {
  TICK_MS: 15 * 60 * 1000,            // 15 min
  // Size-based thresholds are tuned for the primary HRM (37 MB typical,
  // 70 MB worrying, 95 MB critical). Hosts whose HRM is small but
  // memory-count grows fast (e.g. the witness, which accumulates audio:
  // perception ticks) should override these via env vars to lower
  // values OR rely on the count-based thresholds below instead.
  HRM_SOFT_MB: 70,
  HRM_HARD_MB: 95,
  // Count-based thresholds — added 2026-05-14 after the witness HRM
  // blew up to 7753 entries while staying small in bytes. A host
  // exceeding the count threshold fires the same lite dream as for
  // size — the dream pass + downstream prune-cron drives the count
  // back down. Defaults are generous for the primary HRM; the
  // witness should env-override to ~150 / ~300.
  MEMORY_SOFT: 1200,
  MEMORY_HARD: 2000,
  NORMAL_INTERVAL_MS: 12 * 60 * 60 * 1000,  // 12h
  SOFT_MIN_GAP_MS: 6 * 60 * 60 * 1000,      // 6h
  // Minimum gap between dreams dispatched by a HARD breach. Shorter than the
  // soft gap because a HARD breach is genuinely more urgent, but NOT zero:
  // before this existed the HARD branch fired on every tick, and a store
  // parked above the threshold dreamed 96 times a day to no effect.
  HARD_MIN_GAP_MS: 60 * 60 * 1000,          // 1h
  DREAM_TIMEOUT_MS: 12 * 60 * 1000,         // 12 min — slightly more than
                                            // the watcher's trigger-dream
                                            // budget so we can detect a
                                            // hang vs. a real long dream
  DREAM_HISTORY_MAX: 20,
  HRM_HISTORY_MAX: 96,                       // 96 × 15min = 24h trend
  // How long a failed dream holds the cadence off. Without this the
  // normal-cadence branch relaunches the same broken dream every tick,
  // because a failure leaves the "last successful dream" stamp at 0.
  FAIL_BACKOFF_MS: 60 * 60 * 1000,           // 1h
};

function readEnvMB(name, fallback) {
  const v = parseFloat(process.env[name] || "");
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

function readEnvStr(name, fallback) {
  const v = (process.env[name] || "").trim();
  return v || fallback;
}

// ── Pure decision helpers (exported for tests) ──────────────
// Split out of the bootGrowth closure so the suite can drive the
// cadence and bloat-edge logic directly, without booting timers or
// exec'ing the kannaka binary.

/**
 * Edge-trigger for the bloat alert (one-shot per bloat episode). Either
 * size OR count crossing HARD counts as bloat; recovery needs both back
 * under SOFT. Returns the transition to log, or null when nothing
 * changed. Deliberately independent of the in-flight state — a medium
 * that bloats while a dream is already running is the case the alert
 * exists for.
 */
function bloatTransition({ cfg, sample, bloatedAlerted }) {
  if (sample.sizeMB == null) return null;
  const sizeBloated = sample.sizeMB >= cfg.hrmHardMB;
  const countBloated = sample.memoryCount != null && sample.memoryCount >= cfg.memoryHard;
  const sizeRecovered = sample.sizeMB < cfg.hrmSoftMB;
  const countRecovered = sample.memoryCount == null || sample.memoryCount < cfg.memorySoft;
  if ((sizeBloated || countBloated) && !bloatedAlerted) {
    const reason = sizeBloated
      ? `HRM=${sample.sizeMB.toFixed(1)} MB >= ${cfg.hrmHardMB} MB`
      : `${sample.memoryCount} memories >= ${cfg.memoryHard}`;
    return {
      transition: "GROWTH_HRM_BLOATED",
      message: `${reason} — kicking ${cfg.defaultMode} dream`,
      bloatedAlerted: true,
    };
  }
  if (sizeRecovered && countRecovered && bloatedAlerted) {
    const where = sample.memoryCount != null
      ? `${sample.sizeMB.toFixed(1)} MB / ${sample.memoryCount} memories`
      : `${sample.sizeMB.toFixed(1)} MB`;
    return {
      transition: "GROWTH_HRM_RECOVERED",
      message: `${where} back under SOFT (${cfg.hrmSoftMB} MB / ${cfg.memorySoft} memories)`,
      bloatedAlerted: false,
    };
  }
  return null;
}

/**
 * One tick's full evaluation: which alert edge to log (if any) and what
 * to do. The ordering here is load-bearing — the bloat edge is decided
 * BEFORE the cadence defers to an in-flight dream, because a medium
 * crossing HARD while a dream is already running is exactly the episode
 * GROWTH_HRM_BLOATED exists to report.
 */
function evaluateTick({ cfg, sample, lastDream, inFlight, bloatedAlerted, now = Date.now() }) {
  if (!cfg.enabled) return { bloat: null, decision: null };
  return {
    bloat: bloatTransition({ cfg, sample, bloatedAlerted }),
    decision: decideDream({ cfg, sample, lastDream, inFlight, now }),
  };
}

/**
 * Below this, a change in HRM size is noise rather than a result. A lite dream
 * on a settled field reports deltas in the 1e-3 MB range purely from
 * re-serialisation.
 */
const EFFECT_EPSILON_MB = 0.05;

/**
 * Did the last dream actually move either number it is dispatched to reduce?
 *
 * `ok: true` means the binary exited cleanly, NOT that anything improved. A
 * lite dream cannot prune, strengthen or connect, so on a store that is over a
 * HARD threshold it completes successfully and changes nothing — and the
 * condition that dispatched it is still true on the next tick.
 *
 * Returns false when before/after are missing: an unknown is not evidence of
 * ineffectiveness, and this must never be the reason a real remedy is skipped.
 */
function dreamMovedNothing(lastDream) {
  if (!lastDream || !lastDream.ok) return false;
  const b = lastDream.before;
  const a = lastDream.after;
  if (!b || !a) return false;
  const sizeFell =
    a.sizeMB != null && b.sizeMB != null && a.sizeMB < b.sizeMB - EFFECT_EPSILON_MB;
  const countFell =
    a.memoryCount != null && b.memoryCount != null && a.memoryCount < b.memoryCount;
  return !sizeFell && !countFell;
}

/**
 * Should a HARD-threshold breach be held off this tick? `null` = go ahead.
 *
 * Two gates, in order:
 *   1. Cadence. Even a genuine emergency does not want a dream every 15 min —
 *      back-to-back passes on an unchanged store re-melt the same structure.
 *   2. Effectiveness. If the previous dream ran clean and moved neither number,
 *      repeating the SAME mode cannot clear the threshold. Escalate once to
 *      deep — the only mode that can strengthen and connect — and if deep also
 *      moved nothing, stop and say so, because the remedy is not the problem.
 */
function hardBranchBlock({ cfg, lastDream, sinceLast, over }) {
  if (sinceLast < cfg.hardMinGapMs) {
    return {
      action: "skip",
      reason: `${over}, but last dream ${Math.round(sinceLast / 60000)}m ago — hard-branch gap ${Math.round(cfg.hardMinGapMs / 60000)}m`,
    };
  }
  if (dreamMovedNothing(lastDream)) {
    if (lastDream.mode !== "deep") {
      return {
        action: "dream",
        mode: "deep",
        reason: `${over}; last ${lastDream.mode} dream moved nothing — escalating to deep`,
      };
    }
    return {
      action: "skip",
      reason: `${over}; last deep dream moved nothing — dreaming cannot clear this, needs an operator`,
    };
  }
  return null;
}

/** Cadence decision: { action: "dream"|"wait"|"skip", mode?, reason }. */
function decideDream({ cfg, sample, lastDream, inFlight, now = Date.now() }) {
  const inFlightWait = inFlight
    ? { action: "wait", reason: `dream in flight (${inFlight.mode}, ${Math.round((now - inFlight.startedAt) / 1000)}s)` }
    : null;
  if (sample.sizeMB == null) {
    return inFlightWait || { action: "skip", reason: "HRM not readable on this host" };
  }
  if (inFlightWait) return inFlightWait;

  // A failed dream still counts as an attempt. Gating the cadence on
  // successes alone leaves sinceLast pinned at ~now forever after a
  // failure, so the normal-cadence branch relaunches the same broken
  // dream every single tick.
  if (lastDream && !lastDream.ok) {
    const sinceFail = now - lastDream.ts;
    if (sinceFail < cfg.failBackoffMs) {
      return {
        action: "skip",
        reason: `last ${lastDream.mode} dream failed ${Math.round(sinceFail / 60000)}m ago — backoff ${Math.round(cfg.failBackoffMs / 60000)}m`,
      };
    }
  }

  const lastTs = lastDream && lastDream.ok ? lastDream.ts : 0;
  const sinceLast = now - lastTs;

  // The HARD branches were the only two with no cadence gate at all — SOFT
  // checks softMinGapMs, normal checks normalIntervalMs, HARD checked nothing.
  // A host whose HRM sits permanently above HARD therefore dreamed on EVERY
  // tick, forever. That is the same defect shape as #64 above (a failed dream
  // relaunching every tick), in the other direction: here the dream *succeeds*
  // and still never clears the condition that triggered it.
  //
  // Measured on the witness 2026-08-22..25: HARD=50 MB against a 98 MB store,
  // 289 lite dreams in 3 days, 7.7 hours of compute, and the memory count it
  // was trying to reduce rose 553 → 1280 while Xi fell 32%.
  const overHardSize = sample.sizeMB >= cfg.hrmHardMB;
  const overHardCount = sample.memoryCount != null && sample.memoryCount >= cfg.memoryHard;
  if (overHardSize || overHardCount) {
    const over = overHardSize
      ? `HRM ${sample.sizeMB.toFixed(1)} MB ≥ HARD ${cfg.hrmHardMB} MB`
      : `${sample.memoryCount} memories ≥ HARD ${cfg.memoryHard}`;
    const blocked = hardBranchBlock({ cfg, lastDream, sinceLast, over });
    if (blocked) return blocked;
    return { action: "dream", mode: cfg.defaultMode, reason: over };
  }
  if (sample.sizeMB >= cfg.hrmSoftMB && sinceLast >= cfg.softMinGapMs) {
    return { action: "dream", mode: cfg.defaultMode, reason: `HRM ${sample.sizeMB.toFixed(1)} MB ≥ SOFT ${cfg.hrmSoftMB} MB + ${Math.round(sinceLast / 3600000)}h since last` };
  }
  if (sample.memoryCount != null && sample.memoryCount >= cfg.memorySoft && sinceLast >= cfg.softMinGapMs) {
    return { action: "dream", mode: cfg.defaultMode, reason: `${sample.memoryCount} memories ≥ SOFT ${cfg.memorySoft} + ${Math.round(sinceLast / 3600000)}h since last` };
  }
  if (sinceLast >= cfg.normalIntervalMs) {
    return { action: "dream", mode: cfg.defaultMode, reason: `${Math.round(sinceLast / 3600000)}h since last (normal cadence)` };
  }
  const countStr = sample.memoryCount != null ? `, ${sample.memoryCount} memories` : "";
  return { action: "skip", reason: `HRM ${sample.sizeMB.toFixed(1)} MB${countStr}, last dream ${Math.round(sinceLast / 60000)}m ago` };
}

function bootGrowth(deps) {
  const HRM_PATH = deps.hrmPath;
  const ALERTS_FILE = deps.alertsFile;
  const bus = deps.staffBus || null;

  // ADR-003 § subjects. Growth was handed the bus at boot but never
  // published, so every dream and bloat episode was invisible to the
  // rest of the crew and to the dashboard's bus panel.
  function publish(subject, payload) {
    if (!bus) return;
    bus.emit(subject, { ts: Date.now(), source: "growth", subject, payload });
  }
  const KANNAKA_BIN = readEnvStr("KANNAKA_BIN", "/home/opc/kannaka-memory/target/release/kannaka");
  const STATE_FILE = path.join(path.dirname(ALERTS_FILE), "growth-state.json");
  const STATUS_CACHE_PATH = statusCachePathFor(HRM_PATH);

  const cfg = {
    tickMs: readEnvMs("GROWTH_TICK_MS", DEFAULTS.TICK_MS),
    hrmSoftMB: readEnvMB("GROWTH_HRM_SOFT_MB", DEFAULTS.HRM_SOFT_MB),
    hrmHardMB: readEnvMB("GROWTH_HRM_HARD_MB", DEFAULTS.HRM_HARD_MB),
    memorySoft: parseInt(process.env.GROWTH_MEMORY_SOFT || "", 10) || DEFAULTS.MEMORY_SOFT,
    memoryHard: parseInt(process.env.GROWTH_MEMORY_HARD || "", 10) || DEFAULTS.MEMORY_HARD,
    normalIntervalMs: readEnvMs("GROWTH_NORMAL_INTERVAL_MS", DEFAULTS.NORMAL_INTERVAL_MS),
    softMinGapMs: readEnvMs("GROWTH_SOFT_MIN_GAP_MS", DEFAULTS.SOFT_MIN_GAP_MS),
    hardMinGapMs: readEnvMs("GROWTH_HARD_MIN_GAP_MS", DEFAULTS.HARD_MIN_GAP_MS),
    dreamTimeoutMs: readEnvMs("GROWTH_DREAM_TIMEOUT_MS", DEFAULTS.DREAM_TIMEOUT_MS),
    failBackoffMs: readEnvMs("GROWTH_FAIL_BACKOFF_MS", DEFAULTS.FAIL_BACKOFF_MS),
    defaultMode: readEnvStr("GROWTH_DEFAULT_MODE", "lite"),
    enabled: process.env.GROWTH_ENABLED !== "false",  // on by default; opt-out
  };

  // Internal state — exposed read-only via getState().
  const g = {
    cfg,
    bootedAt: Date.now(),
    lastTick: null,
    inFlight: null,            // { startedAt, mode, reason, timer }
    lastDream: null,            // { ts, mode, ok, durationMs, message, before, after, reason }
    dreamHistory: [],           // newest last
    hrmHistory: [],             // [{ts, sizeMB, memoryCount|null}]
    bloatedAlerted: false,      // edge-trigger for GROWTH_HRM_BLOATED
  };

  // ── load persisted state on boot (best-effort) ──────────
  try {
    if (fs.existsSync(STATE_FILE)) {
      const persisted = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
      if (persisted && typeof persisted === "object") {
        if (persisted.lastDream) g.lastDream = persisted.lastDream;
        if (Array.isArray(persisted.dreamHistory)) g.dreamHistory = persisted.dreamHistory.slice(-DEFAULTS.DREAM_HISTORY_MAX);
        if (Array.isArray(persisted.hrmHistory)) g.hrmHistory = persisted.hrmHistory.slice(-DEFAULTS.HRM_HISTORY_MAX);
        if (typeof persisted.bloatedAlerted === "boolean") g.bloatedAlerted = persisted.bloatedAlerted;
      }
    }
  } catch (e) {
    console.warn(`[growth] state load: ${e.message}`);
  }

  function persist() {
    try {
      fs.writeFileSync(STATE_FILE, JSON.stringify({
        lastDream: g.lastDream,
        dreamHistory: g.dreamHistory,
        hrmHistory: g.hrmHistory,
        bloatedAlerted: g.bloatedAlerted,
      }, null, 2));
    } catch (e) {
      console.warn(`[growth] state save: ${e.message}`);
    }
  }

  function logAlert(transition, message) {
    const entry = {
      ts: new Date().toISOString(),
      probe: "growth",
      transition,
      message,
    };
    try {
      fs.appendFileSync(ALERTS_FILE, JSON.stringify(entry) + "\n");
    } catch (e) {
      console.warn(`[growth] alert write: ${e.message}`);
    }
    console.log(`[growth] ${transition}: ${message}`);
  }

  // ── HRM sampling ────────────────────────────
  function sampleHrm() {
    let sizeMB = null;
    try {
      sizeMB = fs.statSync(HRM_PATH).size / (1024 * 1024);
    } catch (_) {
      // HRM file unreadable here — most likely external mode (radio host
      // doesn't have it). Growth's actions assume local HRM, so we just
      // skip tick decisions if size is null.
    }
    let memoryCount = null;
    try {
      // The count cache is a sibling of the HRM it describes. Deriving it
      // from HOME instead meant a STAFF_HRM_PATH pointing at a second
      // medium (the witness box) still read the primary's count.
      const cachePath = STATUS_CACHE_PATH;
      if (fs.existsSync(cachePath)) {
        const j = JSON.parse(fs.readFileSync(cachePath, "utf8"));
        memoryCount = j.total_memories || j.memory_count || j.memories || null;
      }
    } catch (_) { /* no count is fine */ }
    return { sizeMB, memoryCount };
  }

  // ── dream launcher ────────────────────────────
  function launchDream(mode, reason) {
    if (g.inFlight) {
      console.log(`[growth] dream already in flight (${g.inFlight.mode}); skip ${reason}`);
      return;
    }
    const before = sampleHrm();
    const startedAt = Date.now();
    logAlert("GROWTH_DREAM_START", `${mode} — ${reason} — HRM=${before.sizeMB != null ? before.sizeMB.toFixed(1) + "MB" : "?"}`);
    publish("KANNAKA.staff.dream.start", { mode, reason, sizeMB: before.sizeMB, memoryCount: before.memoryCount });

    const child = exec(
      `${KANNAKA_BIN} dream --mode ${mode}`,
      { timeout: cfg.dreamTimeoutMs, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout, stderr) => {
        const after = sampleHrm();
        const durationMs = Date.now() - startedAt;
        const ok = !err;
        const tailErr = (stderr || (err && err.message) || "").toString().trim().split("\n").slice(-4).join(" | ").slice(0, 400);
        const deltaMB = (before.sizeMB != null && after.sizeMB != null) ? (after.sizeMB - before.sizeMB) : null;
        const deltaCount = (before.memoryCount != null && after.memoryCount != null) ? (after.memoryCount - before.memoryCount) : null;
        const message = ok
          ? `${mode} ok in ${Math.round(durationMs / 1000)}s · HRM ${before.sizeMB?.toFixed(1) ?? "?"}→${after.sizeMB?.toFixed(1) ?? "?"} MB${deltaMB != null ? ` (Δ${deltaMB >= 0 ? "+" : ""}${deltaMB.toFixed(1)})` : ""}${deltaCount != null ? ` · mem ${deltaCount >= 0 ? "+" : ""}${deltaCount}` : ""}`
          : `${mode} FAILED after ${Math.round(durationMs / 1000)}s: ${tailErr || "no stderr"}`;
        const record = { ts: Date.now(), mode, ok, durationMs, message, before, after, reason };
        g.lastDream = record;
        g.dreamHistory.push(record);
        if (g.dreamHistory.length > DEFAULTS.DREAM_HISTORY_MAX) g.dreamHistory.shift();
        g.inFlight = null;
        logAlert(ok ? "GROWTH_DREAM_DONE" : "GROWTH_DREAM_FAILED", message);
        publish(ok ? "KANNAKA.staff.dream.done" : "KANNAKA.staff.dream.failed", {
          mode, reason, durationMs, message, before, after,
        });
        persist();
      }
    );
    g.inFlight = { startedAt, mode, reason, pid: child.pid };
  }

  // ── tick — decide whether to launch ─────────────────────
  function decide(sample) {
    const { bloat, decision } = evaluateTick({
      cfg, sample,
      lastDream: g.lastDream,
      inFlight: g.inFlight,
      bloatedAlerted: g.bloatedAlerted,
    });
    if (bloat) {
      logAlert(bloat.transition, bloat.message);
      g.bloatedAlerted = bloat.bloatedAlerted;
      // ADR-003 § subjects — the bloat/recovery edges belong on the bus
      // too, not just in alerts.jsonl.
      publish(
        bloat.transition === "GROWTH_HRM_BLOATED"
          ? "KANNAKA.staff.hrm.bloated"
          : "KANNAKA.staff.hrm.recovered",
        { message: bloat.message, sizeMB: sample.sizeMB, memoryCount: sample.memoryCount },
      );
    }
    return decision;
  }

  function tick() {
    const sample = sampleHrm();
    g.hrmHistory.push({ ts: Date.now(), sizeMB: sample.sizeMB, memoryCount: sample.memoryCount });
    if (g.hrmHistory.length > DEFAULTS.HRM_HISTORY_MAX) g.hrmHistory.shift();

    const decision = decide(sample);
    g.lastTick = { ts: Date.now(), decision, sample };
    if (decision && decision.action === "dream") {
      launchDream(decision.mode, decision.reason);
    }
    persist();
  }

  // First tick deferred ~30s so a fresh boot doesn't fire a dream before
  // the watcher has had a chance to surface its baseline probes.
  // unref'd so these timers never hold the event loop open on their own —
  // in production the HTTP listener does that, and in tests a bootGrowth()
  // call must not keep the runner alive (or reach the 30s tick and exec
  // the kannaka binary).
  setTimeout(tick, 30_000).unref();
  setInterval(tick, cfg.tickMs).unref();

  // Public surface for HTTP route + manual ops.
  return {
    getState() {
      return {
        cfg,
        bootedAt: g.bootedAt,
        lastTick: g.lastTick,
        inFlight: g.inFlight,
        hrm: sampleHrm(),
        lastDream: g.lastDream,
        dreamHistory: g.dreamHistory.slice(-DEFAULTS.DREAM_HISTORY_MAX).reverse(),
        hrmHistory: g.hrmHistory,
        bloatedAlerted: g.bloatedAlerted,
      };
    },
    tick,
    /** Force a dream now — useful for the dashboard's manual button. */
    requestDream(mode, reason) {
      // GROWTH_ENABLED=false has to mean "this host launches no dreams",
      // not just "the tick loop launches no dreams" — otherwise the
      // dashboard action walks straight past the opt-out.
      if (!cfg.enabled) return { ok: false, error: "growth disabled (GROWTH_ENABLED=false)" };
      if (g.inFlight) {
        return { ok: false, error: `dream in flight (${g.inFlight.mode})` };
      }
      const m = (mode === "deep" || mode === "lite") ? mode : cfg.defaultMode;
      launchDream(m, reason || "manual request from dashboard");
      // ADR-004 W1: the dream is launched, not finished — accepted, not ok.
      return { accepted: true, mode: m };
    },
  };
}

module.exports = { bootGrowth, bloatTransition, decideDream, evaluateTick };
