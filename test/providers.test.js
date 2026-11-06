import { test } from "node:test";
import assert from "node:assert/strict";
import {
  validateReport,
  expandReport,
  processReport,
  applyHardTransitions,
  buildSnapshot,
  emptySnapshot,
  computeOpportunity,
  HOUR_MS,
  MINUTE_MS,
  DAY_MS,
} from "../src/analytics.js";

const T0 = Date.parse("2026-10-27T10:00:00.000Z");
const M = MINUTE_MS;
const H = HOUR_MS;
const iso = (ts) => new Date(ts).toISOString();

function emptyStore() {
  return { states: {}, samples: [], windows: [], gaps: [], machines: [] };
}

/** Validate a body, expand it and fold every resulting report into the store like TeamStore does. */
function postBody(store, body, now) {
  const v = validateReport(body);
  assert.equal(v.ok, true, v.error);
  let res = null;
  for (const report of expandReport(v.report)) {
    res = processReport(store, report, now, 1);
    for (const st of res.writes.states) store.states[st.email] = st;
    store.samples.push(...res.writes.samples);
    store.windows.push(...res.writes.windows);
    store.gaps.push(...res.writes.gaps);
    for (const m of res.writes.machines) {
      const i = store.machines.findIndex((x) => x.email === m.email && x.machine_id === m.machine_id);
      if (i >= 0) store.machines[i] = m; else store.machines.push(m);
    }
  }
  return res;
}

function agy(email, pool, used, resetsAt, extra = {}) {
  return { email, provider: "agy", pool, used_percent: used, resets_at: resetsAt === null ? null : iso(resetsAt), machine_id: "m1", ...extra };
}

const weekly = (pool, percent, resetsAt) => [{ kind: "weekly", group: "weekly", percent, resets_at: iso(resetsAt), is_active: true, scope_name: pool }];

test("validation: provider defaults to claude, pool rules per provider, five_hour_disabled", () => {
  const old = validateReport({ email: "a@x.io", used_percent: 10, resets_at: null });
  assert.equal(old.report.provider, "claude");
  assert.equal(old.report.pool, null);
  assert.equal(old.report.account_key, "a@x.io");
  assert.equal(old.report.five_hour_disabled, undefined);

  assert.equal(validateReport({ email: "a@x.io", used_percent: 1, provider: "openai" }).ok, false);
  assert.equal(validateReport({ email: "a@x.io", used_percent: 1, provider: "claude", pool: "gemini" }).ok, false);
  assert.equal(validateReport({ email: "a@x.io", used_percent: 1, provider: "agy" }).ok, false, "agy quota needs a pool");
  assert.equal(validateReport({ email: "a@x.io", used_percent: 1, provider: "agy", pool: "gpt" }).ok, false);
  assert.equal(validateReport({ email: "a@x.io", used_percent: 1, provider: "agy", pool: "gemini", five_hour_disabled: "yes" }).ok, false);

  const g = validateReport({ email: "A@x.io", used_percent: 33, resets_at: null, provider: "agy", pool: "gemini" });
  assert.equal(g.report.email, "a@x.io");
  assert.equal(g.report.account_key, "a@x.io#gemini");

  // disabled: used_percent / resets_at are ignored (client sends the weekly % there)
  const d = validateReport({ email: "a@x.io", provider: "agy", pool: "gemini", five_hour_disabled: true, used_percent: 37, resets_at: "2026-10-28T10:00:00Z" });
  assert.equal(d.ok, true);
  assert.equal(d.report.five_hour_disabled, true);
  assert.equal(d.report.used, 100);
  assert.equal(d.report.resets_at, null);
  assert.equal(validateReport({ email: "a@x.io", provider: "agy", pool: "gemini", five_hour_disabled: true }).ok, true);
});

test("agy auth report without pool expands to every pool; with pool stays single", () => {
  const v = validateReport({ email: "a@x.io", provider: "agy", error_kind: "usage_timeout", error: "x" });
  assert.equal(v.ok, true);
  assert.equal(v.report.account_key, null);
  assert.deepEqual(expandReport(v.report).map((r) => r.account_key), ["a@x.io#gemini", "a@x.io#claude"]);
  const one = validateReport({ email: "a@x.io", provider: "agy", pool: "claude", error_kind: "usage_timeout" });
  assert.deepEqual(expandReport(one.report).map((r) => r.account_key), ["a@x.io#claude"]);
  const cl = validateReport({ email: "a@x.io", error_kind: "usage_timeout" });
  assert.deepEqual(expandReport(cl.report).map((r) => r.account_key), ["a@x.io"]);
});

