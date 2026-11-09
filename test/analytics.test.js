import { test } from "node:test";
import assert from "node:assert/strict";
import { buildDefaultSettings } from "../src/config.js";
import {
  sameWindow,
  validateReport,
  latestClientVersion,
  compareClientVersions,
  ingestReport,
  computeRow,
  applyHardTransitions,
  processReport,
  computeHeatmap,
  computeOpportunity,
  computeTotals,
  computeWeekly,
  computeWeeklyRow,
  importLegacyRecords,
  dedupeWindows,
  recentRate,
  addInterval,
  emptySnapshot,
  HOUR_MS,
  MINUTE_MS,
  DAY_MS,
  STALE_MS,
  isStale,
} from "../src/analytics.js";

const T0 = Date.parse("2026-10-27T10:00:00.000Z"); // 17:00 GMT+7
const M = MINUTE_MS;
const H = HOUR_MS;

function q(email, used, resetsAt, extra = {}) {
  return { kind: "quota", email, used, resets_at: resetsAt, limits: null, ...extra };
}

function emptyStore() {
  return { states: {}, samples: [], windows: [], gaps: [], machines: [] };
}

/** Apply processReport and fold the writes back into the store, like TeamStore does. */
function post(store, report, now, settings = null) {
  const res = processReport(store, report, now, 1, settings);
  for (const st of res.writes.states) store.states[st.email] = st;
  store.samples.push(...res.writes.samples);
  store.windows.push(...res.writes.windows);
  store.weeks = (store.weeks || []).concat(res.writes.weeks);
  store.gaps.push(...res.writes.gaps);
  for (const m of res.writes.machines) {
    const i = store.machines.findIndex((x) => x.email === m.email && x.machine_id === m.machine_id);
    if (i >= 0) store.machines[i] = m; else store.machines.push(m);
  }
  return res;
}

// --- window identity -------------------------------------------------------

test("same window tolerates 0.5 s and 9 min jitter, not 11 min", () => {
  const r = Date.parse("2026-10-27T17:20:00.169Z");
  assert.equal(sameWindow(r, Date.parse("2026-10-27T17:19:59.669Z")), true);
  assert.equal(sameWindow(r, r + 9 * M), true);
  assert.equal(sameWindow(r, r + 11 * M), false);
  assert.equal(sameWindow(r, null), false);
});

test("jittered resets_at keeps the canonical first-seen value and one window", () => {
  const reset = T0 + 3 * H;
  let s = ingestReport(null, q("a@x.io", 10, reset), T0).state;
  const res = ingestReport(s, q("a@x.io", 20, reset + 500), T0 + 30 * M);
  s = res.state;
  assert.equal(s.resets_at, reset);
  assert.equal(res.windows.length, 0);
});

// --- validation --------------------------------------------------------------

test("validation: old payload, old auth alert, new payload, error_kind", () => {
  const old = validateReport({ email: "Dev@Example.com", used_percent: 53.04, resets_at: "2026-10-27T17:20:00.169588+00:00" });
  assert.equal(old.ok, true);
  assert.equal(old.report.kind, "quota");
  assert.equal(old.report.email, "dev@example.com");
  assert.equal(old.report.used, 53);

  const oldAuth = validateReport({ email: "dev@example.com", status: "auth_required", error: "401" });
  assert.equal(oldAuth.ok, true);
  assert.equal(oldAuth.report.kind, "auth");
  assert.equal(oldAuth.report.auth_state, "auth_required");

  const idle = validateReport({ email: "dev@example.com", status: "auth_required", token_state: "expired_idle" });
  assert.equal(idle.report.auth_state, "expired_idle");

  const parse = validateReport({ email: "dev@example.com", error_kind: "usage_parse_error", error: "x" });
  assert.equal(parse.report.kind, "auth");
  assert.equal(parse.report.auth_state, "error");

  const neu = validateReport({
    email: "dev@example.com", used_percent: 150, resets_at: null, token_state: "ok", client_version: "2.0",
    limits: [{ kind: "weekly_scoped", group: "weekly", percent: 0, resets_at: "2026-10-29T10:00:00+00:00", is_active: false, scope_name: "Fable" }],
  });
  assert.equal(neu.ok, true);
  assert.equal(neu.report.used, 100);
  assert.equal(neu.report.limits.length, 1);
});

test("validation rejects bad input with errors", () => {
  assert.equal(validateReport({ email: "unknown@user", used_percent: 1 }).ok, false);
  assert.equal(validateReport({ email: "nope", used_percent: 1 }).ok, false);
  assert.equal(validateReport({ email: "a@b.co", used_percent: "12" }).ok, false);
  assert.equal(validateReport({ email: "a@b.co", used_percent: NaN }).ok, false);
  assert.equal(validateReport({ email: "a@b.co" }).ok, false);
  assert.equal(validateReport({ email: "a@b.co", used_percent: 1, resets_at: "not a date" }).ok, false);
  assert.equal(validateReport({ email: "a@b.co", used_percent: 1, token_state: "weird" }).ok, false);
  assert.equal(validateReport({ email: "a@b.co", used_percent: 1, limits: new Array(13).fill({}) }).ok, false);
  assert.equal(validateReport({ email: "a@b.co", used_percent: 1, limits: "x" }).ok, false);
  assert.equal(validateReport(null).ok, false);
  assert.equal(validateReport([]).ok, false);
});

// --- auth / dedupe -------------------------------------------------------------

test("auth report (no valid report for > 75 min) keeps previous used, adds no sample, later valid report clears it", () => {
  const reset = T0 + 3 * H;
  const a = ingestReport(null, q("a@x.io", 40, reset), T0);
  const t = T0 + 80 * M;
  const b = ingestReport(a.state, { kind: "auth", email: "a@x.io", auth_state: "expired_idle", error: "401" }, t);
  assert.equal(b.sample, null);
  assert.equal(b.state.used, 40);
  assert.equal(b.state.resets_at, reset);
  const row = computeRow(b.state, [], t);
  assert.equal(row.state_code, "AUTH");
  assert.equal(row.used_percent, 40);
  assert.equal(row.free_now, null);
  assert.equal(row.auth_warning, null);
  assert.match(row.auth_label, /inactivity/);
  assert.equal(row.auth_label_key, "srv_auth_expired_idle");
  const c = ingestReport(b.state, q("a@x.io", 45, reset), t + 10 * M);
  assert.equal(c.state.auth_state, null);
  assert.equal(computeRow(c.state, [], t + 10 * M).state_code, "ACTIVE");
});

test("auth report from another machine within 75 min of a valid report only adds auth_warning", () => {
  const store = emptyStore();
  const reset = T0 + 3 * H;
  // laptop reports validly every 30 min, idle desktop with an expired token reports 2 min later each time
  for (let k = 0; k < 4; k++) {
    const t = T0 + k * 30 * M;
    post(store, q("a@x.io", 20 + k * 10, reset), t);
    const res = post(store, { kind: "auth", email: "a@x.io", auth_state: "expired_idle", error: "401", error_kind: null }, t + 2 * M);
    assert.equal(res.writes.samples.length, 0, "auth path never adds a sample");
    const row = res.snapshot.accounts.find((r) => r.email === "a@x.io");
    assert.equal(row.state_code, "ACTIVE");
    assert.equal(row.used_percent, 20 + k * 10);
    assert.equal(row.auth_state, null);
    assert.deepEqual(row.auth_warning, {
      state: "expired_idle",
      label: "Token expired from inactivity (most likely idle)",
      label_key: "srv_auth_expired_idle",
      label_params: {},
      at: new Date(t + 2 * M).toISOString(),
      error: "401",
      error_kind: null,
      from_other_machine: false,
      last_valid_at: new Date(t).toISOString(),
    });
    assert.equal(res.snapshot.totals.auth_count, 0);
    assert.equal(res.snapshot.totals.free_now_sum, 100 - (20 + k * 10));
  }
  assert.equal(store.states["a@x.io"].resets_at, reset);
  // the next valid report clears the warning
  const ok = post(store, q("a@x.io", 60, reset), T0 + 100 * M);
  assert.equal(ok.snapshot.accounts.find((r) => r.email === "a@x.io").auth_warning, null);
  // no valid report for > 75 min -> the auth report switches the row to AUTH
  const late = post(store, { kind: "auth", email: "a@x.io", auth_state: "expired_idle" }, T0 + 100 * M + 76 * M);
  const row = late.snapshot.accounts.find((r) => r.email === "a@x.io");
  assert.equal(row.state_code, "AUTH");
  assert.equal(row.used_percent, 60);
  assert.equal(row.auth_warning, null);
});

test("auth accounts are excluded from totals and recommendations", () => {
  const store = emptyStore();
  post(store, q("a@x.io", 10, T0 + 4.5 * H), T0);
  post(store, { kind: "auth", email: "a@x.io", auth_state: "auth_required" }, T0 + 80 * M);
  post(store, q("c@x.io", 0, null), T0 + 81 * M);
  post(store, { kind: "auth", email: "c@x.io", auth_state: "auth_required" }, T0 + 82 * M); // valid 1 min ago -> warning only
  const res = post(store, q("b@x.io", 0, null), T0 + 83 * M);
  assert.equal(res.snapshot.totals.auth_count, 1);
  assert.equal(res.snapshot.totals.free_now_sum, 200, "b FRESH + c FRESH with only a warning");
  assert.equal(res.snapshot.opportunity.use_before_reset.length, 0);
  assert.ok(res.snapshot.opportunity.timeline_12h.lanes.every((l) => l.email !== "a@x.io"));
});

test("auth report for an unknown account -> AUTH with used null", () => {
  const store = emptyStore();
  const res = post(store, { kind: "auth", email: "a@x.io", auth_state: "auth_required" }, T0);
  const row = res.snapshot.accounts[0];
  assert.equal(row.state_code, "AUTH");
  assert.equal(row.used_percent, null);
  assert.equal(res.snapshot.opportunity.fresh_now.length, 0);
});

test("duplicate reports within 10 min do not add samples", () => {
  const reset = T0 + 3 * H;
  const a = ingestReport(null, q("a@x.io", 30, reset), T0);
  assert.ok(a.sample);
  const b = ingestReport(a.state, q("a@x.io", 30, reset + 400), T0 + 2 * M);
  assert.equal(b.sample, null);
  assert.equal(b.state.last_report_at, T0 + 2 * M);
  const c = ingestReport(b.state, q("a@x.io", 31, reset), T0 + 3 * M);
  assert.ok(c.sample);
  const d = ingestReport(c.state, q("a@x.io", 31, reset), T0 + 14 * M);
  assert.ok(d.sample, "same numbers but last sample >= 10 min old");
});

// --- several machines on one account -----------------------------------------------

test("validation: fetched_at is optional, ISO or epoch ms, junk rejected", () => {
  const base = { email: "a@x.io", used_percent: 10, resets_at: null };
  assert.equal(validateReport(base).report.fetched_at, null);
  assert.equal(validateReport({ ...base, fetched_at: "2026-10-27T10:00:00Z" }).report.fetched_at, T0);
  assert.equal(validateReport({ ...base, fetched_at: T0 }).report.fetched_at, T0);
  assert.equal(validateReport({ ...base, fetched_at: "nope" }).ok, false);
});

