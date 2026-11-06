#!/usr/bin/env node
/**
 * LOCAL DEV ONLY. Simulates 14 days of client reports for 6 fake accounts by
 * running them through the real pure pipeline (processReport), then either
 * writes the resulting store + snapshot to a JSON file or POSTs it to a local
 * `wrangler dev` instance (route /__dev/seed, enabled only by DEV_SEED=1 in .dev.vars).
 *
 * Usage:
 *   node test/tools/seed-fake.mjs --out /tmp/seed.json [--now 2026-10-27T16:40:00Z]
 *   node test/tools/seed-fake.mjs --post http://127.0.0.1:8799 --key local-test-key
 *   node test/tools/seed-fake.mjs --provider agy --post http://127.0.0.1:8799 --key local-test-key
 *
 * Final states (at --now): dev ACTIVE high-waste, dinh ACTIVE will-exhaust,
 * linh FRESH, khoa COOLDOWN, mai AUTH expired_idle, tuan ACTIVE stale + weekly-capped.
 *
 * --provider agy: 3 accounts x 2 pools (gemini, claude), each pool replaying one of the profiles above
 * (dev: dev/dinh, linh: linh/khoa, tuan: tuan/mai); tuan's gemini pool ends with the 5h bucket disabled
 * (weekly cap hit). Seeds the agy Durable Object (/__dev/seed?provider=agy).
 */
import { writeFileSync } from "node:fs";
import { processReport, HOUR_MS, MINUTE_MS, DAY_MS, WINDOW_MS } from "../../src/analytics.js";

const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, arr) => {
  if (a.startsWith("--")) acc.push([a.slice(2), arr[i + 1] && !arr[i + 1].startsWith("--") ? arr[i + 1] : true]);
  return acc;
}, []));

const NOW = args.now ? Date.parse(args.now) : Math.floor(Date.now() / MINUTE_MS) * MINUTE_MS;
const GMT7 = 7 * HOUR_MS;
const dayStartLocal = (ts) => Math.floor((ts + GMT7) / DAY_MS) * DAY_MS - GMT7; // 00:00 GMT+7 of ts
const TODAY0 = dayStartLocal(NOW);

let seed = 42;
function rand() {
  seed = (seed * 1664525 + 1013904223) % 4294967296;
  return seed / 4294967296;
}

/** Work blocks per account per past day: [startHourLocal, endHourLocal, rate %/h]. */
const PROFILES = {
  "dev@example.com": { offset: 2, base: [[9, 12, 18], [14, 18, 14], [21, 23, 8]], limits: true },
  "dinh@example.com": { offset: 7, base: [[10, 13, 30], [15, 19, 28], [22, 24, 35]], limits: true },
  "linh@example.com": { offset: 11, base: [[8, 11, 22], [13, 16, 20]], limits: true },
  "khoa@example.com": { offset: 17, base: [[9, 12, 40], [19, 23, 45]], limits: false },
  "mai@example.com": { offset: 23, base: [[10, 15, 12]], limits: false },
  "tuan@example.com": { offset: 27, base: [[13, 17, 25], [20, 23, 30]], limits: true },
};

function blocksFor(email, dayIdx) {
  const p = PROFILES[email];
  const day0 = TODAY0 - dayIdx * DAY_MS;
  const isToday = dayIdx === 0;
  // weekend-ish days off for variety
  if (!isToday && (dayIdx % 7 === 3 || (email.startsWith("mai") && dayIdx < 3))) return [];
  return p.base
    .map(([a, b, r]) => {
      const jitter = isToday ? 0 : Math.round((rand() - 0.5) * 2 * 60) * MINUTE_MS;
      const skip = !isToday && rand() < 0.2;
      return skip ? null : [day0 + a * HOUR_MS + jitter, day0 + b * HOUR_MS + jitter, r * (0.6 + rand() * 0.8)];
    })
    // keep only blocks whose windows are over well before the scripted tails below
    .filter((blk) => blk && blk[1] <= NOW - 9.5 * HOUR_MS);
}

