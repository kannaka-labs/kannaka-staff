"use strict";

// Growth's dream cadence and HRM bloat edge-trigger. Both are extracted
// as pure functions so the suite drives the real decision logic without
// booting Growth's timers or exec'ing the kannaka binary.

process.env.KANNAKA_TEST_TTL_MS = process.env.KANNAKA_TEST_TTL_MS || "5000";

const test = require("node:test");
const assert = require("node:assert");
const path = require("node:path");
const os = require("node:os");
const fs = require("node:fs");
const { bootGrowth, bloatTransition, decideDream, evaluateTick } = require("../src/staff/growth");
const { statusCachePathFor } = require("../src/staff/util");

const NOW = 1_700_000_000_000;
const HOUR = 60 * 60 * 1000;

const CFG = {
  hrmSoftMB: 70,
  hrmHardMB: 95,
  memorySoft: 1200,
  memoryHard: 2000,
  normalIntervalMs: 12 * HOUR,
  softMinGapMs: 6 * HOUR,
  failBackoffMs: HOUR,
  defaultMode: "lite",
  enabled: true,
};

const HEALTHY = { sizeMB: 40, memoryCount: 300 };

// ── #64: a failed dream must hold the cadence off ───────────────

test("#64 regression: a just-failed dream does not immediately retrigger", () => {
  // The failure is the ONLY dream on record. Before the fix the cadence
  // used the last *successful* dream (ts 0), making sinceLast ~56 years,
  // so the normal-cadence branch relaunched the broken dream every tick.
  const lastDream = { ts: NOW - 60_000, ok: false, mode: "lite" };
  const d = decideDream({ cfg: CFG, sample: HEALTHY, lastDream, inFlight: null, now: NOW });
  assert.strictEqual(d.action, "skip");
  assert.match(d.reason, /failed 1m ago — backoff 60m/);
});

test("#64: the backoff expires and the cadence resumes", () => {
  const lastDream = { ts: NOW - (HOUR + 60_000), ok: false, mode: "lite" };
  const d = decideDream({ cfg: CFG, sample: HEALTHY, lastDream, inFlight: null, now: NOW });
  assert.strictEqual(d.action, "dream");
  assert.match(d.reason, /normal cadence/);
});

test("#64: the backoff also holds off the HARD-threshold branch", () => {
  // A dream that fails against a bloated medium will keep failing;
  // retrying it every 15 min helps nobody.
  const lastDream = { ts: NOW - 60_000, ok: false, mode: "lite" };
  const d = decideDream({ cfg: CFG, sample: { sizeMB: 200, memoryCount: 9000 }, lastDream, inFlight: null, now: NOW });
  assert.strictEqual(d.action, "skip");
  assert.match(d.reason, /backoff/);
});

test("#64: a recent SUCCESSFUL dream still gates on the normal interval, not the backoff", () => {
  const lastDream = { ts: NOW - 2 * HOUR, ok: true, mode: "lite" };
  const d = decideDream({ cfg: CFG, sample: HEALTHY, lastDream, inFlight: null, now: NOW });
  assert.strictEqual(d.action, "skip");
  assert.match(d.reason, /last dream 120m ago/);
});

test("no dream on record → normal cadence fires", () => {
  const d = decideDream({ cfg: CFG, sample: HEALTHY, lastDream: null, inFlight: null, now: NOW });
  assert.strictEqual(d.action, "dream");
  assert.strictEqual(d.mode, "lite");
});

test("an in-flight dream still yields wait", () => {
  const d = decideDream({
    cfg: CFG, sample: HEALTHY, lastDream: null,
    inFlight: { mode: "deep", startedAt: NOW - 30_000 }, now: NOW,
  });
  assert.strictEqual(d.action, "wait");
  assert.match(d.reason, /dream in flight \(deep, 30s\)/);
});

test("an unreadable HRM yields skip", () => {
  const d = decideDream({ cfg: CFG, sample: { sizeMB: null, memoryCount: null }, lastDream: null, inFlight: null, now: NOW });
  assert.strictEqual(d.action, "skip");
  assert.match(d.reason, /not readable/);
});

// ── #62: bloat must alert even while a dream is in flight ───────