test("same email in two agy pools keeps states, samples, windows and machines separate", () => {
  const store = emptyStore();
  postBody(store, agy("a@x.io", "gemini", 10, T0 + 4 * H), T0);
  postBody(store, agy("a@x.io", "claude", 60, T0 + 2 * H), T0 + M);
  postBody(store, agy("a@x.io", "gemini", 20, T0 + 4 * H), T0 + 30 * M);
  // claude pool: its window ends, a new one starts -> one closed window for that pool only
  const res = postBody(store, agy("a@x.io", "claude", 5, T0 + 7 * H), T0 + 3 * H);
  assert.deepEqual(Object.keys(store.states).sort(), ["a@x.io#claude", "a@x.io#gemini"]);
  assert.equal(store.samples.filter((p) => p.email === "a@x.io#gemini").length, 2);
  assert.deepEqual(store.windows.map((w) => w.email), ["a@x.io#claude"]);
  assert.equal(store.machines.length, 2);

  const snap = res.snapshot;
  assert.equal(snap.provider, "agy");
  assert.deepEqual(snap.pools.map((p) => p.id), ["gemini", "claude"]);
  assert.equal(snap.trigger_email, "a@x.io");
  assert.equal(snap.accounts.length, 2);
  for (const a of snap.accounts) {
    assert.equal(a.email, "a@x.io");
    assert.equal(a.account_key, `a@x.io#${a.pool}`);
    assert.ok(a.pool_label);
    assert.equal(a.machines.length, 1);
  }
  const g = snap.accounts.find((a) => a.pool === "gemini");
  assert.equal(g.used_percent, 20);
  assert.equal(g.history.length, 2);
  assert.equal(snap.by_pool.gemini.total_accounts, 1);
  assert.equal(snap.by_pool.claude.total_accounts, 1);
  assert.equal(snap.by_pool.claude.history_14d.windows.length, 1);
  assert.equal(snap.by_pool.gemini.history_14d.windows.length, 0);
  assert.equal(snap.by_pool.claude.history_14d.windows[0].account_key, "a@x.io#claude");
  assert.deepEqual(snap.by_pool.gemini.heatmap.accounts.map((x) => x.account_key), ["a@x.io#gemini"]);
});

test("will_exhaust alternative never comes from another pool", () => {
  const rows = [
    { email: "a@x.io", account_key: "a@x.io#claude", pool: "claude", state_code: "ACTIVE", used_percent: 80, free_now: 20,
      at_risk_waste: 0, resets_at: iso(T0 + 3 * H), exhaust_at: iso(T0 + H), confidence: "high", weekly_capped: false, stale: false },
    { email: "a@x.io", account_key: "a@x.io#gemini", pool: "gemini", state_code: "FRESH", used_percent: 0, free_now: 100,
      at_risk_waste: 0, resets_at: null, exhaust_at: null, weekly_capped: false, stale: false },
  ];
  let opp = computeOpportunity(rows, [], T0);
  assert.equal(opp.will_exhaust.length, 1);
  assert.equal(opp.will_exhaust[0].alternative, null);
  rows.push({ email: "b@x.io", account_key: "b@x.io#claude", pool: "claude", state_code: "FRESH", used_percent: 0, free_now: 100,
    at_risk_waste: 0, resets_at: null, exhaust_at: null, weekly_capped: false, stale: false });
  opp = computeOpportunity(rows, [], T0);
  assert.equal(opp.will_exhaust[0].alternative.account_key, "b@x.io#claude");
  assert.equal(opp.will_exhaust[0].alternative.email, "b@x.io");
  assert.equal(opp.will_exhaust[0].account_key, "a@x.io#claude");
});

test("5h disabled -> COOLDOWN weekly-capped until weekly reset, no sample, no idle gap; FRESH after reset", () => {
  const store = emptyStore();
  const wr = T0 + 2 * DAY_MS;
  postBody(store, agy("a@x.io", "gemini", 0, null), T0); // FRESH, idle from T0
  postBody(store, agy("a@x.io", "gemini", 30, T0 + 5 * H), T0 + 10 * M); // window starts at T0 (gap closes)
  const samplesBefore = store.samples.length;
  const res = postBody(store, agy("a@x.io", "gemini", 100, null, { five_hour_disabled: true, limits: weekly("gemini", 100, wr) }), T0 + H);
  assert.equal(store.samples.length, samplesBefore, "disabled report adds no sample");
  assert.equal(store.windows.length, 1, "open window closed at the disabled report");
  const row = res.snapshot.accounts[0];
  assert.equal(row.state_code, "COOLDOWN");
  assert.equal(row.five_hour_disabled, true);
  assert.equal(row.weekly_capped, true);
  assert.equal(row.free_now, 0);
  assert.equal(row.resets_at, iso(wr));
  assert.equal(row.weekly_resets_at, iso(wr));
  assert.equal(res.snapshot.by_pool.gemini.totals.capped_count, 1);
  assert.equal(res.snapshot.by_pool.gemini.totals.free_now_sum, 0);
  assert.equal(res.snapshot.by_pool.gemini.opportunity.fresh_now.length, 0);

  // a day later still disabled: no idle accrues in the heatmap
  const res2 = postBody(store, agy("a@x.io", "gemini", 100, null, { five_hour_disabled: true, limits: weekly("gemini", 100, wr) }), T0 + DAY_MS);
  const gapsBefore = store.gaps.length;
  assert.equal(res2.snapshot.accounts[0].idle_since, null);
  assert.equal(res2.snapshot.accounts[0].stats_14d.idle_hours, 0);

  // weekly reset passes while another pool reports: hard transition -> FRESH
  const res3 = postBody(store, agy("a@x.io", "claude", 10, wr + 4 * H), wr + H);
  const g = res3.snapshot.accounts.find((a) => a.pool === "gemini");
  assert.equal(g.state_code, "FRESH");
  assert.equal(g.five_hour_disabled, false);
  assert.equal(store.gaps.length, gapsBefore);

  // stays cleared on later hard transitions
  const st = applyHardTransitions(store.states["a@x.io#gemini"], wr + 2 * H).state;
  assert.equal(st.five_hour_disabled, false);
});

