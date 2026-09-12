/**
 * Creator — Phase 3 (ADR-001 § 1).
 *
 * Generation dispatcher. The operator (or a future automated trigger)
 * posts a creation request; Creator routes to the right backend, tracks
 * the in-flight job, and logs provenance.
 *
 * MVP scope:
 *   - kind="oration"  → POST $RADIO_BASE/api/oration/now  (existing path)
 *   - kind="image"    → POST $OBC_API/artifacts/generate-image
 *                       requires query.building_id + query.prompt + query.title
 *   - kind="track"    → refused; full albums go through Distributor +
 *                       scripts/release-album.sh (Creator would
 *                       duplicate that pipeline)
 *
 * Routes:
 *   POST /action/creator-request?kind=...&...
 *   GET  /api/creator
 *
 * Alerts:
 *   CREATOR_JOB_START / _DONE / _FAILED
 *
 * Persistence: <ALERTS_FILE dir>/creator-state.json
 * In-flight guard: one job at a time (matches Distributor pattern).
 */
"use strict";

const fs = require("fs");
const http = require("http");
const https = require("https");
const path = require("path");
const url = require("url");

const DEFAULTS = {
  TIMEOUT_MS: 5 * 60 * 1000,
  HISTORY_MAX: 20,
};

function readEnvStr(name, fallback) {
  const v = (process.env[name] || "").trim();
  return v || fallback;
}

function postJson(target, body, timeoutMs, extraHeaders = {}) {
  return new Promise((resolve) => {
    const u = url.parse(target);
    const lib = u.protocol === "https:" ? https : http;
    const payload = body == null ? "" : (typeof body === "string" ? body : JSON.stringify(body));
    const req = lib.request({
      method: "POST",
      hostname: u.hostname,
      port: u.port || (u.protocol === "https:" ? 443 : 80),
      path: u.pathname + (u.search || ""),
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload), ...extraHeaders },
      timeout: timeoutMs,
    }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      const settle = () => {
        const text = Buffer.concat(chunks).toString("utf8").slice(0, 4000);
        const ok = res.statusCode >= 200 && res.statusCode < 400;
        resolve({ ok, status: res.statusCode, body: text });
      };
      res.on("end", settle);
      res.on("close", settle);
    });
    req.on("error", (e) => resolve({ ok: false, status: 0, error: e.message }));
    req.on("timeout", () => req.destroy(new Error("timeout")));
    if (payload) req.write(payload);
    req.end();
  });
}