test("#62 regression: a tick with a dream in flight STILL raises the bloat alert", () => {
  // This is the whole bug: decide() used to return early on in-flight,
  // before the bloat edge was evaluated, so the one episode the alert
  // documents ("crossed HARD while a dream is unable to run") never
  // reached alerts.jsonl. evaluateTick pins the ordering.
  const r = evaluateTick({
    cfg: CFG,
    sample: { sizeMB: 120, memoryCount: 500 },
    lastDream: null,
    inFlight: { mode: "lite", startedAt: NOW - 5000 },
    bloatedAlerted: false,
    now: NOW,
  });
  assert.ok(r.bloat, "bloat alert must fire even though a dream is in flight");
  assert.strictEqual(r.bloat.transition, "GROWTH_HRM_BLOATED");
  assert.strictEqual(r.bloat.bloatedAlerted, true);
  assert.match(r.bloat.message, /120\.0 MB >= 95 MB/);
  // ...and the same tick still declines to launch a second dream.
  assert.strictEqual(r.decision.action, "wait");
});

test("#62: recovery edge also survives an in-flight dream", () => {
  const r = evaluateTick({
    cfg: CFG,
    sample: { sizeMB: 40, memoryCount: 300 },
    lastDream: null,
    inFlight: { mode: "lite", startedAt: NOW - 5000 },
    bloatedAlerted: true,
    now: NOW,
  });
  assert.ok(r.bloat, "recovery alert must fire even though a dream is in flight");
  assert.strictEqual(r.bloat.transition, "GROWTH_HRM_RECOVERED");
  assert.strictEqual(r.decision.action, "wait");
});

test("#62: a disabled Growth evaluates to no alert and no decision", () => {
  const r = evaluateTick({
    cfg: { ...CFG, enabled: false },
    sample: { sizeMB: 120, memoryCount: 500 },
    lastDream: null, inFlight: null, bloatedAlerted: false, now: NOW,
  });
  assert.strictEqual(r.bloat, null);
  assert.strictEqual(r.decision, null);
});

test("#62: bloat is one-shot — no repeat while already alerted", () => {
  const b = bloatTransition({ cfg: CFG, sample: { sizeMB: 120, memoryCount: 500 }, bloatedAlerted: true });
  assert.strictEqual(b, null);
});

test("#62: count crossing HARD counts as bloat even when size is fine", () => {
  const b = bloatTransition({ cfg: CFG, sample: { sizeMB: 40, memoryCount: 5000 }, bloatedAlerted: false });
  assert.strictEqual(b.transition, "GROWTH_HRM_BLOATED");
  assert.match(b.message, /5000 memories >= 2000/);
});

test("#62: recovery needs BOTH size and count back under SOFT", () => {
  assert.strictEqual(
    bloatTransition({ cfg: CFG, sample: { sizeMB: 40, memoryCount: 1500 }, bloatedAlerted: true }),
    null,
    "count still over SOFT → not recovered",
  );
  const b = bloatTransition({ cfg: CFG, sample: { sizeMB: 40, memoryCount: 300 }, bloatedAlerted: true });
  assert.strictEqual(b.transition, "GROWTH_HRM_RECOVERED");
  assert.strictEqual(b.bloatedAlerted, false);
});

test("an unreadable HRM produces no bloat transition", () => {
  assert.strictEqual(
    bloatTransition({ cfg: CFG, sample: { sizeMB: null, memoryCount: null }, bloatedAlerted: false }),
    null,
  );
});

// ── #78: GROWTH_ENABLED=false must stop manual dreams too ───────

function bootDisabledGrowth() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "growth-test-"));
  const prev = process.env.GROWTH_ENABLED;
  process.env.GROWTH_ENABLED = "false";
  try {
    // hrmPath points at nothing, so a stray tick could only ever "skip".
    // Growth's timers are unref'd, so this boot cannot outlive the test.
    return bootGrowth({
      hrmPath: path.join(dir, "absent.hrm"),
      alertsFile: path.join(dir, "alerts.jsonl"),
      staffBus: null,
    });
  } finally {
    if (prev === undefined) delete process.env.GROWTH_ENABLED; else process.env.GROWTH_ENABLED = prev;
  }
}

test("#78 regression: requestDream refuses when GROWTH_ENABLED=false", () => {
  // The tick loop already honoured the opt-out via decide(), but
  // /action/growth-dream calls requestDream() directly, which walked
  // straight past it and exec'd the kannaka binary anyway.
  const growth = bootDisabledGrowth();
  assert.strictEqual(growth.getState().cfg.enabled, false);
  const r = growth.requestDream("lite", "test");
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /GROWTH_ENABLED=false/);
  // and nothing was launched
  assert.strictEqual(growth.getState().inFlight, null);
});