function simulateAccount(email) {
  const p = PROFILES[email];
  const events = [];
  let winReset = null;
  let used = 0;
  let lastT = null;
  const blocks = [];
  for (let d = 13; d >= 0; d--) blocks.push(...blocksFor(email, d));
  // Today's scripted tail so the final states are the ones we want.
  // Every tail starts >= NOW-8h, after all earlier windows have reset, whatever the time of day.
  const TAILS = {
    dev: [[NOW - 170 * MINUTE_MS, NOW - 125 * MINUTE_MS, 14]], // ACTIVE, light use -> high at-risk waste
    dinh: [[NOW - 100 * MINUTE_MS, NOW + MINUTE_MS, 38]], // ACTIVE, heavy burn -> will exhaust
    linh: [[NOW - 8 * HOUR_MS, NOW - 6 * HOUR_MS, 25]], // window over ~3h ago -> FRESH
    khoa: [[NOW - 200 * MINUTE_MS, NOW - 40 * MINUTE_MS, 60]], // hits 100% -> COOLDOWN
    tuan: [[NOW - 4 * HOUR_MS, NOW - 150 * MINUTE_MS, 30]], // stops reporting -> stale ACTIVE
  };
  blocks.push(...(TAILS[email.split("@")[0]] || []));
  blocks.sort((a, b) => a[0] - b[0]);

  const inBlock = (t) => blocks.find(([a, b]) => t >= a && t < b);
  const machineOn = (t) => blocks.some(([a, b]) => t >= a - HOUR_MS && t < b + 90 * MINUTE_MS)
    || (email.startsWith("linh") && t > NOW - 6 * HOUR_MS);
  const start = TODAY0 - 13 * DAY_MS + p.offset * MINUTE_MS;
  let stopAt = NOW;
  if (email.startsWith("tuan")) stopAt = NOW - 130 * MINUTE_MS; // stale
  if (email.startsWith("mai")) stopAt = NOW - 2 * DAY_MS; // then auth alert below

  for (let t = start; t <= stopAt; t += 30 * MINUTE_MS) {
    if (lastT !== null && winReset !== null && t >= winReset) {
      winReset = null;
      used = 0;
    }
    const blk = inBlock(t);
    if (blk) {
      if (winReset === null) {
        winReset = t - 5 * MINUTE_MS + WINDOW_MS;
        used = 0;
      }
      const dt = lastT === null ? 0.5 : Math.min(0.5, (t - lastT) / HOUR_MS);
      used = Math.min(100, used + blk[2] * dt * (0.7 + rand() * 0.6));
    }
    lastT = t;
    if (!machineOn(t)) continue;
    if (email.startsWith("khoa") && used >= 100 && winReset !== null && events.some((e) => e.used >= 100 && e.resets_at === winReset)) {
      continue; // client overload suppression: stops polling at 100%
    }
    const active = winReset !== null && t < winReset;
    const r = {
      kind: "quota",
      email,
      used: Math.round((active ? used : 0) * 10) / 10,
      resets_at: active ? winReset + Math.round((rand() - 0.5) * 1000) : null,
      limits: null,
      client_version: p.limits ? "2.0" : null,
      at: t,
    };
    if (p.limits) {
      const daysToWeekReset = (TODAY0 + 2 * DAY_MS + 17 * HOUR_MS - t) / DAY_MS;
      const weekly = email.startsWith("tuan") ? Math.min(97, 75 + (7 - daysToWeekReset) * 6) : Math.min(70, 20 + (7 - daysToWeekReset) * 6);
      r.limits = [
        { kind: "session", group: "session", percent: r.used, resets_at: r.resets_at, is_active: active, scope_name: null },
        { kind: "seven_day", group: "weekly", percent: Math.max(0, Math.round(weekly)), resets_at: TODAY0 + 2 * DAY_MS + 17 * HOUR_MS, is_active: true, scope_name: null },
        { kind: "weekly_scoped", group: "weekly", percent: 0, resets_at: TODAY0 + 2 * DAY_MS + 17 * HOUR_MS, is_active: false, scope_name: "Fable" },
      ];
    }
    events.push(r);
  }
  if (email.startsWith("mai")) {
    events.push({ kind: "auth", email, auth_state: "expired_idle", error: "HTTP 401, token quá hạn", at: NOW - 30 * MINUTE_MS });
  }
  return events;
}

const MACHINES = {
  "dev@example.com": [
    { machine_id: "a1b2c3d4e5f60718", machine_name: "Mac-mini-dev", os: "Darwin", ip: "113.161.20.15", country: "VN" },
    { machine_id: "b7c8d9e0f1a2b3c4", machine_name: "dev-laptop", os: "Windows", ip: "14.232.7.88", country: "VN", client_version: "3.3", update_status: "gh_unauthenticated", update_checked_at: NOW - 40 * MINUTE_MS },
  ],
  "dinh@example.com": [{ machine_id: "c3d4e5f6a7b8c9d0", machine_name: "dinh-ubuntu", os: "Linux", ip: "27.72.45.9", country: "VN" }],
  "linh@example.com": [{ machine_id: "d4e5f6a7b8c9d0e1", machine_name: "linh-macbook", os: "Darwin", ip: "113.161.20.15", country: "VN" }],
  "khoa@example.com": [{ machine_id: "e5f6a7b8c9d0e1f2", machine_name: "khoa-pc", os: "Windows", ip: "171.250.3.41", country: "VN" }],
  "mai@example.com": [{ machine_id: "f6a7b8c9d0e1f2a3", machine_name: "mai-air", os: "Darwin", ip: "42.115.9.200", country: "VN" }],
  "tuan@example.com": [], // old client: no machine_id
};
const PROVIDER = args.provider === "agy" ? "agy" : "claude";
// agy: account email -> { pool: profile replayed by that pool }
const AGY_POOLS = {
  "dev@example.com": { gemini: "dev@example.com", claude: "dinh@example.com" },
  "linh@example.com": { gemini: "linh@example.com", claude: "khoa@example.com" },
  "tuan@example.com": { gemini: "tuan@example.com", claude: "mai@example.com" },
};
const AGY_WEEKLY_RESET = TODAY0 + 2 * DAY_MS + 17 * HOUR_MS;

