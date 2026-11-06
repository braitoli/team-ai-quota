import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CLI_PROVIDERS,
  DEFAULT_MACHINE_LABELS,
  buildDefaultSettings,
  validateSettingsPatch,
  mergeSettings,
  resolveMachineLabel,
  resolveAccountLabel,
  parseLabelEnv,
} from "../src/config.js";
import {
  validateReport,
  processReport,
  buildSnapshot,
  emptySnapshot,
  computeWeeklyRow,
  applyHardTransitions,
  rankAccountsForRouting,
  HOUR_MS,
  DAY_MS,
} from "../src/analytics.js";

const T0 = Date.parse("2026-11-06T10:00:00.000Z");
const H = HOUR_MS;
const D = DAY_MS;
const iso = (ts) => new Date(ts).toISOString();

function emptyStore() {
  return { states: {}, samples: [], windows: [], gaps: [], machines: [] };
}

test("config: CLI_PROVIDERS specifications", () => {
  assert.equal(CLI_PROVIDERS.claude.id, "claude");
  assert.equal(CLI_PROVIDERS.claude.cli, "claude");
  assert.deepEqual(CLI_PROVIDERS.claude.default_windows, ["7d", "5h"]);
  assert.equal(CLI_PROVIDERS.claude.default_enabled, true);

  assert.equal(CLI_PROVIDERS.codex.id, "codex");
  assert.equal(CLI_PROVIDERS.codex.cli, "codex");

  assert.equal(CLI_PROVIDERS.agy.id, "agy");
  assert.equal(CLI_PROVIDERS.agy.pooled, true);

  assert.equal(CLI_PROVIDERS.gemini.id, "gemini");
  assert.equal(CLI_PROVIDERS.copilot.has_monthly, true);
  assert.deepEqual(CLI_PROVIDERS.copilot.default_windows, ["30d", "7d", "5h"]);
  assert.equal(CLI_PROVIDERS.cursor.has_monthly, true);
});

test("config: no machine names are built in; labels come only from configuration", () => {
  assert.deepEqual(DEFAULT_MACHINE_LABELS, {});
  assert.deepEqual(buildDefaultSettings().machine_labels, {});
});

test("config: parseLabelEnv handles JSON and comma-separated formats", () => {
  assert.deepEqual(parseLabelEnv('{"m1":"Alpha","m2":"Beta"}'), { m1: "Alpha", m2: "Beta" });
  assert.deepEqual(parseLabelEnv("m1:Alpha,m2:Beta"), { m1: "Alpha", m2: "Beta" });
  assert.deepEqual(parseLabelEnv(""), {});
  assert.deepEqual(parseLabelEnv(null), {});
  assert.deepEqual(parseLabelEnv("{invalid"), {});
});

test("config: buildDefaultSettings with env overrides and provider toggling", () => {
  const def = buildDefaultSettings();
  assert.equal(def.priority_mode, "7d_first");
  assert.equal(def.providers.claude.enabled, true);
  assert.equal(def.providers.codex.enabled, true);
  assert.equal(def.providers.agy.enabled, true);
  assert.equal(def.providers.gemini.enabled, false);
  assert.equal(def.providers.copilot.enabled, false);
  assert.equal(def.providers.cursor.enabled, false);
  assert.deepEqual(def.machine_labels, {});

  const custom = buildDefaultSettings({
    MACHINE_LABELS: "abc123:CustomBox",
    ACCOUNT_LABELS: '{"boss@x.io":"Boss"}',
    ENABLED_PROVIDERS: "claude,gemini,cursor",
  });
  assert.equal(custom.machine_labels["abc123"], "CustomBox");
  assert.deepEqual(custom.machine_labels, { abc123: "CustomBox" });
  assert.equal(custom.account_labels["boss@x.io"], "Boss");
  assert.equal(custom.providers.claude.enabled, true);
  assert.equal(custom.providers.gemini.enabled, true);
  assert.equal(custom.providers.cursor.enabled, true);
  assert.equal(custom.providers.codex.enabled, false);
});