test("#78: the tick loop also stays silent when disabled", () => {
  const growth = bootDisabledGrowth();
  growth.tick();
  assert.strictEqual(growth.getState().lastTick.decision, null);
  assert.strictEqual(growth.getState().inFlight, null);
});

// ── #16: the count cache belongs to the configured HRM ──────────

test("#16 regression: the status cache is a sibling of the configured HRM", () => {
  const prevHome = process.env.HOME;
  const prevOverride = process.env.KANNAKA_STATUS_CACHE;
  delete process.env.KANNAKA_STATUS_CACHE;
  process.env.HOME = path.join(path.sep, "home", "opc");
  try {
    // A witness box points STAFF_HRM_PATH at its own medium. Before the
    // fix this still read $HOME/.kannaka/status-cache.json, reporting the
    // PRIMARY's memory count against the witness's HRM size.
    const witness = path.join(path.sep, "srv", "witness", "kannaka.hrm");
    assert.strictEqual(
      statusCachePathFor(witness),
      path.join(path.sep, "srv", "witness", "status-cache.json"),
    );
    // The default layout is unchanged: ~/.kannaka/kannaka.hrm still
    // resolves to ~/.kannaka/status-cache.json.
    const dflt = path.join(path.sep, "home", "opc", ".kannaka", "kannaka.hrm");
    assert.strictEqual(
      statusCachePathFor(dflt),
      path.join(path.sep, "home", "opc", ".kannaka", "status-cache.json"),
    );
  } finally {
    if (prevHome === undefined) delete process.env.HOME; else process.env.HOME = prevHome;
    if (prevOverride !== undefined) process.env.KANNAKA_STATUS_CACHE = prevOverride;
  }
});

test("#16: KANNAKA_STATUS_CACHE overrides for split layouts", () => {
  const prev = process.env.KANNAKA_STATUS_CACHE;
  process.env.KANNAKA_STATUS_CACHE = "/var/lib/kannaka/count.json";
  try {
    assert.strictEqual(statusCachePathFor("/srv/witness/kannaka.hrm"), "/var/lib/kannaka/count.json");
  } finally {
    if (prev === undefined) delete process.env.KANNAKA_STATUS_CACHE; else process.env.KANNAKA_STATUS_CACHE = prev;
  }
});

// ── the HARD branch had no cadence gate, and no notion of effect ──
//
// Found 2026-08-25 on the witness. GROWTH_HRM_HARD_MB=50 against a 98 MB store
// made the HARD branch permanently true, and it was the ONLY branch with no
// cadence gate — SOFT checks softMinGapMs, normal checks normalIntervalMs,
// HARD checked nothing. So it dispatched a dream on every 15-minute tick for
// three days: 289 dreams, 7.7 hours of compute, and the memory count it was
// dispatched to reduce went UP 553 → 1280 while Xi fell 32%.
//
// The remedy could never work: GROWTH_DEFAULT_MODE was "lite", and a lite
// dream cannot prune, strengthen or connect. Every one reported
// "lite ok in 167s · HRM 98.1→98.1 MB (Δ+0.0)" — a success that changed
// nothing, dispatched again fifteen minutes later.

const HARD_CFG = { ...CFG, hardMinGapMs: HOUR };
const OVER_HARD = { sizeMB: 98.1, memoryCount: 1280 };

// A dream that ran clean and moved neither number — the live shape.
const NOOP_LITE = (ts) => ({
  ts, ok: true, mode: "lite",
  before: { sizeMB: 98.1, memoryCount: 1278 },
  after: { sizeMB: 98.1, memoryCount: 1280 },
});

test("HARD breach respects a cadence gap instead of firing every tick", () => {
  // 15 minutes after a dream — one tick. Before the fix this returned "dream".
  const lastDream = { ts: NOW - 15 * 60_000, ok: true, mode: "lite",
    before: { sizeMB: 99, memoryCount: 1280 }, after: { sizeMB: 98.1, memoryCount: 1270 } };
  const d = decideDream({ cfg: HARD_CFG, sample: OVER_HARD, lastDream, inFlight: null, now: NOW });
  assert.strictEqual(d.action, "skip");
  assert.match(d.reason, /hard-branch gap 60m/);
});