test("out-of-order report (older measurement arriving later) does not overwrite state or add a sample", () => {
  const store = emptyStore();
  const reset = T0 + 3 * H;
  post(store, q("a@x.io", 30, reset, { fetched_at: T0 }), T0 + M);
  post(store, q("a@x.io", 40, reset, { fetched_at: T0 + 10 * M }), T0 + 10 * M + 5000);
  const n = store.samples.length;
  const late = post(store, q("a@x.io", 35, reset, { fetched_at: T0 + 5 * M }), T0 + 12 * M);
  assert.equal(store.states["a@x.io"].used, 40);
  assert.equal(store.samples.length, n);
  assert.equal(late.snapshot.accounts.find((r) => r.email === "a@x.io").used_percent, 40);
  assert.equal(store.states["a@x.io"].last_report_at, T0 + 12 * M);
});

test("skewed client clock: fetched_at is clamped, never blocks the other machine", () => {
  const reset = T0 + 3 * H;
  const a = ingestReport(null, q("a@x.io", 30, reset, { fetched_at: T0 + 30 * H }), T0);
  const b = ingestReport(a.state, q("a@x.io", 32, reset), T0 + 15 * M);
  assert.equal(b.state.used, 32);
  const c = ingestReport(b.state, q("a@x.io", 33, reset, { fetched_at: T0 - 30 * H }), T0 + 20 * M);
  assert.equal(c.state.used, 33);
});

test("report for an earlier window never closes the current one or creates a phantom window", () => {
  const store = emptyStore();
  const r1 = T0 + 3 * H;
  const r2 = r1 + 5 * H;
  post(store, q("a@x.io", 30, r1), T0);
  post(store, q("a@x.io", 5, r2), r1 + M);
  const nw = store.windows.length;
  const before = JSON.stringify(store.states["a@x.io"].win);
  const late = post(store, q("a@x.io", 90, r1), r1 + 2 * M);
  assert.equal(store.windows.length, nw);
  assert.equal(JSON.stringify(store.states["a@x.io"].win), before);
  assert.equal(store.states["a@x.io"].used, 5);
  assert.equal(late.writes.samples.length, 0);
});

test("lower used inside the same window is ignored (history only)", () => {
  const store = emptyStore();
  const reset = T0 + 3 * H;
  post(store, q("a@x.io", 40, reset), T0);
  const res = post(store, q("a@x.io", 35, reset + 300), T0 + 20 * M);
  assert.equal(store.states["a@x.io"].used, 40);
  assert.equal(res.writes.samples.length, 0);
});

test("null resets_at closes an active window only when the measurement is newer than its last sample", () => {
  const reset = T0 + 3 * H;
  const a = ingestReport(null, q("a@x.io", 30, reset), T0 + 10 * M);
  const stale = ingestReport(a.state, q("a@x.io", 0, null, { fetched_at: T0 + 5 * M }), T0 + 11 * M);
  assert.ok(stale.state.win, "older measurement must not close the window");
  assert.equal(stale.windows.length, 0);
  const fresh = ingestReport(a.state, q("a@x.io", 0, null, { fetched_at: T0 + 10 * M + 30000 }), T0 + 11 * M);
  assert.equal(fresh.state.win, null);
  assert.equal(fresh.windows.length, 1);
});

test("same numbers from two machines add one sample, also against recent samples other than last_sample", () => {
  const store = emptyStore();
  const reset = T0 + 3 * H;
  post(store, q("a@x.io", 30, reset, { machine_id: "m1" }), T0 + 2000);
  post(store, q("a@x.io", 30, reset + 400, { machine_id: "m2" }), T0 + 3 * M);
  assert.equal(store.samples.length, 1);
  const st = { ...store.states["a@x.io"], last_sample: { ts: T0 - H, used: 1, resets_at: reset } };
  const r = ingestReport(st, q("a@x.io", 30, reset), T0 + 4 * M, store.samples);
  assert.equal(r.sample, null);
});

test("auth warnings are tracked per machine and do not flap", () => {
  const reset = T0 + 3 * H;
  let st = ingestReport(null, q("a@x.io", 30, reset, { machine_id: "A" }), T0).state;
  const auth = (id, at) => ({ kind: "auth", email: "a@x.io", auth_state: "expired_idle", machine_id: id, error: null, error_kind: null });
  st = ingestReport(st, auth("B", 0), T0 + M).state;
  assert.equal(st.auth_warning.state, "expired_idle");
  assert.equal(st.auth_state, null, "another machine reported validly: no AUTH");
  st = ingestReport(st, q("a@x.io", 31, reset, { machine_id: "A" }), T0 + 2 * M).state;
  assert.ok(st.auth_warning, "A's valid report must not clear B's warning");
  st = ingestReport(st, auth("B", 0), T0 + 3 * M).state;
  assert.equal(Object.keys(st.auth_warnings).length, 1);
  st = ingestReport(st, q("a@x.io", 32, reset, { machine_id: "B" }), T0 + 4 * M).state;
  assert.equal(st.auth_warning, null);
  const lone = ingestReport(st, auth("B", 0), T0 + 90 * M).state;
  assert.equal(lone.auth_state, "expired_idle", "no valid report within 75 min -> AUTH");
});

test("auth reports do not advance ordering or count as measurements", () => {
  const reset = T0 + 3 * H;
  let st = ingestReport(null, q("a@x.io", 30, reset), T0).state;
  st = ingestReport(st, { kind: "auth", email: "a@x.io", auth_state: "auth_required", machine_id: "B" }, T0 + M).state;
  assert.equal(st.used, 30);
  const r = ingestReport(st, q("a@x.io", 31, reset), T0 + 2 * M);
  assert.equal(r.state.used, 31);
});

test("validation accepts optional machine_id and truncates overlong and rejects non-string", () => {
  const base = { email: "a@x.io", used_percent: 10, resets_at: null };
  assert.equal(validateReport({ ...base, machine_id: "abc" }).report.machine_id, "abc");
  assert.equal(validateReport({ ...base, machine_id: "x".repeat(65) }).report.machine_id.length, 64);
  assert.equal(validateReport({ ...base, machine_id: 5 }).ok, false);
  assert.equal(validateReport(base).report.machine_id, null);
});

test("recentRate ignores late lower readings (running max)", () => {
  const reset = T0 + 5 * H;
  const clean = [[10, 10], [40, 20], [70, 30], [100, 40]].map(([m, u]) => ({ ts: T0 + m * M, used: u, resets_at: reset }));
  const noisy = clean.concat([{ ts: T0 + 71 * M, used: 12, resets_at: reset }]);
  const r1 = recentRate(clean, reset, T0 + 105 * M);
  const r2 = recentRate(noisy, reset, T0 + 105 * M);
  assert.ok(Math.abs(r1 - r2) / r1 < 0.03, `${r1} vs ${r2}`);
});

test("recentRate is not skewed by a dense cluster of near-duplicate samples", () => {
  const reset = T0 + 5 * H;
  const base = [[10, 10], [40, 20], [70, 30], [100, 40]].map(([m, u]) => ({ ts: T0 + m * M, used: u, resets_at: reset }));
  const dense = base.concat([101, 102, 103, 104].map((m) => ({ ts: T0 + m * M, used: 40, resets_at: reset })));
  const r1 = recentRate(base, reset, T0 + 105 * M);
  const r2 = recentRate(dense, reset, T0 + 105 * M);
  assert.ok(Math.abs(r1 - r2) / r1 < 0.03, `${r1} vs ${r2}`);
});

// --- row states ------------------------------------------------------------------

test("used 100 before reset -> COOLDOWN", () => {
  const s = ingestReport(null, q("a@x.io", 100, T0 + H), T0).state;
  const row = computeRow(s, [], T0);
  assert.equal(row.state_code, "COOLDOWN");
  assert.equal(row.free_now, 0);
});

test("null resets_at -> FRESH 100%", () => {
  const s = ingestReport(null, q("a@x.io", 0, null), T0).state;
  const row = computeRow(s, [], T0);
  assert.equal(row.state_code, "FRESH");
  assert.equal(row.free_now, 100);
  assert.equal(row.used_percent, 0);
});

test("under 1h into a window -> low confidence, but rate still reported", () => {
  const reset = T0 + 5 * H - 10 * M;
  const s = ingestReport(null, q("a@x.io", 6, reset), T0).state;
  const row = computeRow(s, [], T0);
  assert.equal(row.state_code, "ACTIVE");
  assert.equal(row.confidence, "low");
  assert.ok(row.velocity > 0);
});

test("8% after 10 min (prod case) -> not 'will exhaust', no switch suggestion", () => {
  const reset = T0 + 5 * H - 10 * M;
  const s = ingestReport(null, q("dev@x.io", 8, reset), T0).state;
  const other = ingestReport(null, q("fresh@x.io", 0, null), T0).state;
  const rowDev = computeRow(s, [], T0);
  assert.equal(rowDev.exhaust_at, null);
  assert.ok(rowDev.at_risk_waste > 0);
  const opp = computeOpportunity([rowDev, computeRow(other, [], T0)], [s, other], T0);
  assert.equal(opp.will_exhaust.length, 0);
  assert.ok(opp.use_before_reset.some((x) => x.email === "dev@x.io"));
});

test("stale row -> rate 0 and low confidence", () => {
  const reset = T0 + 4 * H;
  const s = ingestReport(null, q("a@x.io", 20, reset), T0).state;
  const row = computeRow(s, [], T0 + 80 * M);
  assert.equal(row.state_code, "ACTIVE");
  assert.equal(row.stale, true);
  assert.equal(row.velocity, 0);
  assert.equal(row.confidence, "low");
  assert.equal(row.projected_percent, 20);
  assert.equal(row.at_risk_waste, 80);
});

test("ACTIVE analytics follow the formulas", () => {
  // window started 2h ago (reset in 3h), used 20 -> r_window = 10 %/h
  const reset = T0 + 3 * H;
  const s = ingestReport(null, q("a@x.io", 20, reset), T0).state;
  const row = computeRow(s, [], T0);
  assert.equal(row.rate_window, 10);
  assert.equal(row.rate_recent, null);
  assert.equal(row.confidence, "medium");
  assert.equal(row.raw_projection, 50);
  assert.equal(row.at_risk_waste, 50);
  assert.equal(row.burn_needed_per_h, 26.7);
  assert.equal(row.exhaust_at, null);

  // recent samples: 20 -> 56 in 60 min -> r_recent 36, rate = 0.6*36 + 0.4*(56/3) = 29.07
  // projection = 56 + 29.07 * 2 = 114 -> exhausts before reset
  const samples = [
    { email: "a@x.io", ts: T0, used: 20, resets_at: reset },
    { email: "a@x.io", ts: T0 + 30 * M, used: 38, resets_at: reset },
    { email: "a@x.io", ts: T0 + 60 * M, used: 56, resets_at: reset },
  ];
  const s2 = ingestReport(s, q("a@x.io", 56, reset), T0 + H).state;
  const row2 = computeRow(s2, samples, T0 + H);
  assert.equal(row2.rate_recent, 36);
  assert.equal(row2.confidence, "high");
  assert.equal(row2.velocity, 29.1);
  assert.equal(row2.at_risk_waste, 0);
  assert.ok(row2.exhaust_at);
  assert.ok(Date.parse(row2.exhaust_at) < reset);
});