test("config: validateSettingsPatch and mergeSettings", () => {
  assert.equal(validateSettingsPatch(null).ok, false);
  assert.equal(validateSettingsPatch("invalid").ok, false);
  assert.equal(validateSettingsPatch({ priority_mode: "invalid_mode" }).ok, false);
  assert.equal(validateSettingsPatch({ priority_mode: "5h_first" }).ok, true);

  assert.equal(validateSettingsPatch({ machine_labels: "not-an-obj" }).ok, false);
  assert.equal(validateSettingsPatch({ machine_labels: { m1: 123 } }).ok, false);
  assert.equal(validateSettingsPatch({ machine_labels: { m1: "Friendly" } }).ok, true);

  assert.equal(validateSettingsPatch({ providers: { gemini: { enabled: "yes" } } }).ok, false);
  assert.equal(validateSettingsPatch({ providers: { gemini: { enabled: true } } }).ok, true);

  const base = buildDefaultSettings();
  const merged = mergeSettings(base, {
    priority_mode: "monthly_first",
    machine_labels: { custom99: "SpecialServer" },
    account_labels: { "team@x.io": "TeamShared" },
    providers: {
      gemini: { enabled: true },
    },
  });
  assert.equal(merged.priority_mode, "monthly_first");
  assert.equal(merged.machine_labels.custom99, "SpecialServer");
  assert.equal(merged.account_labels["team@x.io"], "TeamShared");
  assert.equal(merged.providers.gemini.enabled, true);
  assert.equal(merged.providers.claude.enabled, true);
});

test("config: resolveMachineLabel & resolveAccountLabel", () => {
  const labels = { "a1b2c3": "DevA", "d4e5f6": "DevB", buildbox: "BuildBox" };
  assert.equal(resolveMachineLabel({ machine_id: "a1b2c3739c07" }, labels), "DevA");
  assert.equal(resolveMachineLabel({ id_short: "#d4e5f6" }, labels), "DevB");
  assert.equal(resolveMachineLabel({ machine_name: "buildbox-1" }, labels), "BuildBox");
  assert.equal(resolveMachineLabel({ machine_id: "a1b2c3739c07", machine_name: "Mac" }), "Mac");
  assert.equal(resolveMachineLabel({ machine_id: "unknown-box", machine_name: "MyMac" }), "MyMac");
  assert.equal(resolveMachineLabel({ machine_id: "custom99" }, { custom99: "MyCustomNode" }), "MyCustomNode");

  assert.equal(resolveAccountLabel("Dev@x.io", { "dev@x.io": "LeadDev" }), "LeadDev");
  assert.equal(resolveAccountLabel("other@x.io", { "dev@x.io": "LeadDev" }), null);
});

test("validation: monthly quota fields and labels in validateReport", () => {
  const v = validateReport({
    email: "dev@x.io",
    used_percent: 25,
    resets_at: iso(T0 + 4 * H),
    monthly_used_percent: 60,
    monthly_resets_at: iso(T0 + 20 * D),
    monthly_quota_limit: 1000,
    monthly_quota_used: 600,
    machine_label: "DevMacBook",
    account_label: "TeamDev",
  });
  assert.equal(v.ok, true, v.error);
  assert.equal(v.report.monthly_used_percent, 60);
  assert.equal(v.report.monthly_quota_limit, 1000);
  assert.equal(v.report.monthly_quota_used, 600);
  assert.equal(v.report.machine_label, "DevMacBook");
  assert.equal(v.report.account_label, "TeamDev");

  // Rejections for invalid monthly data
  assert.equal(validateReport({ email: "a@x.io", used_percent: 1, monthly_used_percent: "bad" }).ok, false);
  assert.equal(validateReport({ email: "a@x.io", used_percent: 1, monthly_resets_at: "not-a-date" }).ok, false);
  assert.equal(validateReport({ email: "a@x.io", used_percent: 1, monthly_quota_limit: -5 }).ok, false);
});