test("HARD breach still fires once the gap has elapsed", () => {
  const lastDream = { ts: NOW - 2 * HOUR, ok: true, mode: "lite",
    before: { sizeMB: 99, memoryCount: 1280 }, after: { sizeMB: 98.1, memoryCount: 1270 } };
  const d = decideDream({ cfg: HARD_CFG, sample: OVER_HARD, lastDream, inFlight: null, now: NOW });
  assert.strictEqual(d.action, "dream");
  assert.match(d.reason, /≥ HARD/);
});

test("a lite dream that moved nothing escalates to deep rather than repeating", () => {
  const d = decideDream({
    cfg: HARD_CFG, sample: OVER_HARD, lastDream: NOOP_LITE(NOW - 2 * HOUR),
    inFlight: null, now: NOW,
  });
  assert.strictEqual(d.action, "dream");
  assert.strictEqual(d.mode, "deep", "repeating lite cannot clear a HARD threshold");
  assert.match(d.reason, /moved nothing — escalating to deep/);
});

test("a deep dream that moved nothing stops, and says an operator is needed", () => {
  // The end of the line: the strongest remedy ran and the numbers did not
  // move. Continuing to dream is burning compute to no effect, which is the
  // whole defect. Say so instead of looping.
  const noopDeep = { ...NOOP_LITE(NOW - 2 * HOUR), mode: "deep" };
  const d = decideDream({ cfg: HARD_CFG, sample: OVER_HARD, lastDream: noopDeep, inFlight: null, now: NOW });
  assert.strictEqual(d.action, "skip");
  assert.match(d.reason, /dreaming cannot clear this, needs an operator/);
});

test("an effective dream is not mistaken for an ineffective one", () => {
  // Guard against the opposite failure: a dream that IS working must not be
  // suppressed. Count fell — that is a result, even with size unchanged.
  const worked = { ts: NOW - 2 * HOUR, ok: true, mode: "lite",
    before: { sizeMB: 98.1, memoryCount: 1400 }, after: { sizeMB: 98.1, memoryCount: 1280 } };
  const d = decideDream({ cfg: HARD_CFG, sample: OVER_HARD, lastDream: worked, inFlight: null, now: NOW });
  assert.strictEqual(d.action, "dream");
  assert.strictEqual(d.mode, "lite", "a working remedy is not escalated");
});

test("missing before/after is not treated as evidence of ineffectiveness", () => {
  // An unknown must never be the reason a real remedy is skipped.
  const noMetrics = { ts: NOW - 2 * HOUR, ok: true, mode: "lite" };
  const d = decideDream({ cfg: HARD_CFG, sample: OVER_HARD, lastDream: noMetrics, inFlight: null, now: NOW });
  assert.strictEqual(d.action, "dream");
  assert.strictEqual(d.mode, "lite");
});

test("sub-noise size deltas do not count as movement", () => {
  // Re-serialisation alone shifts the file by ~1e-3 MB. Counting that as
  // progress would re-arm the loop this fix exists to break.
  const noise = { ts: NOW - 2 * HOUR, ok: true, mode: "lite",
    before: { sizeMB: 98.100, memoryCount: 1280 }, after: { sizeMB: 98.098, memoryCount: 1280 } };
  const d = decideDream({ cfg: HARD_CFG, sample: OVER_HARD, lastDream: noise, inFlight: null, now: NOW });
  assert.strictEqual(d.mode, "deep", "a 0.002 MB drift is noise, not a result");
});

test("the count-based HARD branch is gated too, not just the size one", () => {
  const countOnly = { sizeMB: 10, memoryCount: 5000 };
  const cfg = { ...HARD_CFG, hrmHardMB: 95, memoryHard: 2000 };
  const lastDream = { ts: NOW - 15 * 60_000, ok: true, mode: "lite",
    before: { sizeMB: 10, memoryCount: 5100 }, after: { sizeMB: 10, memoryCount: 5000 } };
  const d = decideDream({ cfg, sample: countOnly, lastDream, inFlight: null, now: NOW });
  assert.strictEqual(d.action, "skip");
  assert.match(d.reason, /5000 memories ≥ HARD 2000.*hard-branch gap/);
});