test("velocity never crosses a window boundary", () => {
  const oldReset = T0 + 10 * M;
  const newReset = T0 + 5 * H + 20 * M;
  const samples = [
    { email: "a@x.io", ts: T0 - 60 * M, used: 90, resets_at: oldReset },
    { email: "a@x.io", ts: T0 - 30 * M, used: 95, resets_at: oldReset },
    { email: "a@x.io", ts: T0 + 20 * M, used: 2, resets_at: newReset },
  ];
  let s = ingestReport(null, q("a@x.io", 95, oldReset), T0 - 30 * M).state;
  s = ingestReport(s, q("a@x.io", 2, newReset), T0 + 20 * M).state;
  const row = computeRow(s, samples, T0 + 20 * M);
  assert.equal(row.rate_recent, null, "only one sample in the new window");
  assert.ok(row.velocity >= 0);
});

// --- window close / idle gaps -----------------------------------------------------

test("past reset -> FRESH and window closed with waste and uncertainty", () => {
  const reset = T0 + H;
  const store = emptyStore();
  post(store, q("a@x.io", 30, reset), T0); // last sample 60 min before reset
  const res = post(store, q("b@x.io", 0, null), T0 + 2 * H); // someone else reports later
  const closed = res.writes.windows.filter((w) => w.email === "a@x.io");
  assert.equal(closed.length, 1);
  assert.equal(closed[0].final_used, 30);
  assert.equal(closed[0].waste, 70);
  assert.equal(closed[0].uncertainty_min, 60);
  assert.equal(closed[0].start_ts, reset - 5 * H);
  const rowA = res.snapshot.accounts.find((r) => r.email === "a@x.io");
  assert.equal(rowA.state_code, "FRESH");
  // idempotent: another POST does not close it again
  const res2 = post(store, q("b@x.io", 0, null), T0 + 3 * H);
  assert.equal(res2.writes.windows.filter((w) => w.email === "a@x.io").length, 0);
});

test("new window in a report closes the previous one and records the idle gap", () => {
  const r1 = T0 + H;
  const r2 = T0 + 9 * H; // next window starts T0+4h -> gap 3h
  let s = ingestReport(null, q("a@x.io", 60, r1), T0).state;
  const res = ingestReport(s, q("a@x.io", 5, r2), T0 + 4 * H + 10 * M);
  assert.equal(res.windows.length, 1);
  assert.equal(res.windows[0].waste, 40);
  assert.equal(res.gaps.length, 1);
  assert.equal(res.gaps[0].start_ts, r1);
  assert.equal(res.gaps[0].end_ts, r2 - 5 * H);
  s = res.state;
  assert.equal(s.idle_from, null);
});

test("resets_at jitter right after reset does not reopen the closed window", () => {
  const reset = T0 + H;
  let s = ingestReport(null, q("a@x.io", 40, reset), T0).state;
  // report 0.2 s after reset, API still shows the old resets_at jittered +0.5 s
  const res = ingestReport(s, q("a@x.io", 40, reset + 500), reset + 200);
  assert.equal(res.windows.length, 1);
  s = res.state;
  assert.equal(s.win, null);
  assert.equal(computeRow(s, [], reset + 200).state_code, "FRESH");
});

test("window closed early by a null report is reopened if reported active again", () => {
  const reset = T0 + 3 * H;
  let s = ingestReport(null, q("a@x.io", 40, reset), T0).state;
  const early = ingestReport(s, q("a@x.io", 0, null), T0 + 10 * M);
  assert.equal(early.windows.length, 1);
  const back = ingestReport(early.state, q("a@x.io", 45, reset + 300), T0 + 20 * M);
  s = back.state;
  assert.ok(s.win);
  assert.equal(s.win.resets_at, reset);
  assert.equal(s.idle_from, null);
  assert.equal(back.gaps.length, 0);
  assert.equal(computeRow(s, [], T0 + 20 * M).state_code, "ACTIVE");
});

test("idle gap counts 20/h in the right GMT+7 hour buckets", () => {
  // gap 01:00-03:00 GMT+7 = 18:00-20:00 UTC
  const start = Date.parse("2026-10-26T18:00:00Z");
  const end = Date.parse("2026-10-26T20:00:00Z");
  const now = Date.parse("2026-10-27T10:00:00Z");
  const st = { email: "a@x.io", first_seen: now - 12 * H, win: null, idle_from: null };
  const hm = computeHeatmap([st], [], [{ email: "a@x.io", start_ts: start, end_ts: end }], now);
  const v = hm.heatmap.accounts[0].values;
  assert.equal(v[1], 20);
  assert.equal(v[2], 20);
  assert.equal(v[0], 0);
  assert.equal(v[3], 0);
  assert.deepEqual(hm.heatmap.team.slice(0, 4), [0, 20, 20, 0]);
  assert.equal(hm.golden_hours[0].hour, 1);
  assert.equal(hm.stats["a@x.io"].idle_hours, 2);
});

test("partial-hour intervals are split by minute fraction", () => {
  const b = new Array(24).fill(0);
  // 12:20-13:20 GMT+7 at 20/h -> 40 min in 12h, 20 min in 13h
  addInterval(b, Date.parse("2026-10-27T05:20:00Z"), Date.parse("2026-10-27T06:20:00Z"), 20);
  assert.ok(Math.abs(b[12] - 13.333) < 0.01);
  assert.ok(Math.abs(b[13] - 6.667) < 0.01);
});

test("window waste spreads waste/5 per hour and averages over observed days", () => {
  const now = Date.parse("2026-10-27T10:00:00Z");
  const st = { email: "a@x.io", first_seen: now - 2 * DAY_MS, win: null, idle_from: null };
  // window 00:00-05:00 GMT+7 on 27/10 with waste 50 -> 10/h, /2 days = 5
  const w = { email: "a@x.io", start_ts: Date.parse("2026-10-26T17:00:00Z"), end_ts: Date.parse("2026-10-26T22:00:00Z"), final_used: 50, waste: 50, last_sample_ts: Date.parse("2026-10-26T21:50:00Z") };
  const hm = computeHeatmap([st], [w], [], now);
  assert.equal(hm.heatmap.accounts[0].values[0], 5);
  assert.equal(hm.heatmap.accounts[0].values[4], 5);
  assert.equal(hm.heatmap.accounts[0].values[5], 0);
  assert.equal(hm.stats["a@x.io"].windows_closed, 1);
  assert.equal(hm.stats["a@x.io"].efficiency, 50);
  assert.equal(hm.history.windows[0].unc, 10);
  assert.equal(hm.history.daily[0].waste_pct[13], 50);
});

test("windows with an unknown tail (> 30 min) give an efficiency range; known tails give a single number", () => {
  const now = Date.parse("2026-10-27T10:00:00Z");
  const st = { email: "a@x.io", first_seen: now - 2 * DAY_MS, win: null, idle_from: null };
  const base = { email: "a@x.io", final_used: 50, waste: 50 };
  const known = { ...base, start_ts: Date.parse("2026-10-26T17:00:00Z"), end_ts: Date.parse("2026-10-26T22:00:00Z"), last_sample_ts: Date.parse("2026-10-26T21:50:00Z") };
  let stats = computeHeatmap([st], [known], [], now).stats["a@x.io"];
  assert.equal(stats.efficiency, 50);
  assert.equal(stats.efficiency_max, 50);
  assert.equal(stats.uncertain_windows, 0);
  // last sample 2h before the end: only a lower bound (true use may have been 100%)
  const lost = { ...base, start_ts: known.start_ts, end_ts: known.end_ts, last_sample_ts: known.end_ts - 2 * H };
  stats = computeHeatmap([st], [lost], [], now).stats["a@x.io"];
  assert.equal(stats.efficiency, 50);
  assert.equal(stats.efficiency_max, 100);
  assert.equal(stats.uncertain_windows, 1);
  assert.equal(stats.silent_hours, 2);
});

test("pooled provider: idle time of the current weekly period is not waste once the weekly limit is >= 95%", () => {
  const now = Date.parse("2026-10-27T10:00:00Z");
  const weeklyReset = now + 2 * DAY_MS; // week started 5 days ago
  const mk = (weeklyUsed) => ({
    email: "a@x.io#gemini", pool: "gemini", first_seen: now - 10 * DAY_MS, win: null, idle_from: null,
    limits: [{ group: "weekly", percent: weeklyUsed, is_active: true, resets_at: weeklyReset }],
  });
  // idle 6 days ago .. 3 days ago: 3 days of it is before the week start (kept), 1 day... only the part after week start is excluded
  const gap = { email: "a@x.io#gemini", start_ts: now - 6 * DAY_MS, end_ts: now - 3 * DAY_MS };
  const binding = computeHeatmap([mk(100)], [], [gap], now).stats["a@x.io#gemini"];
  const loose = computeHeatmap([mk(40)], [], [gap], now).stats["a@x.io#gemini"];
  assert.equal(loose.idle_hours, 72);
  assert.equal(binding.weekly_binding, true);
  assert.equal(binding.idle_hours, 24); // 6d..5d ago is the previous week, 5d..3d ago is excluded
  assert.equal(binding.idle_excluded_hours, 48);
  assert.equal(loose.weekly_binding, false);
  // Claude (no pool) is never affected
  const claude = { ...mk(100), pool: null };
  assert.equal(computeHeatmap([claude], [], [gap], now).stats["a@x.io#gemini"].idle_hours, 72);
});

test("open FRESH tail counts only up to last report + 30 min", () => {
  const now = Date.parse("2026-10-27T10:00:00Z");
  const st = { email: "a@x.io", first_seen: now - DAY_MS, win: null, idle_from: now - 4 * H, last_valid_at: now - 3 * H };
  const hm = computeHeatmap([st], [], [], now);
  assert.equal(hm.stats["a@x.io"].idle_hours, 1.5);
});

// --- recommendations / weekly ---------------------------------------------------------

test("recommendation ordering: use_before_reset by waste per remaining hour", () => {
  const now = T0;
  const rows = [
    { email: "a@x.io", state_code: "ACTIVE", at_risk_waste: 50, used_percent: 20, free_now: 80, resets_at: new Date(now + 4 * H).toISOString(), confidence: "medium" },
    { email: "b@x.io", state_code: "ACTIVE", at_risk_waste: 30, used_percent: 60, free_now: 40, resets_at: new Date(now + H).toISOString(), confidence: "high" },
    { email: "c@x.io", state_code: "ACTIVE", at_risk_waste: 5, used_percent: 90, free_now: 10, resets_at: new Date(now + H).toISOString(), confidence: "high" },
    { email: "d@x.io", state_code: "ACTIVE", at_risk_waste: 90, used_percent: 5, free_now: 0, resets_at: new Date(now + H).toISOString(), weekly_capped: true },
  ];
  const opp = computeOpportunity(rows, [], now);
  assert.deepEqual(opp.use_before_reset.map((x) => x.email), ["b@x.io", "a@x.io"]);
  assert.match(opp.use_before_reset[0].text, /will be lost at/);
  assert.equal(opp.use_before_reset[0].text_key, "srv_opp_waste");
  assert.equal(opp.use_before_reset[0].text_params.waste, 30);
});