test("weekly reset passed on offline/stale account: automatically clears weekly_capped and recovers to FRESH 100%", () => {
  const store = emptyStore();
  const wr = T0 + 2 * D;

  // Account hits 100% weekly limit (weekly capped / cooldown)
  const rep = {
    email: "offline@x.io",
    used_percent: 100,
    resets_at: iso(T0 + 4 * H),
    limits: [{ group: "weekly", percent: 100, is_active: true, resets_at: iso(wr) }],
    machine_id: "m-old",
  };
  const v = validateReport(rep);
  const res1 = processReport(store, v.report, T0, 1);
  for (const st of res1.writes.states) store.states[st.email] = st;
  store.samples.push(...res1.writes.samples);

  const rowBefore = res1.snapshot.accounts.find((a) => a.email === "offline@x.io");
  assert.equal(rowBefore.weekly_capped, true);
  assert.equal(rowBefore.free_now, 0);

  // 3 days later: now > wr, the machine has NOT reported since
  const nowAfterReset = wr + 24 * H;
  const res2 = processReport(store, validateReport({ email: "active@x.io", used_percent: 10, resets_at: iso(nowAfterReset + 4 * H) }).report, nowAfterReset, 2);

  const rowAfter = res2.snapshot.accounts.find((a) => a.email === "offline@x.io");
  assert.equal(rowAfter.weekly_capped, false, "weekly_capped must be cleared");
  assert.equal(rowAfter.state_code, "FRESH", "state must transition to FRESH");
  assert.equal(rowAfter.free_now, 100, "free_now must be 100%");
  assert.equal(rowAfter.used_percent, 0, "used_percent must be 0%");
  assert.equal(rowAfter.reset_passed_unverified, true, "unverified reset flag set");

  // computeWeeklyRow overlay merged on rowAfter also yields FRESH 100%
  const mergedWeekly = { ...rowAfter, ...computeWeeklyRow(rowAfter, nowAfterReset) };
  assert.equal(mergedWeekly.state_code, "FRESH");
  assert.equal(mergedWeekly.free_now, 100);
});

test("Smart Routing: rankAccountsForRouting ranks ready accounts prioritizing 7d headroom", () => {
  const snapshot = {
    provider: "claude",
    accounts: [
      // Account 1: AUTH (ineligible)
      { email: "auth@x.io", account_key: "auth@x.io", state_code: "AUTH", free_now: 0 },
      // Account 2: Weekly capped (ineligible)
      { email: "capped@x.io", account_key: "capped@x.io", state_code: "COOLDOWN", weekly_capped: true, free_now: 0 },
      // Account 3: Ready, high 7d utilization (70% used), low 5h utilization (10% used)
      { email: "high7d@x.io", account_key: "high7d@x.io", state_code: "ACTIVE", weekly_capped: false, weekly_used: 70, used_percent: 10, free_now: 90, weekly_resets_at: iso(T0 + 3 * D) },
      // Account 4: Ready, low 7d utilization (20% used), medium 5h utilization (30% used)
      { email: "low7d@x.io", account_key: "low7d@x.io", state_code: "ACTIVE", weekly_capped: false, weekly_used: 20, used_percent: 30, free_now: 70, weekly_resets_at: iso(T0 + 4 * D) },
      // Account 5: Fresh account (0% used)
      { email: "fresh@x.io", account_key: "fresh@x.io", state_code: "FRESH", weekly_capped: false, weekly_used: 0, used_percent: 0, free_now: 100 },
    ],
  };

  const route7d = rankAccountsForRouting(snapshot, { priority_mode: "7d_first" });
  assert.equal(route7d.total_eligible, 3);
  assert.equal(route7d.recommended.email, "fresh@x.io", "Fresh account with 0% score ranked #1");

  // Between low7d and high7d:
  // low7d:  0.45*20 + 0.35*30 + 0.20*0 = 9 + 10.5 = 19.5
  // high7d: 0.45*70 + 0.35*10 + 0.20*60*1 = 31.5 + 3.5 + 12 = 47
  // low7d must rank better than high7d!
  assert.equal(route7d.alternatives[0].email, "low7d@x.io");
  assert.equal(route7d.alternatives[1].email, "high7d@x.io");
});