function toAgy(ev, email, pool) {
  const limits = ev.limits
    ? ev.limits.filter((l) => l.group === "weekly" && !l.scope_name).map((l) => ({ ...l, kind: "weekly", scope_name: pool }))
    : null;
  return { ...ev, email, provider: "agy", pool, account_key: `${email}#${pool}`, limits, client_version: ev.kind === "quota" ? "agy-1.0" : null };
}

let all;
if (PROVIDER === "agy") {
  all = Object.entries(AGY_POOLS).flatMap(([email, pools]) => Object.entries(pools)
    .flatMap(([pool, profile]) => simulateAccount(profile).map((ev) => toAgy(ev, email, pool))));
  // tuan's gemini pool hits the weekly cap: the 5h bucket is disabled until the weekly reset.
  for (let t = NOW - 60 * MINUTE_MS; t <= NOW; t += 30 * MINUTE_MS) {
    all.push({
      kind: "quota", email: "tuan@example.com", provider: "agy", pool: "gemini", account_key: "tuan@example.com#gemini",
      five_hour_disabled: true, used: 100, resets_at: null, client_version: "agy-1.0", at: t,
      limits: [{ kind: "weekly", group: "weekly", percent: 100, resets_at: AGY_WEEKLY_RESET, is_active: true, scope_name: "gemini" }],
    });
  }
} else {
  all = Object.keys(PROFILES).flatMap(simulateAccount);
  // final scripted warnings: dev's laptop has an expired token while the mini measures fine (other machine);
  // dinh's only machine timed out once after measuring fine (same machine)
  all.push({ kind: "auth", email: "dev@example.com", auth_state: "expired_idle", error: "HTTP 401", error_kind: null, at: NOW - 3 * MINUTE_MS, forced: "other-machine" });
  all.push({ kind: "auth", email: "dinh@example.com", auth_state: "error", error: "`claude -p /usage` did not finish within 300s twice", error_kind: "usage_timeout", at: NOW - 6 * MINUTE_MS, forced: true });
}
all.sort((a, b) => a.at - b.at);
const store = { states: {}, samples: [], windows: [], gaps: [], machines: [] };
let snapshot = null;
let version = 0;
for (const ev of all) {
  const { at, forced, ...report } = ev;
  const fleet = MACHINES[report.email] || [];
  if (fleet.length && !forced) {
    // dev alternates between its two machines; everyone else uses the single one. The laptop only appears
    // for the first part of the 14 days so "since when" differs between machines.
    const idx = fleet.length > 1 && at > NOW - 5 * DAY_MS ? Math.floor(at / (30 * MINUTE_MS)) % fleet.length : 0;
    Object.assign(report, fleet[idx], { client_version: report.client_version === "agy-1.0" ? "agy-1.0" : fleet[idx].client_version || "3.4" });
  } else if (fleet.length && forced) {
    const last = store.states[report.email] && store.states[report.email].last_valid_machine;
    const pick = forced === "other-machine" ? fleet.find((m) => m.machine_id !== last) || fleet[0] : fleet.find((m) => m.machine_id === last) || fleet[0];
    Object.assign(report, pick, { client_version: pick.client_version || "3.4" });
  }
  version += 1;
  const view = {
    states: store.states,
    samples: store.samples.filter((p) => p.ts >= at - DAY_MS),
    windows: store.windows.filter((w) => w.end_ts >= at - 14 * DAY_MS),
    gaps: store.gaps.filter((g) => g.end_ts >= at - 14 * DAY_MS),
  };
  view.machines = store.machines;
  const res = processReport(view, report, at, version);
  for (const st of res.writes.states) store.states[st.email] = st;
  store.samples.push(...res.writes.samples);
  store.windows.push(...res.writes.windows);
  store.gaps.push(...res.writes.gaps);
  for (const m of res.writes.machines) {
    const i = store.machines.findIndex((x) => x.email === m.email && x.machine_id === m.machine_id);
    if (i >= 0) store.machines[i] = m; else store.machines.push(m);
  }
  snapshot = res.snapshot;
}

const out = {
  states: store.states,
  samples: store.samples.filter((p) => p.ts >= NOW - 14 * DAY_MS),
  windows: store.windows,
  gaps: store.gaps,
  machines: store.machines,
  snapshot,
};

if (args.out) {
  writeFileSync(args.out, JSON.stringify(out));
  console.log(`wrote ${args.out}: ${all.length} reports, ${store.windows.length} windows, snapshot ${JSON.stringify(snapshot).length} bytes`);
}
if (args["snapshot-out"]) {
  writeFileSync(args["snapshot-out"], JSON.stringify(snapshot, null, 2));
  console.log(`wrote ${args["snapshot-out"]}`);
}
if (args.post) {
  const res = await fetch(`${args.post.replace(/\/$/, "")}/__dev/seed?provider=${PROVIDER}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": String(args.key || "") },
    body: JSON.stringify(out),
  });
  console.log(`POST /__dev/seed -> HTTP ${res.status} ${await res.text()}`);
}