function bootCreator(deps) {
  const ALERTS_FILE = deps.alertsFile;
  const RADIO_BASE = deps.radioBase;
  const STATE_FILE = path.join(path.dirname(ALERTS_FILE), "creator-state.json");
  const bus = deps.staffBus || null;

  // ADR-003 § subjects. The bus was passed in at boot but never used, so
  // generation jobs never appeared on the bus or the dashboard's panel.
  function publish(subject, payload) {
    if (!bus) return;
    bus.emit(subject, { ts: Date.now(), source: "creator", subject, payload });
  }

  const cfg = {
    radioBase: RADIO_BASE,
    obcApi: readEnvStr("OBC_API", "https://api.openbotcity.com"),
    obcJwtFile: readEnvStr("OBC_JWT_FILE", "/home/opc/.openbotcity/credentials.json"),
    timeoutMs: parseInt(process.env.CREATOR_TIMEOUT_MS || "", 10) || DEFAULTS.TIMEOUT_MS,
    enabled: process.env.CREATOR_ENABLED !== "false",
  };

  const c = {
    cfg,
    bootedAt: Date.now(),
    current: null,
    history: [],
  };

  try {
    if (fs.existsSync(STATE_FILE)) {
      const persisted = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
      if (Array.isArray(persisted.history)) c.history = persisted.history.slice(-DEFAULTS.HISTORY_MAX);
    }
  } catch (e) {
    console.warn(`[creator] state load: ${e.message}`);
  }
  function persist() {
    try { fs.writeFileSync(STATE_FILE, JSON.stringify({ history: c.history }, null, 2)); }
    catch (e) { console.warn(`[creator] state save: ${e.message}`); }
  }

  function logAlert(transition, message) {
    const entry = { ts: new Date().toISOString(), probe: "creator", transition, message };
    try { fs.appendFileSync(ALERTS_FILE, JSON.stringify(entry) + "\n"); }
    catch (e) { console.warn(`[creator] alert write: ${e.message}`); }
    console.log(`[creator] ${transition}: ${message}`);
  }

  // The rest of the constellation passes the OBC token in the
  // environment; requiring the credentials file made image jobs fail with
  // "no OBC JWT" on any host that had a perfectly good OPENBOTCITY_JWT.
  // Env wins, file is the fallback.
  function readObcJwt() {
    const fromEnv = (process.env.OPENBOTCITY_JWT || process.env.OBC_JWT || "").trim();
    if (fromEnv) return fromEnv;
    try { return JSON.parse(fs.readFileSync(cfg.obcJwtFile, "utf8")).jwt || ""; }
    catch (_) { return ""; }
  }

  async function dispatch(kind, q) {
    if (kind === "oration") {
      return postJson(`${RADIO_BASE}/api/oration/now`, "", cfg.timeoutMs);
    }
    if (kind === "image") {
      const jwt = readObcJwt();
      if (!jwt) return { ok: false, status: 0, error: "no OBC JWT" };
      const body = { title: q.title || "Untitled", prompt: q.prompt || "", building_id: q.building_id || "" };
      if (!body.prompt || !body.building_id) {
        return { ok: false, status: 0, error: "image requires prompt + building_id" };
      }
      return postJson(
        cfg.obcApi + "/artifacts/generate-image",
        body,
        cfg.timeoutMs,
        { "Authorization": `Bearer ${jwt}` },
      );
    }
    if (kind === "track") {
      return { ok: false, status: 0, error: "use Distributor for full album publishing (release-album.sh)" };
    }
    return { ok: false, status: 0, error: `unknown kind: ${kind}` };
  }

  /**
   * Reasons a request cannot possibly succeed, decided synchronously.
   * requestCreate answers the HTTP caller before dispatch resolves, so
   * anything knowable up front has to be checked here — otherwise the
   * caller is told ok:true for a job that fails microseconds later and
   * only ever surfaces in alerts.jsonl.
   */
  function rejectionFor(kind, q) {
    if (!kind) return "missing ?kind=oration|image";
    if (kind === "track") return "use Distributor for full album publishing (release-album.sh)";
    if (kind === "image") {
      if (!q.prompt || !q.building_id) return "image requires prompt + building_id";
      if (!readObcJwt()) return "no OBC JWT (set OPENBOTCITY_JWT or OBC_JWT_FILE)";
      return null;
    }
    if (kind === "oration") return null;
    return `unknown kind: ${kind}`;
  }

  function requestCreate(query) {
    if (!cfg.enabled) return { ok: false, error: "creator disabled" };
    if (c.current) return { ok: false, error: `job ${c.current.id} in flight (${c.current.kind})` };
    const kind = (query.kind || "").toString();
    const rejection = rejectionFor(kind, query);
    if (rejection) return { ok: false, kind, error: rejection };
    const id = `gen_${Date.now().toString(36)}`;
    const startedAt = Date.now();
    c.current = { id, kind, startedAt, query };
    logAlert("CREATOR_JOB_START", `${id} kind=${kind}`);
    publish("KANNAKA.staff.creator.job.start", { id, kind });
    dispatch(kind, query)
      .then((r) => {
        const finishedAt = Date.now();
        const ok = !!r.ok;
        const tail = (r.body || r.error || "").toString().slice(0, 240);
        const message = `${id} ${ok ? "ok" : "FAIL"} kind=${kind} in ${Math.round((finishedAt - startedAt) / 1000)}s · status=${r.status} · ${tail.replace(/\s+/g, " ")}`;
        c.history.push({ id, kind, startedAt, finishedAt, ok, status: r.status, message, query });
        if (c.history.length > DEFAULTS.HISTORY_MAX) c.history.shift();
        c.current = null;
        logAlert(ok ? "CREATOR_JOB_DONE" : "CREATOR_JOB_FAILED", message);
        publish(ok ? "KANNAKA.staff.creator.job.done" : "KANNAKA.staff.creator.job.failed", {
          id, kind, status: r.status, message,
        });
        persist();
      })
      .catch((e) => {
        const finishedAt = Date.now();
        const message = `${id} FAILED kind=${kind} (unhandled error): ${e.message}`;
        c.history.push({ id, kind, startedAt, finishedAt, ok: false, status: 0, message, query });
        if (c.history.length > DEFAULTS.HISTORY_MAX) c.history.shift();
        c.current = null;
        logAlert("CREATOR_JOB_FAILED", message);
        publish("KANNAKA.staff.creator.job.failed", { id, kind, status: 0, message });
        persist();
      });
    // ADR-004 W1: queued work is *accepted*, not *ok*. `ok` is reserved for
    // completed work; the caller holds jobId and watches history/the bus.
    return { accepted: true, jobId: id, kind };
  }

  return {
    getState() {
      return {
        cfg,
        bootedAt: c.bootedAt,
        current: c.current ? { ...c.current, elapsedMs: Date.now() - c.current.startedAt } : null,
        history: c.history.slice(-DEFAULTS.HISTORY_MAX).reverse(),
      };
    },
    requestCreate,
    rejectionFor,
  };
}

module.exports = { bootCreator };