test("others lists every account not in another list, actionable lists untouched (prod case)", () => {
  const now = T0;
  const iso = (ms) => new Date(now + ms).toISOString();
  const rows = [
    { email: "dinh@x.io", state_code: "ACTIVE", at_risk_waste: 62, used_percent: 19, free_now: 81, resets_at: iso(3 * H), confidence: "high" },
    // prod: dev 5% free, waste 1.1%, resets in 11 min -> below the 10% bar
    { email: "dev@x.io", state_code: "ACTIVE", at_risk_waste: 1.1, used_percent: 95, free_now: 5, resets_at: iso(11 * 60000), confidence: "high" },
    { email: "cuong@x.io", state_code: "ACTIVE", at_risk_waste: 0, used_percent: 80, free_now: 20, resets_at: iso(3 * H), exhaust_at: iso(H), confidence: "high" },
    { email: "fresh@x.io", state_code: "FRESH", free_now: 100 },
    { email: "cap@x.io", state_code: "COOLDOWN", weekly_capped: true, free_now: 0, resets_at: iso(30 * H) },
    { email: "auth@x.io", state_code: "AUTH", auth_state: "auth_required", free_now: null, pacing_badge_text: "Login required", pacing_badge_text_key: "srv_badge_login" },
    { email: "idle@x.io", state_code: "AUTH", auth_state: "expired_idle", free_now: null },
  ];
  const opp = computeOpportunity(rows, [], now);
  assert.deepEqual(opp.use_before_reset.map((x) => x.email), ["dinh@x.io"]);
  assert.deepEqual(opp.fresh_now.map((x) => x.email), ["fresh@x.io"]);
  assert.deepEqual(opp.will_exhaust.map((x) => x.email), ["cuong@x.io"]);
  // others: free_now desc, unreadable last; expired_idle stays out (the dashboard lists it itself)
  assert.deepEqual(opp.others.map((x) => x.email), ["dev@x.io", "cap@x.io", "auth@x.io"]);
  const dev = opp.others[0];
  assert.equal(dev.kind, "no_action");
  assert.match(dev.text, /^No need to switch yet · 5% free, resets /);
  assert.match(dev.text, /\(11m left\)/);
  assert.equal(dev.text_key, "srv_other_no_action");
  assert.equal(dev.text_params.left, 11 * 60000);
  assert.equal(opp.others[1].kind, "weekly_capped");
  assert.match(opp.others[1].text, /^Weekly cap reached/);
  assert.equal(opp.others[2].kind, "unreadable");
  assert.match(opp.others[2].text, /^Not measured yet · Login required/);
  assert.deepEqual(opp.others[2].text_params, { reason: "srv_badge_login" });
  // every account is in exactly one place (expired_idle is rendered by the dashboard from the rows)
  const placed = [...opp.use_before_reset, ...opp.fresh_now, ...opp.will_exhaust, ...opp.others].map((x) => x.email);
  assert.equal(new Set(placed).size, placed.length);
  assert.equal(placed.length, rows.length - 1);
});

test("fresh_now sorted by idle time; will_exhaust suggests a fresh alternative", () => {
  const now = T0;
  const rows = [
    { email: "f1@x.io", state_code: "FRESH", free_now: 100 },
    { email: "f2@x.io", state_code: "FRESH", free_now: 100 },
    { email: "e@x.io", state_code: "ACTIVE", at_risk_waste: 0, used_percent: 80, free_now: 20, resets_at: new Date(now + 3 * H).toISOString(), exhaust_at: new Date(now + H).toISOString() },
  ];
  const states = [
    { email: "f1@x.io", win: null, idle_from: now - H },
    { email: "f2@x.io", win: null, idle_from: now - 6 * H },
  ];
  const opp = computeOpportunity(rows, states, now);
  assert.deepEqual(opp.fresh_now.map((x) => x.email), ["f2@x.io", "f1@x.io"]);
  assert.equal(opp.will_exhaust.length, 1);
  assert.equal(opp.will_exhaust[0].alternative.email, "f2@x.io");
  const lane = opp.timeline_12h.lanes.find((l) => l.email === "e@x.io");
  assert.deepEqual(lane.events.map((e) => e.type), ["exhaust", "reset"]);
});

test("weekly cap >= 95 excludes the account; no limits -> weekly unknown", () => {
  const now = T0;
  assert.equal(computeWeekly(null, now).weekly_used, null);
  const w = computeWeekly([
    { kind: "seven_day", group: "weekly", percent: 96, resets_at: now + DAY_MS, is_active: true },
    { kind: "weekly_scoped", group: "weekly", percent: 0, resets_at: now + DAY_MS, is_active: false },
  ], now);
  assert.equal(w.weekly_used, 96);
  assert.equal(w.weekly_capped, true);
  assert.equal(computeWeekly([{ kind: "weekly_scoped", group: "weekly", percent: 0, resets_at: now + DAY_MS, is_active: false }], now).weekly_used, 0);

  const store = emptyStore();
  const capped = [{ kind: "seven_day", group: "weekly", percent: 97, resets_at: now + DAY_MS, is_active: true, scope_name: null }];
  post(store, q("a@x.io", 0, null, { limits: capped }), now);
  const res = post(store, q("b@x.io", 0, null), now + M);
  const a = res.snapshot.accounts.find((r) => r.email === "a@x.io");
  assert.equal(a.weekly_capped, true);
  assert.equal(a.free_now, 0);
  assert.equal(res.snapshot.totals.free_now_sum, 100);
  assert.deepEqual(res.snapshot.opportunity.fresh_now.map((x) => x.email), ["b@x.io"]);
});

// --- recompute policy -------------------------------------------------------------------

test("other accounts are NOT re-extrapolated on someone else's POST", () => {
  const store = emptyStore();
  const reset = T0 + 3 * H;
  post(store, q("a@x.io", 20, reset), T0);
  const before = store.states["a@x.io"].row;
  const res = post(store, q("b@x.io", 0, null), T0 + 50 * M);
  const a = res.snapshot.accounts.find((r) => r.email === "a@x.io");
  assert.equal(a.computed_at, before.computed_at);
  assert.equal(a.projected_percent, before.projected_percent);
  assert.equal(a.velocity, before.velocity);
  assert.equal(a.resets_in, "2h 10m");
  assert.equal(res.snapshot.trigger_email, "b@x.io");

  // staleness flag only (projection unchanged, confidence downgraded)
  const res2 = post(store, q("b@x.io", 0, null), T0 + 80 * M);
  const a2 = res2.snapshot.accounts.find((r) => r.email === "a@x.io");
  assert.equal(a2.stale, true);
  assert.equal(a2.confidence, "low");
  assert.equal(a2.projected_percent, before.projected_percent);
});

test("applyHardTransitions closes a COOLDOWN window at reset and switches to FRESH", () => {
  const reset = T0 + H;
  const st = ingestReport(null, q("a@x.io", 100, reset), T0).state;
  st.row = computeRow(st, [], T0);
  const ht = applyHardTransitions(st, reset + M);
  assert.equal(ht.changed, true);
  assert.equal(ht.state.row.state_code, "FRESH");
  assert.equal(ht.windows[0].waste, 0);
});

// --- legacy import ---------------------------------------------------------------------------

test("legacy KV records replay into states, samples and windows", () => {
  const r1 = "2026-10-27T05:00:00.000Z";
  const r2 = "2026-10-27T12:00:00.000Z";
  const out = importLegacyRecords([{
    email: "Old@X.io",
    used_percent: 10,
    resets_at: r2,
    updated_at: "2026-10-27T07:30:00.000Z",
    auth_error: false,
    history: [
      { timestamp: "2026-10-27T03:00:00.000Z", used_percent: 40, resets_at: r1 },
      { timestamp: "2026-10-27T04:30:00.000Z", used_percent: 70, resets_at: r1 },
      { timestamp: "2026-10-27T06:00:00.000Z", used_percent: 0, resets_at: null },
      { timestamp: "2026-10-27T07:30:00.000Z", used_percent: 10, resets_at: r2 },
    ],
  }]);
  const st = out.states["old@x.io"];
  assert.ok(st);
  assert.equal(out.samples.length, 3, "null-resets point skipped");
  assert.equal(out.windows.length, 1);
  assert.equal(out.windows[0].waste, 30);
  assert.equal(out.gaps.length, 1);
  assert.equal(st.row.state_code, "ACTIVE");
  assert.equal(st.row.computed_at, "2026-10-27T07:30:00.000Z");
});

// --- verifier fixes ---------------------------------------------------------------------------

test("will_exhaust alternative is never an account that itself runs out before reset", () => {
  const store = emptyStore();
  const R = T0 + 4 * H; // elapsed 1h
  post(store, q("a@x.io", 60, R), T0); // 60 %/h -> exhausts
  const res = post(store, q("b@x.io", 30, R), T0); // 30 %/h -> 150 at reset -> exhausts too
  const we = res.snapshot.opportunity.will_exhaust;
  assert.equal(we.length, 2);
  for (const x of we) assert.equal(x.alternative, null);
  // a healthy ACTIVE account becomes the alternative; a stale one does not
  const res2 = post(store, q("c@x.io", 5, T0 + 4.5 * H), T0 + M);
  assert.equal(res2.snapshot.opportunity.will_exhaust.find((x) => x.email === "a@x.io").alternative.email, "c@x.io");
  // at T0+80m b reports flat usage (no longer exhausting); c is stale (> 75 min) -> a's alternative is b, not c
  const res3 = post(store, q("b@x.io", 30, R), T0 + 80 * M);
  const a3 = res3.snapshot.opportunity.will_exhaust.find((x) => x.email === "a@x.io");
  assert.equal(a3.alternative.email, "b@x.io");
  assert.equal(res3.snapshot.accounts.find((r) => r.email === "c@x.io").stale, true);
});

test("will_exhaust alternative is never AUTH or weekly-capped; capped rows are not listed", () => {
  const store = emptyStore();
  const R = T0 + 4 * H;
  const capLimits = [{ kind: "seven_day", group: "weekly", percent: 97, resets_at: T0 + 3 * DAY_MS, is_active: true, scope_name: null }];
  post(store, q("a@x.io", 60, R), T0);
  post(store, q("c@x.io", 0, null, { limits: capLimits }), T0);
  post(store, { kind: "auth", email: "d@x.io", auth_state: "auth_required" }, T0);
  const res = post(store, q("e@x.io", 60, R, { limits: capLimits }), T0 + M); // capped AND exhausting
  const we = res.snapshot.opportunity.will_exhaust;
  assert.deepEqual(we.map((x) => x.email), ["a@x.io"]);
  assert.equal(we[0].alternative, null);
  // warning_count = distinct accounts: a (exhaust), c (capped), d (auth), e (capped, not double counted)
  assert.equal(res.snapshot.totals.warning_count, 4);
  assert.equal(res.snapshot.totals.exhaust_count, 1);
});

test("weekly_used is null when no current weekly limit carries a numeric percent", () => {
  assert.equal(computeWeekly([{ kind: "seven_day", group: "weekly", percent: null, resets_at: T0 + DAY_MS, is_active: true }], T0).weekly_used, null);
  assert.equal(computeWeekly([{ kind: "session", group: "session", percent: 40, resets_at: null, is_active: true }], T0).weekly_used, null);
  assert.equal(computeWeekly([], T0).weekly_used, null);
  assert.equal(computeWeekly([{ kind: "seven_day", group: "weekly", percent: 50, resets_at: T0 - M, is_active: true }], T0).weekly_used, null);
});

test("legacy import skips malformed records and non-object history entries", () => {
  const r = "2026-10-27T12:00:00.000Z";
  const out = importLegacyRecords([
    null,
    "junk",
    { email: 42 },
    { email: "bad@x.io", history: "nope", updated_at: 5 },
    { email: "ok@x.io", history: [null, 7, "x", [1], { timestamp: 123, used_percent: 5, resets_at: r },
      { timestamp: "2026-10-27T08:00:00.000Z", used_percent: 25, resets_at: r }], updated_at: "2026-10-27T08:00:00.000Z" },
  ]);
  assert.deepEqual(Object.keys(out.states), ["ok@x.io"]);
  assert.equal(out.samples.length, 1);
  assert.equal(importLegacyRecords("not an array").samples.length, 0);
});

