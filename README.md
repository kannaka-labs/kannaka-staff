```
███████╗████████╗ █████╗ ███████╗███████╗
██╔════╝╚══██╔══╝██╔══██╗██╔════╝██╔════╝
███████╗   ██║   ███████║█████╗  █████╗
╚════██║   ██║   ██╔══██║██╔══╝  ██╔══╝
███████║   ██║   ██║  ██║██║     ██║
╚══════╝   ╚═╝   ╚═╝  ╚═╝╚═╝     ╚═╝
   P R O D U C T I O N   S U P P O R T
```

**Agentic radio staff for a creator who never stops.**

`kannaka-staff` is the constellation's watcher. Kannaka writes, broadcasts, dreams, remembers — the staff keeps the lights on. Health probes across every node, alert routing for production incidents, deploy assistance for the operator-of-one running the whole show.

[![License](https://img.shields.io/badge/license-Space%20Child%20v1.0-blueviolet)]() [![Node](https://img.shields.io/badge/node-20-green)]()

---

## What It Watches

```
┌───────────────────────────────────────────────────────────┐
│                  constellation health                     │
├─────────────────┬─────────────────────┬───────────────────┤
│  systemd        │  HTTP probes        │  NATS subjects    │
│  · kannaka-*    │  · /api/state       │  · RADIO.alert.*  │
│  · nats         │  · /api/swarm       │  · QUEEN.event.*  │
│  · icecast      │  · /api/hrm/status  │  · KANNAKA.*      │
├─────────────────┼─────────────────────┼───────────────────┤
│  Disk           │  Process            │  Substrate        │
│  · root usage   │  · pgrep kannaka    │  · phi publish?   │
│  · prune-cron   │  · zombie detect    │  · 65s cadence?   │
│  · snapshot dir │  · binary inode     │  · clusters=96?   │
└─────────────────┴─────────────────────┴───────────────────┘
```

When something silently fails — a service deactivating, the disk filling, a zombie binary holding a stale inode — the staff publishes an alert to the bus and (optionally) opens an issue, posts to Bluesky, or wakes a maintainer.

---

## Run

```bash
git clone https://github.com/kannaka-labs/kannaka-staff.git
cd kannaka-staff
npm install

# Defaults to port 8889; --watch reruns on file change
node src/index.js --port 8889
```

Designed to live on the same box as kannaka-radio + kannaka-memory so the watcher can see systemd directly. The Oracle production box runs it as `kannaka-staff.service`.

---

## Operate (ADR-004 — truthful operations)

The staff holds itself to the standard it holds the constellation to: every
surface can say "no", and says it when the "no" is knowable.

- **Action results are honest.** `/action/*` returns `ok:true` only for
  *completed* work (HTTP 200). Queued/launched work returns
  `{ accepted: true, jobId }` (HTTP **202**) — outcome lands in role history,
  `alerts.jsonl`, and the bus. Preflight failures refuse immediately (500),
  nothing queued.
- **Per-action kill switches.** Every write-action honors
  `STAFF_ACTION_<NAME>=0` (e.g. `STAFF_ACTION_RESTART_RADIO=0`) and refuses
  visibly when disabled. The authoritative action registry is the governance
  table in [ADR-004](docs/adr/ADR-004-truthful-operations.md) — code, registry,
  and table are sync-tested.
- **Audit provenance.** Every write-action leaves an `alerts.jsonl` row with
  an `actor` (`operator:local`, `operator:hmac`, or `staff:<loop>`) — nobody
  guesses who restarted the radio at 03:11.
- **`GET /api/health`** — per-subsystem tick freshness (probe loop, all nine
  roles, the heartbeat). Anything whose last tick is older than 2× its
  interval flips the endpoint to **503**: process-alive-but-loop-wedged,
  visible to one curl.
- **`KANNAKA.staff.heartbeat`** — published to the swarm NATS every probe
  tick so an *outside* watcher can see the staff die. `STAFF_HEARTBEAT=0`
  disables.

---

## Constellation

| repo | role |
|---|---|
| [`kannaka-memory`](https://github.com/kannaka-labs/kannaka-memory) | the substrate being watched |
| [`kannaka-radio`](https://github.com/kannaka-labs/kannaka-radio) | the main service this guards |
| [`kannaka-observatory`](https://github.com/NickFlach/kannaka-observatory) | where alerts surface visually |

---

## License

Space Child License v1.0.