test("5h disabled then re-enabled by a normal report clears the flag", () => {
  const store = emptyStore();
  const wr = T0 + DAY_MS;
  postBody(store, agy("a@x.io", "gemini", 0, null, { five_hour_disabled: true, limits: weekly("gemini", 100, wr) }), T0);
  const res = postBody(store, agy("a@x.io", "gemini", 5, T0 + 5 * H, { limits: weekly("gemini", 96, wr) }), T0 + H);
  const row = res.snapshot.accounts[0];
  assert.equal(row.state_code, "ACTIVE");
  assert.equal(row.five_hour_disabled, false);
  assert.equal(store.states["a@x.io#gemini"].five_hour_disabled, false);
});

test("agy auth without pool marks both pools AUTH", () => {
  const store = emptyStore();
  const res = postBody(store, { email: "a@x.io", provider: "agy", error_kind: "auth_required", status: "auth_required", token_state: "auth_required" }, T0);
  assert.deepEqual(res.snapshot.accounts.map((a) => [a.account_key, a.state_code]).sort(),
    [["a@x.io#claude", "AUTH"], ["a@x.io#gemini", "AUTH"]]);
});

test("claude snapshot: rows stored without account_key get it from the state; pools empty", () => {
  const st = {
    email: "old@x.io", first_seen: T0, win: null, idle_from: null, last_valid_at: T0,
    row: { email: "old@x.io", state_code: "FRESH", free_now: 100, at_risk_waste: 0, weekly_capped: false, stale: false },
  };
  const snap = buildSnapshot({ states: [st], samples: [], windows: [], gaps: [] }, T0, "old@x.io", 3);
  assert.equal(snap.provider, "claude");
  assert.deepEqual(snap.pools, []);
  assert.deepEqual(snap.by_pool, {});
  assert.equal(snap.accounts[0].account_key, "old@x.io");
  assert.equal(snap.accounts[0].pool, null);
  assert.equal(snap.accounts[0].pool_label, null);
  assert.equal(snap.opportunity.fresh_now[0].account_key, "old@x.io");
});

test("emptySnapshot per provider", () => {
  assert.deepEqual(emptySnapshot().pools, []);
  const a = emptySnapshot("agy");
  assert.equal(a.provider, "agy");
  assert.deepEqual(Object.keys(a.by_pool), ["gemini", "claude"]);
  assert.equal(a.by_pool.gemini.total_accounts, 0);
  assert.deepEqual(a.providers.map((p) => p.id), ["claude", "agy", "codex"]);
});

test("codex: an unpooled provider with its own 5h quota and a weekly limit, like claude", () => {
  const codex = (extra = {}) => ({ email: "Dev@x.io", provider: "codex", used_percent: 49, resets_at: iso(T0 + 3 * H), machine_id: "m1", ...extra });
  assert.equal(validateReport(codex({ pool: "gemini" })).ok, false, "codex has no pools");
  const v = validateReport(codex({ limits: [{ kind: "weekly", group: "weekly", percent: 8, resets_at: iso(T0 + 5 * DAY_MS), is_active: true, scope_name: null }] }));
  assert.equal(v.ok, true, v.error);
  assert.equal(v.report.account_key, "dev@x.io");
  assert.equal(v.report.provider, "codex");

  const store = emptyStore();
  const res = postBody(store, codex({ limits: [{ kind: "weekly", group: "weekly", percent: 8, resets_at: iso(T0 + 5 * DAY_MS), is_active: true, scope_name: null }] }), T0);
  const snap = res.snapshot;
  assert.equal(snap.provider, "codex");
  assert.deepEqual(snap.pools, []);
  assert.equal(snap.accounts.length, 1);
  assert.equal(snap.accounts[0].used_percent, 49);
  assert.equal(snap.accounts[0].weekly_used, 8);
  assert.deepEqual(snap.providers.map((p) => p.id), ["claude", "agy", "codex"]);

  const err = validateReport({ email: "dev@x.io", provider: "codex", error_kind: "usage_timeout", error: "x" });
  assert.equal(err.ok, true);
  assert.equal(err.report.account_key, "dev@x.io", "an error report needs no pool for an unpooled provider");
  assert.equal(emptySnapshot("codex").provider, "codex");
});