test("a window closed early, reopened and closed again is counted once", () => {
  const store = emptyStore();
  const R = T0 + 3 * H;
  post(store, q("a@x.io", 40, R), T0);
  post(store, q("a@x.io", 0, null), T0 + 10 * M); // closes early (stored row #1)
  post(store, q("a@x.io", 70, R), T0 + 20 * M); // reopened
  const res = post(store, q("b@x.io", 0, null), R + M); // a's window closes at reset (row #2, same identity)
  assert.equal(store.windows.filter((w) => w.email === "a@x.io").length, 2, "both rows exist in the raw store");
  const stats = res.snapshot.accounts.find((r) => r.email === "a@x.io").stats_14d;
  assert.equal(stats.windows_closed, 1);
  assert.equal(stats.total_wasted, 30);
  assert.equal(dedupeWindows(store.windows).length, 1);
});

test("client v3 payloads (regex, LLM fallback, error kinds) validate", () => {
  const ok = validateReport({
    email: "dev@example.com", used_percent: 19, resets_at: "2026-10-28T04:40:00+00:00", token_state: "ok",
    client_version: "3.0", machine_id: "abc", fetched_at: 1793145000000, parse_source: "llm_fallback",
    parse_status: "llm_verified", low_confidence: true,
    limits: [{ kind: "weekly", group: "weekly", percent: 0, resets_at: "2026-10-29T10:00:00+00:00", is_active: true, scope_name: "Fable" }],
  });
  assert.equal(ok.ok, true);
  assert.equal(ok.report.kind, "quota");
  assert.equal(ok.report.used, 19);
  for (const error_kind of ["parse_error", "usage_timeout", "claude_failed", "claude_missing"]) {
    const r = validateReport({ email: "dev@example.com", error_kind, error: "x", machine_id: "abc", client_version: "3.0" });
    assert.equal(r.ok, true, error_kind);
    assert.equal(r.report.kind, "auth");
  }
  const login = validateReport({ email: "dev@example.com", error_kind: "auth_required", status: "auth_required", token_state: "auth_required", error: "x" });
  assert.equal(login.report.auth_state, "auth_required");
});

test("low-confidence waste is a range: dev case 14% after 22 min -> 0..~21", () => {
  const reset = T0 + 5 * H - 22 * M;
  const s = ingestReport(null, q("dev@x.io", 14, reset), T0).state;
  const row = computeRow(s, [], T0);
  assert.equal(row.confidence, "low");
  assert.equal(row.uncertain, true);
  assert.equal(row.uncertain_reason, "early_window");
  assert.equal(row.at_risk_waste_min, 0);
  assert.ok(Math.abs(row.at_risk_waste_max - 21) < 1, `max ${row.at_risk_waste_max}`);
  assert.equal(row.at_risk_waste, row.at_risk_waste_max);
});

test("medium/high confidence -> single value (min == max, not uncertain)", () => {
  const reset = T0 + 3 * H;
  const s = ingestReport(null, q("a@x.io", 40, reset), T0).state;
  const row = computeRow(s, [], T0);
  assert.equal(row.uncertain, false);
  assert.equal(row.uncertain_reason, null);
  assert.equal(row.at_risk_waste_min, row.at_risk_waste_max);
});

test("totals headline sums lower bounds and exposes the max", () => {
  const reset = T0 + 5 * H - 22 * M;
  const s1 = ingestReport(null, q("dev@x.io", 14, reset), T0).state;
  const s2 = ingestReport(null, q("b@x.io", 40, T0 + 3 * H), T0).state;
  const rows = [computeRow(s1, [], T0), computeRow(s2, [], T0)];
  const opp = computeOpportunity(rows, [s1, s2], T0);
  const t = computeTotals(rows, opp);
  assert.equal(t.uncertain_count, 1);
  assert.equal(t.at_risk_waste_sum, rows[1].at_risk_waste);
  assert.ok(t.at_risk_waste_max_sum > t.at_risk_waste_sum);
  const dev = opp.use_before_reset.find((x) => x.email === "dev@x.io");
  if (dev) {
    assert.equal(dev.uncertain, true);
    assert.match(dev.text, /uncertain/);
    assert.equal(dev.text_key, "srv_opp_waste_maybe");
  }
});

test("one machine reporting for two different accounts keeps auth warnings independent per account", () => {
  const reset = T0 + 3 * H;
  const auth = (email) => ({ kind: "auth", email, auth_state: "expired_idle", machine_id: "M", error: null, error_kind: null });
  let a = ingestReport(null, q("a@x.io", 30, reset, { machine_id: "M" }), T0).state;
  let b = ingestReport(null, q("b@x.io", 10, reset, { machine_id: "M" }), T0 + M).state;
  a = ingestReport(a, auth("a@x.io"), T0 + 2 * M).state;
  assert.equal(a.auth_warning.state, "expired_idle");
  b = ingestReport(b, q("b@x.io", 12, reset, { machine_id: "M" }), T0 + 3 * M).state;
  assert.equal(b.auth_warning, null, "B's valid report from machine M must not touch A's warning");
  assert.equal(a.auth_warning.state, "expired_idle");
  assert.equal(a.used, 30);
  assert.equal(b.used, 12);
  b = ingestReport(b, auth("b@x.io"), T0 + 4 * M).state;
  assert.equal(b.auth_warning.state, "expired_idle");
  assert.equal(b.auth_state, null);
  a = ingestReport(a, q("a@x.io", 31, reset, { machine_id: "M" }), T0 + 5 * M).state;
  assert.equal(a.auth_warning, null);
  assert.equal(b.auth_warning.state, "expired_idle", "A's recovery must not clear B's warning");
});

test("validateReport accepts machine_name/os, truncates long values, rejects non-strings", () => {
  const ok = validateReport({ email: "a@x.io", used_percent: 5, resets_at: null, machine_id: "m1", machine_name: "Mac-mini", os: "Darwin" });
  assert.equal(ok.report.machine_name, "Mac-mini");
  assert.equal(ok.report.os, "Darwin");
  assert.equal(validateReport({ email: "a@x.io", used_percent: 5, resets_at: null, machine_name: 5 }).ok, false);
  assert.equal(validateReport({ email: "a@x.io", used_percent: 5, resets_at: null, os: "x".repeat(33) }).report.os.length, 32);
  const old = validateReport({ email: "a@x.io", used_percent: 5, resets_at: null });
  assert.equal(old.report.machine_name, null);
});

test("machines: one row per (account, machine), counts ok/err, first seen kept, old clients grouped as unknown", () => {
  const store = emptyStore();
  const reset = T0 + 3 * H;
  post(store, q("a@x.io", 10, reset, { machine_id: "m1", machine_name: "mini", os: "Darwin", ip: "1.2.3.4", country: "VN", client_version: "3.2" }), T0);
  post(store, q("a@x.io", 12, reset, { machine_id: "m1", machine_name: "mini" }), T0 + 30 * M);
  post(store, q("a@x.io", 13, reset, { machine_id: "m2", machine_name: "laptop", os: "Windows" }), T0 + 31 * M);
  post(store, q("a@x.io", 14, reset), T0 + 32 * M); // old client, no machine_id
  const res = post(store, { kind: "auth", email: "a@x.io", auth_state: "error", error_kind: "usage_timeout", machine_id: "m1" }, T0 + 40 * M);
  const row = res.snapshot.accounts[0];
  assert.equal(row.machines.length, 3);
  const m1 = row.machines.find((m) => m.machine_id === "m1");
  assert.equal(m1.reports_ok, 2);
  assert.equal(m1.reports_err, 1);
  assert.equal(m1.first_seen, new Date(T0).toISOString());
  assert.equal(m1.last_valid, new Date(T0 + 30 * M).toISOString());
  assert.equal(m1.last_error_kind, "usage_timeout");
  assert.equal(m1.status, "error");
  assert.equal(m1.ip, "1.2.3.4");
  assert.equal(m1.country, "VN");
  assert.equal(row.machines[0].machine_id, "m1", "newest report first");
  const unknownMachine = row.machines.find((m) => m.machine_id === "unknown");
  assert.equal(unknownMachine.name, "unknown machine (old client)");
  assert.equal(unknownMachine.name_key, "srv_machine_unknown");
  assert.equal(res.snapshot.total_machines, 3);
});

test("machines: 1 machine only binds to 1 account at a time (exclusive current binding); moving accounts detaches from old account", () => {
  const store = emptyStore();
  const reset = T0 + 3 * H;
  post(store, q("a@x.io", 10, reset, { machine_id: "m1", machine_name: "mini" }), T0);
  post(store, q("b@x.io", 20, reset, { machine_id: "m1", machine_name: "mini" }), T0 + M);
  const res = post(store, q("b@x.io", 25, reset, { machine_id: "m2", machine_name: "pc" }), T0 + 100 * M);
  const a = res.snapshot.accounts.find((r) => r.email === "a@x.io");
  const b = res.snapshot.accounts.find((r) => r.email === "b@x.io");
  // a@x.io no longer has m1 as active because m1 moved to b@x.io
  assert.equal(a.machines.length, 0);
  assert.equal(a.detached_machines.length, 1);
  assert.equal(a.detached_machines[0].machine_id, "m1");
  assert.equal(a.detached_machines[0].moved_to, "b@x.io");
  // b@x.io has both m2 and m1 as active machines, sorted newest first
  assert.equal(b.machines.length, 2);
  assert.equal(b.machines[0].machine_id, "m2");
  assert.equal(b.machines[1].machine_id, "m1");
  // m1 was reported at T0 + M and snapshot is at T0 + 100 * M (> 40 min old limit), so m1 on b is silent
  assert.equal(b.machines[1].status, "silent");
  assert.equal(res.snapshot.total_machines, 2);
});

test("machines: connectivity calculation (online <= 20m buffer for 15m idle interval, idle <= 2h, offline > 2h, error)", () => {
  const store = emptyStore();
  const reset = T0 + 5 * H;
  // m-online pinged 5 min ago
  post(store, q("test@x.io", 10, reset, { machine_id: "m-online", machine_name: "box-1" }), T0 + 95 * M);
  // m-online-buf pinged 18 min ago (within the 20-minute online threshold)
  post(store, q("test@x.io", 10, reset, { machine_id: "m-online-buf", machine_name: "box-buf" }), T0 + 82 * M);
  // m-idle pinged 30 min ago
  post(store, q("test@x.io", 10, reset, { machine_id: "m-idle", machine_name: "box-2" }), T0 + 70 * M);
  // m-offline pinged 3 hours ago
  post(store, q("test@x.io", 10, reset, { machine_id: "m-offline", machine_name: "box-3" }), T0 - 80 * M);
  // snapshot evaluated at T0 + 100 * M
  const res = post(store, q("test@x.io", 12, reset, { machine_id: "m-online", machine_name: "box-1" }), T0 + 100 * M);
  const acct = res.snapshot.accounts.find((r) => r.email === "test@x.io");
  assert.equal(acct.machines.length, 4);
  const mOnline = acct.machines.find((m) => m.machine_id === "m-online");
  const mOnlineBuf = acct.machines.find((m) => m.machine_id === "m-online-buf");
  const mIdle = acct.machines.find((m) => m.machine_id === "m-idle");
  const mOffline = acct.machines.find((m) => m.machine_id === "m-offline");
  assert.equal(mOnline.connectivity, "online");
  assert.equal(mOnlineBuf.connectivity, "online");
  assert.equal(mIdle.connectivity, "idle");
  assert.equal(mOffline.connectivity, "offline");
});