test("Smart Routing: priority_mode monthly_first accounts for monthly usage", () => {
  const snapshot = {
    provider: "copilot",
    accounts: [
      { email: "heavy_month@x.io", account_key: "heavy_month@x.io", state_code: "ACTIVE", free_now: 80, used_percent: 20, weekly_used: 20, monthly_used_percent: 90 },
      { email: "light_month@x.io", account_key: "light_month@x.io", state_code: "ACTIVE", free_now: 60, used_percent: 40, weekly_used: 30, monthly_used_percent: 10 },
    ],
  };

  const routeMonthly = rankAccountsForRouting(snapshot, {
    provider: "copilot",
    priority_mode: "monthly_first",
    settings: {
      providers: { copilot: { has_monthly: true } },
    },
  });
  assert.equal(routeMonthly.recommended.email, "light_month@x.io");
});

test("emptySnapshot and buildSnapshot include settings root", () => {
  const empty = emptySnapshot("claude");
  assert.ok(empty.settings);
  assert.ok(empty.settings.providers.claude);
  assert.ok(empty.settings.machine_labels);

  const customSettings = buildDefaultSettings({ MACHINE_LABELS: "cust1:TestDevice" });
  const customSnap = emptySnapshot("claude", customSettings);
  assert.equal(customSnap.settings.machine_labels.cust1, "TestDevice");
});

test("Settings & Routing validation: Zero-Fallback policy rejects bad inputs and merges cleanly", () => {
  // Bad JSON or invalid patches
  assert.equal(validateSettingsPatch(null).ok, false);
  assert.equal(validateSettingsPatch(undefined).ok, false);
  assert.equal(validateSettingsPatch([]).ok, false);
  assert.equal(validateSettingsPatch({ priority_mode: "invalid_mode" }).ok, false);
  assert.equal(validateSettingsPatch({ machine_labels: { dev: 123 } }).ok, false);
  assert.equal(validateSettingsPatch({ account_labels: { dev: false } }).ok, false);
  assert.equal(validateSettingsPatch({ providers: { gemini: { enabled: "yes" } } }).ok, false);

  // Valid settings patch merging
  const current = buildDefaultSettings();
  const validPatch = {
    priority_mode: "5h_first",
    machine_labels: { devbox1: "AliceMBP" },
    account_labels: { "alice@x.io": "Alice" },
    providers: { gemini: { enabled: true } },
  };
  const validation = validateSettingsPatch(validPatch);
  assert.equal(validation.ok, true);
  const updated = mergeSettings(current, validation.patch);
  assert.equal(updated.priority_mode, "5h_first");
  assert.equal(updated.machine_labels.devbox1, "AliceMBP");
  assert.equal(updated.account_labels["alice@x.io"], "Alice");
  assert.equal(updated.providers.gemini.enabled, true);

  // Labels convenience patch
  const labelsPatch = {
    machine_labels: { box2: "BobMBP" },
    account_labels: { "bob@x.io": "Bob" },
  };
  assert.equal(validateSettingsPatch(labelsPatch).ok, true);
  const withLabels = mergeSettings(updated, labelsPatch);
  assert.equal(withLabels.machine_labels.box2, "BobMBP");
  assert.equal(withLabels.account_labels["bob@x.io"], "Bob");

  // Routing recommendation with updated settings
  const snap = emptySnapshot("claude", withLabels);
  snap.accounts = [
    { email: "alice@x.io", account_key: "alice@x.io", state_code: "ACTIVE", free_now: 80, used_percent: 20, weekly_used: 10 },
    { email: "bob@x.io", account_key: "bob@x.io", state_code: "ACTIVE", free_now: 50, used_percent: 50, weekly_used: 5 },
  ];
  const route = rankAccountsForRouting(snap, { provider: "claude", settings: withLabels });
  assert.equal(route.provider, "claude");
  assert.ok(route.recommended);
  assert.equal(route.total_eligible, 2);
});