test("machines: name normalization strips .local and trims whitespace", () => {
  const store = emptyStore();
  const reset = T0 + 3 * H;
  const res = post(store, q("norm@x.io", 10, reset, { machine_id: "m-mac", machine_name: "  Nam-MacBook-Pro.local  " }), T0);
  const acct = res.snapshot.accounts.find((r) => r.email === "norm@x.io");
  assert.equal(acct.machines[0].name, "Nam-MacBook-Pro");
});

test("warning note: from_other_machine only when the last valid measurement came from a different machine", () => {
  const store = emptyStore();
  const reset = T0 + 3 * H;
  post(store, q("a@x.io", 10, reset, { machine_id: "m1" }), T0);
  // same machine fails once after succeeding: NOT "from another machine"
  let res = post(store, { kind: "auth", email: "a@x.io", auth_state: "error", error_kind: "usage_timeout", machine_id: "m1" }, T0 + 30 * M);
  let w = res.snapshot.accounts[0].auth_warning;
  assert.equal(w.from_other_machine, false);
  assert.equal(w.last_valid_at, new Date(T0).toISOString());
  assert.equal(w.error_kind, "usage_timeout");
  // another machine fails while m1 is the last valid one: it IS another machine
  res = post(store, { kind: "auth", email: "a@x.io", auth_state: "expired_idle", error_kind: null, machine_id: "m2" }, T0 + 31 * M);
  w = res.snapshot.accounts[0].auth_warning;
  assert.equal(w.from_other_machine, true);
});

test("emptySnapshot has no accounts", () => {
  const s = emptySnapshot();
  assert.equal(s.total_accounts, 0);
  assert.deepEqual(s.opportunity.use_before_reset, []);
});

test("machines: update_status/update_checked_at are validated, stored per machine and exposed with an outdated flag", () => {
  const v = validateReport({ email: "a@x.io", used_percent: 10, resets_at: new Date(T0 + 3 * H).toISOString(), machine_id: "m1",
    client_version: "3.4", update_status: "current", update_checked_at: T0 });
  assert.equal(v.ok, true);
  assert.equal(v.report.update_status, "current");
  assert.equal(v.report.update_checked_at, T0);
  assert.equal(validateReport({ email: "a@x.io", used_percent: 10, update_status: 5 }).ok, false);
  assert.equal(validateReport({ email: "a@x.io", used_percent: 10, update_status: "x".repeat(200) }).report.update_status.length, 80);
  assert.equal(validateReport({ email: "a@x.io", used_percent: 10, update_checked_at: "yesterday" }).report.update_checked_at, null);

  const store = emptyStore();
  const reset = T0 + 3 * H;
  post(store, q("a@x.io", 10, reset, { machine_id: "new", client_version: "3.4", update_status: "updated_from_3.3", update_checked_at: T0 + M }), T0 + M);
  post(store, q("a@x.io", 11, reset, { machine_id: "old", client_version: "3.3", update_status: "gh_missing", update_checked_at: T0 + 2 * M }), T0 + 2 * M);
  post(store, q("a@x.io", 12, reset, { machine_id: "ancient" }), T0 + 3 * M); // no client_version at all
  const res = post(store, q("a@x.io", 13, reset, { machine_id: "new", client_version: "3.4", update_status: "current", update_checked_at: T0 + 9 * H }), T0 + 4 * M);
  const by = Object.fromEntries(res.snapshot.accounts[0].machines.map((m) => [m.machine_id, m]));
  assert.equal(res.snapshot.latest_client_version, "3.4");
  assert.equal(by.new.outdated, false);
  assert.equal(by.new.update_status, "current");
  assert.equal(by.new.update_checked_at, new Date(T0 + 4 * M).toISOString(), "a future check time is clamped to now");
  assert.equal(by.old.outdated, true);
  assert.equal(by.old.update_status, "gh_missing");
  assert.equal(by.ancient.outdated, true);
  assert.equal(by.new.late_after_min, 20);
  assert.equal(by.old.late_after_min, 40);
});

test("a machine that never measured (v9.9, no valid report) does not make the others outdated", () => {
  const store = emptyStore();
  const reset = T0 + 3 * H;
  post(store, q("a@x.io", 10, reset, { machine_id: "real", client_version: "3.6" }), T0);
  const res = post(store, { kind: "auth", email: "a@x.io", auth_state: "error", error_kind: "claude_missing", machine_id: "box", client_version: "9.9" }, T0 + M);
  const by = Object.fromEntries(res.snapshot.accounts[0].machines.map((m) => [m.machine_id, m]));
  assert.equal(res.snapshot.latest_client_version, "3.6");
  assert.equal(by.real.outdated, false);
});

test("client versions compare numerically (3.10 > 3.9) and nothing is outdated when no machine reports a version", () => {
  assert.equal(latestClientVersion([{ client_version: "3.9", last_valid_ts: 1 }, { client_version: "3.10", last_valid_ts: 1 }, { client_version: "x", last_valid_ts: 1 }, { client_version: "9.9", last_valid_ts: null }]), "3.10");
  assert.ok(compareClientVersions([3, 10], [3, 9]) > 0);
  assert.equal(compareClientVersions([3, 4], [3, 4, 0]), 0);
  const store = emptyStore();
  const res = post(store, q("a@x.io", 10, T0 + 3 * H, { machine_id: "m" }), T0);
  assert.equal(res.snapshot.accounts[0].machines[0].outdated, false);
  assert.equal(res.snapshot.latest_client_version, null);
});

test("edge cases: machine hops A -> B -> C leaves detached on A and B, active on C", () => {
  const store = emptyStore();
  const reset = T0 + 5 * H;
  post(store, q("accA@x.io", 10, reset, { machine_id: "traveler", machine_name: "MacBook.local" }), T0);
  post(store, q("accB@x.io", 20, reset, { machine_id: "traveler", machine_name: "MacBook" }), T0 + 10 * M);
  const res = post(store, q("accC@x.io", 30, reset, { machine_id: "traveler", machine_name: "MacBook" }), T0 + 20 * M);

  const accA = res.snapshot.accounts.find((r) => r.email === "accA@x.io");
  const accB = res.snapshot.accounts.find((r) => r.email === "accB@x.io");
  const accC = res.snapshot.accounts.find((r) => r.email === "accC@x.io");

  assert.equal(accA.machines.length, 0);
  assert.equal(accA.detached_machines.length, 1);
  assert.equal(accA.detached_machines[0].moved_to, "accc@x.io");

  assert.equal(accB.machines.length, 0);
  assert.equal(accB.detached_machines.length, 1);
  assert.equal(accB.detached_machines[0].moved_to, "accc@x.io");

  assert.equal(accC.machines.length, 1);
  assert.equal(accC.machines[0].machine_id, "traveler");
  assert.equal(accC.machines[0].name, "MacBook");
  assert.equal(accC.machines[0].is_current, true);
});

test("edge cases: multiple machines concurrently active on the same account", () => {
  const store = emptyStore();
  const reset = T0 + 5 * H;
  post(store, q("team@x.io", 10, reset, { machine_id: "m1", machine_name: "dev-mini" }), T0);
  post(store, q("team@x.io", 20, reset, { machine_id: "m2", machine_name: "dev-laptop" }), T0 + 5 * M);
  const res = post(store, q("team@x.io", 30, reset, { machine_id: "m3", machine_name: "dev-desktop" }), T0 + 10 * M);

  const team = res.snapshot.accounts.find((r) => r.email === "team@x.io");
  assert.equal(team.machines.length, 3);
  assert.equal(team.machines[0].machine_id, "m3");
  assert.equal(team.machines[1].machine_id, "m2");
  assert.equal(team.machines[2].machine_id, "m1");
  assert.equal(team.detached_machines.length, 0);
  assert.equal(team.last_seen_machine.machine_id, "m3");
});

test("edge cases: account without machines has empty arrays and null last_seen_machine", () => {
  const store = emptyStore();
  // An auth report with no machine_id or manual report
  const res = post(store, { kind: "auth", email: "alone@x.io", auth_state: "auth_required" }, T0);
  const acct = res.snapshot.accounts.find((r) => r.email === "alone@x.io");
  // If unknown client or no machine
  assert.ok(Array.isArray(acct.machines));
  assert.ok(Array.isArray(acct.detached_machines));
});

test("edge cases: machine error connectivity marked as error", () => {
  const store = emptyStore();
  const reset = T0 + 3 * H;
  post(store, q("err@x.io", 10, reset, { machine_id: "bad-box", machine_name: "failing" }), T0);
  const res = post(store, { kind: "auth", email: "err@x.io", auth_state: "error", error_kind: "usage_timeout", machine_id: "bad-box" }, T0 + 5 * M);
  const acct = res.snapshot.accounts.find((r) => r.email === "err@x.io");
  const m = acct.machines.find((x) => x.machine_id === "bad-box");
  assert.equal(m.status, "error");
  assert.equal(m.connectivity, "error");
});

// Machine names come from configuration (MACHINE_LABELS / Settings), never from built-in defaults.
const LABELED = buildDefaultSettings({
  MACHINE_LABELS: JSON.stringify({ "a1b2c3": "DevA", "d4e5f6": "DevB", "0a9b8c": "BuildBox", "7c6d5e": "DevC", "1f2e3d": "DevD" }),
});

test("known machine mapping: matches all 5 requested machines by hash, id_short, or name", () => {
  const store = emptyStore();
  const reset = T0 + 5 * H;

  // 1. #a1b2c3 -> DevA
  post(store, q("dinh@x.io", 10, reset, { machine_id: "a1b2c3739c074c859f3263cf1c88cc72", machine_name: "MacBook-Pro-cua-mac.local" }), T0, LABELED);
  // 2. #d4e5f6 -> DevB
  post(store, q("nam@x.io", 10, reset, { machine_id: "d4e5f692d89a458b9722e4d4d7b5f9d8", machine_name: "Nguyens-MacBook-Pro-2.local" }), T0, LABELED);
  // 3. #0a9b8c -> BuildBox
  post(store, q("gx@x.io", 10, reset, { machine_id: "0a9b8c1d08d546b48c883e2de10f325e", machine_name: "buildbox-a617" }), T0, LABELED);
  // 4. #7c6d5e -> DevC
  post(store, q("ly@x.io", 10, reset, { machine_id: "7c6d5e46a04645ac95006a98ed437072", machine_name: "Mac.lan" }), T0, LABELED);
  // 5. #1f2e3d -> DevD
  const res = post(store, q("cuong@x.io", 10, reset, { machine_id: "1f2e3dd9e2a44b3e8e554bd611e0f54a", machine_name: "Macs-Mac-mini.local" }), T0, LABELED);

  const dinh = res.snapshot.accounts.find((r) => r.email === "dinh@x.io");
  const nam = res.snapshot.accounts.find((r) => r.email === "nam@x.io");
  const gx = res.snapshot.accounts.find((r) => r.email === "gx@x.io");
  const ly = res.snapshot.accounts.find((r) => r.email === "ly@x.io");
  const cuong = res.snapshot.accounts.find((r) => r.email === "cuong@x.io");

  assert.equal(dinh.machines[0].name, "DevA");
  assert.equal(dinh.machines[0].id_short, "DevA");
  assert.equal(dinh.machines[0].raw_name, null);
  assert.equal(nam.machines[0].name, "DevB");
  assert.equal(nam.machines[0].id_short, "DevB");
  assert.equal(gx.machines[0].name, "BuildBox");
  assert.equal(gx.machines[0].id_short, "BuildBox");
  assert.equal(ly.machines[0].name, "DevC");
  assert.equal(ly.machines[0].id_short, "DevC");
  assert.equal(cuong.machines[0].name, "DevD");
  assert.equal(cuong.machines[0].id_short, "DevD");
});

test("known machine mapping: name containing hash or friendly label groups to the same identity key", () => {
  const store = emptyStore();
  const reset = T0 + 5 * H;

  // DevA pings from full UUID on acc1
  post(store, q("acc1@x.io", 10, reset, { machine_id: "a1b2c3739c074c859f3263cf1c88cc72", machine_name: "MacBook-Pro" }), T0, LABELED);
  // Later DevA pings from a client sending name 'DevA' or '#a1b2c3' on acc2
  const res = post(store, q("acc2@x.io", 15, reset, { machine_id: "unknown", machine_name: "DevA" }), T0 + 10 * M, LABELED);

  const acc1 = res.snapshot.accounts.find((r) => r.email === "acc1@x.io");
  const acc2 = res.snapshot.accounts.find((r) => r.email === "acc2@x.io");

  // Since both resolved to mapped:deva, acc1 has DevA detached, acc2 has DevA active!
  assert.equal(acc1.machines.length, 0);
  assert.equal(acc1.detached_machines.length, 1);
  assert.equal(acc1.detached_machines[0].name, "DevA");
  assert.equal(acc1.detached_machines[0].moved_to, "acc2@x.io");

  assert.equal(acc2.machines.length, 1);
  assert.equal(acc2.machines[0].name, "DevA");
  assert.equal(acc2.machines[0].is_current, true);
});

test("computeMachineStats aggregates machine stats, accounts touched, intensity, and telemetry", () => {
  const store = emptyStore();
  const reset = T0 + 5 * H;

  // DevB reports on acc1 with telemetry
  post(store, q("nam@x.io", 20, reset, {
    machine_id: "d4e5f692d89a458b9722e4d4d7b5f9d8",
    machine_name: "MacBook-Pro",
    os: "Darwin",
    telemetry: { total_tokens: 1500000, total_sessions: 42, burn_rate: 25.5, tokens_1h: 500000, msgs_1h: 30 },
  }), T0, LABELED);

  // DevB switches to acc2 10 minutes later
  const res = post(store, q("nam2@x.io", 50, reset, {
    machine_id: "d4e5f692d89a458b9722e4d4d7b5f9d8",
    machine_name: "MacBook-Pro",
    os: "Darwin",
    telemetry: { total_tokens: 1800000, total_sessions: 45, burn_rate: 30.0, tokens_1h: 4000000, msgs_1h: 80 },
  }), T0 + 10 * M, LABELED);

  const stats = res.snapshot.machine_stats;
  assert.ok(Array.isArray(stats));
  const namStat = stats.find((m) => m.name === "DevB");
  assert.ok(namStat);
  assert.equal(namStat.connectivity, "online");
  assert.equal(namStat.active_email, "nam2@x.io");
  assert.equal(namStat.intensity, "high");
  assert.equal(namStat.usage_tokens_1h, 4000000);
  assert.equal(namStat.reports_ok, 2);
  assert.equal(namStat.accounts_touched.length, 2);
  assert.equal(namStat.accounts_touched[0].email, "nam2@x.io");
  assert.equal(namStat.accounts_touched[0].is_active, true);
  assert.equal(namStat.accounts_touched[1].email, "nam@x.io");
  assert.equal(namStat.accounts_touched[1].is_active, false);
  assert.equal(namStat.telemetry.total_tokens, 1800000);
});

test("machine intensity follows the machine's own tokens, not the shared account's burn rate", () => {
  const store = emptyStore();
  const reset = T0 + 5 * H;
  const tel = (t) => ({ total_tokens: 1, burn_rate: 40, tokens_1h: t, msgs_1h: 1 });
  // Two machines on the same account (used 85%, high velocity): only the busy one may be "high".
  post(store, q("shared@x.io", 60, reset, { machine_id: "d4e5f692d89a458b9722e4d4d7b5f9d8", telemetry: tel(5000000) }), T0, LABELED);
  post(store, q("shared@x.io", 85, reset, { machine_id: "0a9b8caaaaaaaaaaaaaaaaaaaaaaaaaa", telemetry: tel(10000) }), T0 + 5 * M, LABELED);
  const res = post(store, q("old@x.io", 10, reset, { machine_id: "7c6d5ebbbbbbbbbbbbbbbbbbbbbbbbbb" }), T0 + 6 * M, LABELED);
  const by = (n) => res.snapshot.machine_stats.find((m) => m.name === n);
  assert.equal(by("DevB").intensity, "high");
  assert.equal(by("BuildBox").intensity, "moderate");
  assert.equal(by("DevC").intensity, "unknown"); // client without tokens_1h
});

test("agy provider produces independent 5h and 7d subview aggregates", () => {
  const store = emptyStore();
  const now = T0;
  const reset5h = now + 4 * H;
  const reset7d = now + 5 * DAY_MS;

  function agyReport(email, pool, used, resetsAt, weeklyUsed = 0, resetsWeekly = reset7d) {
    const limits = [{ group: "weekly", percent: weeklyUsed, resets_at: resetsWeekly, is_active: true }];
    return {
      kind: "quota",
      email,
      provider: "agy",
      pool,
      account_key: `${email}#${pool}`,
      used,
      resets_at: resetsAt,
      limits,
      five_hour_disabled: resetsAt === null && used === 100,
    };
  }

  // Account 1: Gemini 5h at 10%, weekly at 5%
  post(store, agyReport("user1@x.io", "gemini", 10, reset5h, 5), now);

  // Account 1: Claude 5h at 20%, weekly at 10%
  post(store, agyReport("user1@x.io", "claude", 20, reset5h, 10), now);

  // Account 2: Weekly capped (100%), five_hour_disabled
  const res = post(store, agyReport("user2@x.io", "gemini", 100, null, 100), now);

  const snap = res.snapshot;
  assert.equal(snap.provider, "agy");
  assert.ok(snap.subviews);
  assert.ok(snap.subviews["5h"]);
  assert.ok(snap.subviews["7d"]);

  // 5h subview totals
  assert.equal(snap.subviews["5h"].totals.total_accounts, undefined); // raw totals
  assert.ok(snap.subviews["5h"].by_pool.gemini);
  assert.ok(snap.subviews["5h"].by_pool.claude);

  // 7d subview totals
  assert.ok(snap.subviews["7d"].by_pool.gemini);
  assert.ok(snap.subviews["7d"].by_pool.claude);

  // user2 is weekly-capped in 7d
  const gemini7d = snap.subviews["7d"].by_pool.gemini;
  assert.equal(gemini7d.totals.capped_count, 1);
});

test("time_to_reset is evaluated at now, independent of report arrival time", () => {
  const store = emptyStore();
  const reset1530 = T0 + 195 * M; // 15:30 (3h15m from T0 12:15)

  // Account 1: dev reports at T0 (12:15)
  post(store, q("dev@example.com", 100, reset1530, { machine_id: "m-dev" }), T0);

  // Account 2: team account reports at T0 + 140 * M (14:35, ~1m before now)
  const now = T0 + 141 * M; // 14:36
  const res = post(store, q("team-account@example.com", 100, reset1530, { machine_id: "m-team" }), now);

  const snap = res.snapshot;
  const devRow = snap.accounts.find((r) => r.email === "dev@example.com");
  const teamRow = snap.accounts.find((r) => r.email === "team-account@example.com");

  assert.ok(devRow);
  assert.ok(teamRow);

  // Remaining time to reset at evaluation time 'now' (14:36) must be identical! (195m - 141m = 54m)
  assert.equal(devRow.resets_at, teamRow.resets_at);
  assert.equal(devRow.resets_in, "54m");
  assert.equal(teamRow.resets_in, "54m");
  assert.equal(devRow.remaining_hours, 0.9);
  assert.equal(teamRow.remaining_hours, 0.9);
});

test("computeWeeklyRow mirrors the 5h model over a 7-day window", async () => {
  const { computeWeeklyRow, HOUR_MS } = await import("../src/analytics.js");
  const now = Date.parse("2026-11-03T00:00:00Z");
  const row = (used, hoursLeft, extra = {}) => ({
    state_code: "ACTIVE", stale: false, weekly_used: used,
    weekly_resets_at: new Date(now + hoursLeft * HOUR_MS).toISOString(), ...extra,
  });
  // 84h into the week, 30% used -> 0.357%/h, 84h left -> 60% projected, ~40% lost
  const mid = computeWeeklyRow(row(30, 84), now);
  assert.equal(mid.state_code, "ACTIVE");
  assert.equal(mid.projected_percent, 60);
  assert.equal(mid.at_risk_waste, 40);
  assert.equal(mid.exhaust_at, null);
  assert.equal(mid.uncertain, false);
  // 60% used after 84h -> would hit 100% at 168h+... here 120% projected -> exhausts before reset
  const hot = computeWeeklyRow(row(60, 84), now);
  assert.equal(hot.at_risk_waste, 0);
  assert.equal(hot.pacing_status, "danger");
  assert.ok(Date.parse(hot.exhaust_at) > now && Date.parse(hot.exhaust_at) < now + 84 * HOUR_MS);
  assert.equal(hot.burn_needed_per_h, 0.5);
  // first hours of the week: rough estimate
  const early = computeWeeklyRow(row(5, 165), now);
  assert.equal(early.uncertain, true);
  assert.ok(early.at_risk_waste_min <= early.at_risk_waste_max);
  // capped
  const capped = computeWeeklyRow(row(97, 40), now);
  assert.equal(capped.state_code, "COOLDOWN");
  assert.equal(capped.weekly_capped, true);
  // no weekly figure yet: no forecast
  assert.equal(computeWeeklyRow({ state_code: "ACTIVE", weekly_used: null }, now).at_risk_waste, 0);
  assert.equal(computeWeeklyRow({ state_code: "AUTH" }, now).state_code, undefined);
});

// --- provider usage resets (quota set back to 0% by the provider) -----------

function wkLimit(percent, resetsAt) {
  return [{ group: "weekly", percent, is_active: true, resets_at: resetsAt }];
}

test("5h reset inside the same window: no waste row, pace measured from the reset", () => {
  const store = emptyStore();
  const R = T0 + 4 * H;
  post(store, q("a@x.io", 10, R), T0);
  post(store, q("a@x.io", 60, R), T0 + 60 * M);
  const res = post(store, q("a@x.io", 5, R), T0 + 70 * M); // provider reset: 60 -> 5
  assert.equal(res.writes.windows.length, 0, "the interrupted window is not recorded as waste");
  assert.equal(res.state.win.last_used, 5, "tracking continues from the new level (not ignored as out-of-order)");
  assert.equal(res.state.reset_5h_ts, T0 + 70 * M);
  const row = computeRow(res.state, store.samples, T0 + 130 * M);
  assert.equal(row.reset_5h_at, new Date(T0 + 70 * M).toISOString());
  // 1h after the reset the pace is measured over that hour, not over the 2h10 the window has run
  assert.ok(Math.abs(row.rate_window - 5) < 1.5, `rate ${row.rate_window}`);
});

test("a small drop (out-of-order report) is not a reset", () => {
  const store = emptyStore();
  const R = T0 + 4 * H;
  post(store, q("a@x.io", 40, R), T0);
  const res = post(store, q("a@x.io", 36, R), T0 + 5 * M);
  assert.equal(res.state.win.last_used, 40);
  assert.equal(res.state.reset_5h_ts, null);
});

test("a different window while the old one still had time left = early provider reset, window not wasted", () => {
  const store = emptyStore();
  post(store, q("a@x.io", 70, T0 + 3 * H), T0);
  const res = post(store, q("a@x.io", 2, T0 + 7 * H), T0 + 2 * H);
  assert.equal(res.writes.windows.length, 0);
  assert.equal(res.state.reset_5h_ts, T0 + 2 * H);
});

test("a window that simply expires is still closed with its waste", () => {
  const store = emptyStore();
  post(store, q("a@x.io", 70, T0 + 3 * H), T0);
  const res = post(store, q("a@x.io", 5, T0 + 8 * H), T0 + 3 * H + 5 * M);
  assert.equal(res.writes.windows.length, 1);
  assert.equal(res.writes.windows[0].waste, 30);
  assert.equal(res.state.reset_5h_ts, null);
});

test("weekly reset: used drops while the week still runs -> pace measured from the reset", () => {
  const store = emptyStore();
  const WR = T0 + 3 * DAY_MS; // 4 days into the week
  post(store, q("a@x.io", 10, T0 + 4 * H, { limits: wkLimit(70, WR) }), T0);
  const res = post(store, q("a@x.io", 10, T0 + 4 * H, { limits: wkLimit(2, WR) }), T0 + 30 * M);
  assert.equal(res.state.reset_weekly_ts, T0 + 30 * M);
  const row = computeRow(res.state, store.samples, T0 + 12 * H);
  assert.equal(row.reset_weekly_at, new Date(T0 + 30 * M).toISOString());
  const w = computeWeeklyRow(row, T0 + 12 * H);
  // 2% in the ~11.5h since the reset (floor 6h): ~0.17 %/h, not 2% over the 4 days of the old week (~0.02 %/h)
  assert.ok(w.rate_window > 0.1, `weekly rate ${w.rate_window}`);
});

test("natural weekly rollover is not a reset", () => {
  const store = emptyStore();
  const WR = T0 + 30 * M;
  post(store, q("a@x.io", 10, T0 + 4 * H, { limits: wkLimit(80, WR) }), T0);
  const res = post(store, q("a@x.io", 10, T0 + 4 * H, { limits: wkLimit(1, WR + 7 * DAY_MS) }), T0 + 40 * M);
  assert.equal(res.state.reset_weekly_ts, null);
});

// --- weekly history (closed weekly quota periods) ---------------------------

test("weekly period closes with its final used when the week ends", () => {
  const store = emptyStore();
  const WR = T0 + 2 * DAY_MS;
  post(store, q("a@x.io", 10, T0 + 4 * H, { limits: wkLimit(30, WR) }), T0);
  post(store, q("a@x.io", 10, T0 + 4 * H, { limits: wkLimit(64, WR) }), T0 + DAY_MS);
  assert.equal(store.states["a@x.io"].week.last_used, 64);
  const res = post(store, q("a@x.io", 5, T0 + 2 * DAY_MS + 4 * H, { limits: wkLimit(1, WR + 7 * DAY_MS) }), WR + 10 * M);
  assert.equal(res.writes.weeks.length, 1);
  assert.deepEqual(res.writes.weeks[0], { email: "a@x.io", start_ts: WR - 7 * DAY_MS, end_ts: WR, final_used: 64, waste: 36 });
  assert.equal(res.state.week.last_used, 1, "the next week is tracked");
  assert.equal(res.snapshot.history_weekly.weeks.length, 1, "the freshly closed week is already in the snapshot");
});

test("a week interrupted by a provider reset is not recorded", () => {
  const store = emptyStore();
  const WR = T0 + 3 * DAY_MS;
  post(store, q("a@x.io", 10, T0 + 4 * H, { limits: wkLimit(70, WR) }), T0);
  const res = post(store, q("a@x.io", 10, T0 + 4 * H, { limits: wkLimit(2, WR) }), T0 + 30 * M);
  assert.equal(res.writes.weeks.length, 0);
  assert.equal(res.state.week.last_used, 2);
});

test("a week that ends with no report is closed by applyHardTransitions", () => {
  const store = emptyStore();
  const WR = T0 + 2 * DAY_MS;
  post(store, q("a@x.io", 10, T0 + 4 * H, { limits: wkLimit(40, WR) }), T0);
  const ht = applyHardTransitions(store.states["a@x.io"], WR + H);
  assert.equal(ht.weeks.length, 1);
  assert.equal(ht.weeks[0].final_used, 40);
  assert.equal(ht.state.week, null);
});

test("closed weeks reach the snapshot history_weekly (newest first, account_key)", () => {
  const store = emptyStore();
  store.weeks = [
    { email: "a@x.io", start_ts: T0 - 14 * DAY_MS, end_ts: T0 - 7 * DAY_MS, final_used: 50, waste: 50 },
    { email: "a@x.io", start_ts: T0 - 7 * DAY_MS, end_ts: T0, final_used: 80, waste: 20 },
  ];
  const res = post(store, q("a@x.io", 10, T0 + 4 * H), T0 + M);
  const w = res.snapshot.history_weekly.weeks;
  assert.deepEqual(w.map((x) => x.final_used), [80, 50]);
  assert.equal(w[0].account_key, "a@x.io");
});

test("token_delta accumulates per (machine, account), ignores retried deltas and bad input", () => {
  const store = emptyStore();
  const reset = T0 + 5 * H;
  const mid = "d4e5f692d89a458b9722e4d4d7b5f9d8";
  const d = (since, until, input, output, msgs) => ({ since, until, input, output, msgs });
  post(store, q("a@x.io", 10, reset, { machine_id: mid, token_delta: d(T0 - 10 * M, T0, 100, 50, 2) }), T0);
  post(store, q("a@x.io", 11, reset, { machine_id: mid, token_delta: d(T0, T0 + 5 * M, 200, 80, 3) }), T0 + 5 * M);
  // same delta again (client retry after a lost response): not counted twice
  post(store, q("a@x.io", 11, reset, { machine_id: mid, token_delta: d(T0, T0 + 5 * M, 200, 80, 3) }), T0 + 6 * M);
  // account switch: the next delta belongs to b
  post(store, q("b@x.io", 5, reset, { machine_id: mid, token_delta: d(T0 + 5 * M, T0 + 10 * M, 1000, 400, 7) }), T0 + 10 * M);
  // malformed delta is dropped, report still accepted
  const res = post(store, q("b@x.io", 6, reset, { machine_id: mid, token_delta: { since: "x", until: 1 } }), T0 + 11 * M);
  const stat = res.snapshot.machine_stats.find((m) => m.machine_id === mid);
  const by = Object.fromEntries(stat.accounts_touched.map((a) => [a.email, a.tokens]));
  assert.deepEqual([by["a@x.io"].input, by["a@x.io"].output, by["a@x.io"].msgs], [300, 130, 5]);
  assert.deepEqual([by["b@x.io"].input, by["b@x.io"].output, by["b@x.io"].msgs], [1000, 400, 7]);
});

test("isStale: returns false when last_report_at is fresh even if last_valid_at is old", () => {
  const now = T0 + 120 * M;
  // last_valid_at is 120m ago (> 75m), but last_report_at is only 5m ago
  const s = {
    last_valid_at: T0,
    last_report_at: now - 5 * M,
  };
  assert.equal(isStale(s, now), false, "should not be stale when last_report_at is fresh");

  // both last_valid_at and last_report_at are older than STALE_MS
  const sOld = {
    last_valid_at: T0,
    last_report_at: T0 + 10 * M,
  };
  assert.equal(isStale(sOld, now), true, "should be stale when both are > 75m ago");

  // last_valid_at is fresh, last_report_at is old
  const sValidFresh = {
    last_valid_at: now - 10 * M,
    last_report_at: T0,
  };
  assert.equal(isStale(sValidFresh, now), false, "should not be stale when last_valid_at is fresh");
});

test("ingestReport: out-of-order 5h report with valid weekly limits updates s.limits and last_valid_at", () => {
  const store = emptyStore();
  const reset = T0 + 3 * H;
  const wkReset = T0 + 7 * DAY_MS;
  const weeklyLimits1 = [
    { kind: "weekly", group: "weekly", percent: 40, resets_at: wkReset, is_active: true },
  ];
  const weeklyLimits2 = [
    { kind: "weekly", group: "weekly", percent: 45, resets_at: wkReset, is_active: true },
  ];

  // 1. Initial report with 5h 50% and weekly 40%
  const res1 = post(store, {
    kind: "quota",
    email: "a@x.io",
    used: 50,
    resets_at: reset,
    limits: weeklyLimits1,
  }, T0);
  assert.equal(store.states["a@x.io"].used, 50);
  assert.equal(store.states["a@x.io"].last_valid_at, T0);

  // 2. Out-of-order report inside same window (used 35 < 50), but with newer weekly limits (45%) at T0 + 30m
  const res2 = post(store, {
    kind: "quota",
    email: "a@x.io",
    used: 35,
    resets_at: reset,
    limits: weeklyLimits2,
  }, T0 + 30 * M);

  // 5h used must remain 50 (not downgraded), but limits and last_valid_at MUST be updated
  assert.equal(store.states["a@x.io"].used, 50);
  assert.equal(store.states["a@x.io"].last_valid_at, T0 + 30 * M);
  assert.equal(store.states["a@x.io"].limits[0].percent, 45);

  // Row computed at T0+30m must reflect weekly 45% and not be stale
  const row = computeRow(store.states["a@x.io"], store.samples, T0 + 30 * M);
  assert.equal(row.stale, false);
  assert.equal(row.weekly_used, 45);

  const wkRow = { ...row, ...computeWeeklyRow(row, T0 + 30 * M) };
  assert.equal(wkRow.weekly_used, 45);
  assert.equal(wkRow.stale, false);
  assert.ok(wkRow.velocity > 0, "weekly velocity must not be zero");
});

test("ingestReport: report with older R < ref but valid limits updates limits and last_valid_at", () => {
  const store = emptyStore();
  const r1 = T0 + H;
  const wkReset = T0 + 7 * DAY_MS;
  post(store, {
    kind: "quota",
    email: "a@x.io",
    used: 60,
    resets_at: r1,
    limits: [{ kind: "weekly", group: "weekly", percent: 30, resets_at: wkReset, is_active: true }],
  }, T0);

  // At T0 + 2h, window r1 has closed. A report arrives with older R = T0 + 30m, but updated weekly limits (35%)
  const res = post(store, {
    kind: "quota",
    email: "a@x.io",
    used: 20,
    resets_at: T0 + 30 * M,
    limits: [{ kind: "weekly", group: "weekly", percent: 35, resets_at: wkReset, is_active: true }],
  }, T0 + 2 * H);

  assert.equal(store.states["a@x.io"].last_valid_at, T0 + 2 * H);
  assert.equal(store.states["a@x.io"].limits[0].percent, 35);
  const row = computeRow(store.states["a@x.io"], store.samples, T0 + 2 * H);
  assert.equal(row.stale, false);
  assert.equal(row.weekly_used, 35);
});

