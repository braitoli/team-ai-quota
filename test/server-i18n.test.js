// The user-facing texts of src/analytics.js are translatable: each one is an English `field` plus
// `field_key` + `field_params` (see docs/api.md). These tests pin the contract.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  newState,
  computeRow,
  computeWeeklyRow,
  computeOpportunity,
  machinesForSnapshot,
  computeMachineStats,
  emptySnapshot,
  authLabel,
  formatHM,
  formatHMDM,
  formatDuration,
  HOUR_MS as H,
  MINUTE_MS as M,
  DAY_MS as D,
} from "../src/analytics.js";
import { TRANSLATIONS, renderKey, formatTemplate } from "../src/i18n.js";
import { renderDashboardPage } from "../src/dashboard.js";

const VI_DIACRITICS = /[àáảãạăằắẳẵặâầấẩẫậèéẻẽẹêềếểễệìíỉĩịòóỏõọôồốổỗộơờớởỡợùúủũụưừứửữựỳýỷỹỵđĐ]/;
const T0 = Date.parse("2026-10-27T10:00:00.000Z"); // 17:00 GMT+7
const FMT = { time: formatHM, datetime: formatHMDM, dur: formatDuration };
const iso = (ts) => new Date(ts).toISOString();

const st = (over) => ({ ...newState("a@x.io", T0), used: 0, last_report_at: T0, last_valid_at: T0, ...over });
const win = (used, resetsInMs, over = {}) => st({ used, resets_at: T0 + resetsInMs, ...over });
const wk = (percent, resetsInMs) => [{ kind: "seven_day", group: "weekly", percent, resets_at: T0 + resetsInMs, is_active: true }];
const baseRow = computeRow(win(78, 2.5 * H, { limits: null }), [], T0);
const weekly = (over) => computeWeeklyRow({ ...baseRow, ...over }, T0);
const orow = (email, over) => ({
  email, account_key: email, pool: null, state_code: "ACTIVE", weekly_capped: false, at_risk_waste: 40, at_risk_waste_min: 40,
  used_percent: 30, free_now: 70, resets_at: iso(T0 + 3 * H), exhaust_at: null, stale: false, uncertain: false, confidence: "medium",
  pacing_badge_text: "x", ...over,
});
const mach = (id, over = {}) => ({
  email: "m@x.io", machine_id: id, machine_name: null, os: "macOS", first_seen_ts: T0 - 5 * D, last_seen_ts: T0 - 2 * M, last_valid_ts: T0 - 2 * M,
  reports_ok: 1, reports_err: 0, last_error_kind: null, last_error_ts: null, client_version: "3.9", last_ip: null, country: null, last_used_percent: 1,
  update_status: null, update_checked_ts: null, ...over,
});
const stats = (over, now = T0) => computeMachineStats([mach("abc123456", over)], [], [], now, {})[0];

// <cases>
// [label, () => [object, field], the Vietnamese text this field had before it became translatable]
const CASES = [
  ["auth label (idle token)", () => [computeRow(st({ auth_state: "expired_idle", used: 42 }), [], T0), "auth_label"], "Token hết hạn do lâu không dùng (nhiều khả năng đang rảnh)"],
  ["auth badge", () => [computeRow(st({ auth_state: "auth_required", used: 42 }), [], T0), "pacing_badge_text"], "Cần đăng nhập"],
  ["auth prediction with last figure", () => [computeRow(st({ auth_state: "auth_required", used: 42 }), [], T0), "prediction_text"], "Cần đăng nhập lại · số cuối: 42%"],
  ["auth prediction without figure", () => [computeRow(st({ auth_state: "error", used: null }), [], T0), "prediction_text"], "Lỗi đọc quota từ máy khách — chưa rõ hạn mức · số cuối: chưa có"],
  ["5h disabled until weekly reset", () => [computeRow(st({ five_hour_disabled: true, disabled_until: T0 + 3 * H }), [], T0), "prediction_text"], "Chạm trần tuần · hạn mức 5h tạm khóa, mở lại lúc 20:00 27/10 (còn 3h 0m)"],
  ["5h disabled, no end known", () => [computeRow(st({ five_hour_disabled: true, disabled_until: null }), [], T0), "prediction_text"], "Chạm trần tuần · hạn mức 5h tạm khóa tới khi quota tuần hồi phục"],
  ["fresh: resets_in", () => [computeRow(st({ resets_at: null }), [], T0), "resets_in"], "Sẵn sàng"],
  ["fresh: prediction", () => [computeRow(st({ resets_at: null }), [], T0), "prediction_text"], "Sẵn sàng 100% · chu kỳ 5h chỉ bắt đầu khi dùng"],
  ["cooldown prediction", () => [computeRow(win(100, 90 * M), [], T0), "prediction_text"], "Chạm trần 100% · hồi phục lúc 18:30 (còn 1h 30m)"],
  ["will exhaust", () => [computeRow(win(80, 4 * H), [], T0), "prediction_text"], "Cạn lúc 17:15, trước reset 3h 45m"],
  ["projection at reset", () => [computeRow(win(10, 1 * H), [], T0), "prediction_text"], "Dự kiến ~12.5% lúc reset 18:00 · ~87.5% sẽ mất nếu không dùng"],
  ["no report for 75 min", () => [computeRow(win(33, 2 * H, { last_report_at: T0 - 3 * H, last_valid_at: T0 - 3 * H }), [], T0), "prediction_text"], "Không có báo cáo > 75 phút · giả định không dùng thêm, ~67% sẽ mất lúc 19:00"],
  ["pacing badge (danger)", () => [computeRow(win(80, 4 * H), [], T0), "pacing_badge_text"], "Sắp cạn"],
  ["weekly: no weekly figure", () => [weekly({ weekly_used: null }), "prediction_text"], "Client chưa báo quota tuần · đang hiện số của chu kỳ 5h, chưa có dự báo"],
  ["weekly: capped", () => [weekly({ weekly_used: 96, weekly_resets_at: iso(T0 + 2 * D) }), "prediction_text"], "Chạm trần tuần 96% · hồi phục lúc 17:00 29/10 (còn 48h 0m)"],
  ["weekly: will exhaust", () => [weekly({ weekly_used: 90, weekly_resets_at: iso(T0 + 6 * D) }), "prediction_text"], "Cạn lúc 19:40 27/10, trước reset 141h 20m"],
  ["weekly: ready (reset passed)", () => [weekly({ weekly_used: 50, weekly_resets_at: iso(T0 - H) }), "pacing_badge_text"], "Sẵn sàng 100%"],
  ["opportunity: waste", () => [computeOpportunity([orow("w@x.io", {})], [], T0).use_before_reset[0], "text"], "~40% sẽ mất lúc 20:00 (còn 3h 0m) — cần đốt ~23.3%/h để dùng hết"],
  ["opportunity: uncertain waste", () => [computeOpportunity([orow("w@x.io", { uncertain: true, at_risk_waste_min: 12, at_risk_waste: 55 })], [], T0).use_before_reset[0], "text"], "Có thể thừa 12–55% lúc 20:00 (còn 3h 0m) · chưa chắc, dữ liệu còn mỏng"],
  ["opportunity: ready, idle since", () => [computeOpportunity([orow("f@x.io", { state_code: "FRESH", resets_at: null })], [{ email: "f@x.io", win: null, idle_from: T0 - 5 * H }], T0).fresh_now[0], "text"], "Sẵn sàng 100% · rảnh từ 12:00 27/10 (~5h 0m)"],
  ["opportunity: exhaust with alternative", () => [computeOpportunity([orow("x@x.io", { exhaust_at: iso(T0 + H), free_now: 20 }), orow("y@x.io", { state_code: "FRESH", resets_at: null, free_now: 100 })], [], T0).will_exhaust[0], "text"], "Cạn lúc 18:00, trước reset 2h 0m → chuyển sang y@x.io (100% trống)"],
  ["opportunity: already exhausted, no alternative", () => [computeOpportunity([orow("x@x.io", { exhaust_at: iso(T0 - 10 * M) })], [], T0).will_exhaust[0], "text"], "Có thể đã cạn lúc 16:50, reset lúc 20:00"],
  ["others: no action + signal lost", () => [computeOpportunity([orow("n@x.io", { at_risk_waste: 3, free_now: 44, stale: true })], [], T0).others[0], "text"], "Chưa cần chuyển việc · 44% trống, reset 20:00 (còn 3h 0m) · mất tín hiệu"],
  ["others: weekly cap", () => [computeOpportunity([orow("c@x.io", { state_code: "COOLDOWN", weekly_capped: true, free_now: 0, resets_at: iso(T0 + 30 * H) })], [], T0).others[0], "text"], "Chạm trần tuần · mở lại lúc 23:00 28/10 (còn 30h 0m)"],
  ["others: cooldown", () => [computeOpportunity([orow("c@x.io", { state_code: "COOLDOWN", free_now: 0, resets_at: iso(T0 + 100 * M) })], [], T0).others[0], "text"], "Hết quota 5h · mở lại lúc 18:40 (còn 1h 40m)"],
  ["others: unreadable", () => [computeOpportunity([orow("u@x.io", { state_code: "AUTH", free_now: null, pacing_badge_text: "Login required", pacing_badge_text_key: "srv_badge_login" })], [], T0).others[0], "text"], "Chưa đo được · Cần đăng nhập"],
  ["heatmap unit", () => [emptySnapshot("claude").heatmap, "unit"], "% của một chu kỳ 5h, trung bình mỗi ngày"],
  ["machine without name or id", () => [machinesForSnapshot([mach("unknown")], T0).active["m@x.io"][0], "name"], "máy chưa rõ (client cũ)"],
  ["machine named after its id", () => [machinesForSnapshot([mach("abcdef123456")], T0).active["m@x.io"][0], "name"], "máy abcdef"],
  ["machine intensity: high", () => [stats({ telemetry: { tokens_1h: 4_000_000, msgs_1h: 1 } }), "intensity_label"], "Cường độ cao"],
  ["machine intensity: running", () => [stats({ telemetry: { tokens_1h: 10, msgs_1h: 1 } }), "intensity_label"], "Đang chạy"],
  ["machine intensity: waiting", () => [stats({ telemetry: { tokens_1h: 0, msgs_1h: 0 } }), "intensity_label"], "Chờ lệnh"],
  ["machine intensity: no data", () => [stats({}), "intensity_label"], "Chưa đủ dữ liệu"],
  ["machine intensity: resting", () => [stats({ last_seen_ts: T0 - 60 * M }), "intensity_label"], "Tạm nghỉ"],
  ["machine intensity: offline", () => [stats({ last_seen_ts: T0 - 5 * H }), "intensity_label"], "Ngoại tuyến"],
];
// </cases>

test("every text renders in Vietnamese exactly as it did before (key + params -> vi), and in English as sent", () => {
  assert.ok(CASES.length >= 8);
  for (const [label, run, vi] of CASES) {
    const [obj, field] = run();
    assert.ok(obj[field + "_key"], label + ": has " + field + "_key");
    assert.ok(obj[field + "_params"] && typeof obj[field + "_params"] === "object", label + ": has " + field + "_params");
    assert.equal(renderKey(obj[field + "_key"], obj[field + "_params"], "vi", FMT), vi, label + " (vi)");
    assert.equal(renderKey(obj[field + "_key"], obj[field + "_params"], "en", FMT), obj[field], label + " (en == plain field)");
    assert.ok(!VI_DIACRITICS.test(obj[field]), label + ": plain field is English: " + obj[field]);
    assert.doesNotThrow(() => JSON.stringify(obj[field + "_params"]), label + ": params are plain data");
  }
});

test("a language without the key falls back to English", () => {
  assert.equal(renderKey("srv_badge_ready", {}, "de", FMT), "Ready 100%");
  assert.equal(renderKey("srv_pred_cap", { at: T0, left: 90 * M }, "ja", FMT), "Capped 100% · recovers at 17:00 (1h 30m left)");
});

test("auth_warning label carries its key", () => {
  const row = computeRow(st({ auth_warning: { state: "auth_required", at: T0 - H, error: "x" } }), [], T0);
  const w = row.auth_warning;
  assert.equal(w.label, authLabel("auth_required"));
  assert.equal(w.label_key, "srv_auth_required");
  assert.deepEqual(w.label_params, {});
});

// ---------- dictionary consistency ----------
const placeholderNames = (s) => [...String(s).matchAll(/\{([A-Za-z0-9_]+)(?::([a-z]+))?\}/g)].map((m) => m[1]).sort().join(",");
const placeholderKinds = (s) => [...String(s).matchAll(/\{([A-Za-z0-9_]+)(?::([a-z]+))?\}/g)].map((m) => m[1] + ":" + (m[2] || "")).sort().join(",");
const srvKeys = Object.keys(TRANSLATIONS.en).filter((k) => k.startsWith("srv_"));

test("every srv_* key exists in en and vi with the same placeholders; en has no Vietnamese", () => {
  assert.ok(srvKeys.length >= 50);
  for (const k of srvKeys) {
    assert.equal(typeof TRANSLATIONS.vi[k], "string", "vi defines " + k);
    assert.equal(placeholderKinds(TRANSLATIONS.en[k]), placeholderKinds(TRANSLATIONS.vi[k]), "placeholders (and kinds) of " + k + " match in en and vi");
    assert.ok(!VI_DIACRITICS.test(TRANSLATIONS.en[k]), "en value of " + k + " has Vietnamese: " + TRANSLATIONS.en[k]);
    for (const m of TRANSLATIONS.en[k].matchAll(/\{[A-Za-z0-9_]+:([a-z]+)\}/g)) assert.ok(["time", "datetime", "dur", "key"].includes(m[1]), k + ": known placeholder kind " + m[1]);
  }
});

test("every srv_* key the server code names is defined in en and vi", () => {
  for (const file of ["../src/analytics.js", "../src/index.js"]) {
    const src = readFileSync(new URL(file, import.meta.url), "utf8");
    const used = new Set([...src.matchAll(/"(srv_[a-z0-9_]+)"/g)].map((m) => m[1]));
    assert.ok(used.size > 0 || file.endsWith("index.js"));
    for (const k of used) {
      assert.ok(TRANSLATIONS.en[k] != null, file + " uses " + k + ": en defines it");
      assert.ok(TRANSLATIONS.vi[k] != null, file + " uses " + k + ": vi defines it");
    }
  }
});

test("emitted params cover the placeholders of their key; every emitted key is defined", () => {
  const seen = new Set();
  const walk = (x) => {
    if (Array.isArray(x)) return x.forEach(walk);
    if (!x || typeof x !== "object") return;
    for (const k of Object.keys(x)) {
      if (k.endsWith("_key") && typeof x[k] === "string" && x[k].startsWith("srv_") && (k.slice(0, -4) + "_params") in x) {
        const key = x[k];
        const params = x[k.slice(0, -4) + "_params"];
        seen.add(key);
        assert.ok(TRANSLATIONS.en[key] != null && TRANSLATIONS.vi[key] != null, key + " defined in en and vi");
        for (const n of placeholderNames(TRANSLATIONS.en[key]).split(",").filter(Boolean)) {
          assert.ok(Object.prototype.hasOwnProperty.call(params, n), key + " params has " + n);
        }
        for (const m of TRANSLATIONS.en[key].matchAll(/\{([A-Za-z0-9_]+):(time|datetime|dur)\}/g)) {
          assert.ok(params[m[1]] === null || Number.isFinite(params[m[1]]), key + "." + m[1] + " is epoch ms / ms (number)");
        }
      }
      walk(x[k]);
    }
  };
  for (const [, run] of CASES) walk(run()[0]);
  assert.ok(seen.size >= 30, "cases exercise many keys (" + seen.size + ")");
});

test("formatTemplate: plain, formatted and key placeholders; unknown ones stay as written", () => {
  const lookup = (k) => ({ k1: "ONE" })[k] || k;
  assert.equal(formatTemplate("{a}% at {t:time} ({d:dur}){s:key}", { a: 5, t: T0, d: 90 * M, s: null }, FMT, lookup), "5% at 17:00 (1h 30m)");
  assert.equal(formatTemplate("x{s:key}", { s: "k1" }, FMT, lookup), "xONE");
  assert.equal(formatTemplate("{a} {missing} {t:nope}", { a: 1, t: 2 }, FMT, lookup), "1 {missing} 2");
  assert.equal(formatTemplate("{a}", undefined, FMT, lookup), "{a}");
});

// ---------- no Vietnamese left in the server code ----------
test("src/analytics.js and src/index.js have no Vietnamese literals outside comments", () => {
  for (const file of ["../src/analytics.js", "../src/index.js"]) {
    const src = readFileSync(new URL(file, import.meta.url), "utf8");
    const code = src.replace(/\/\*[\s\S]*?\*\//g, "").split("\n").filter((l) => !/^\s*\/\//.test(l)).map((l) => l.replace(/\s\/\/ .*$/, "")).join("\n");
    assert.deepEqual(code.split("\n").filter((l) => VI_DIACRITICS.test(l)), [], file);
  }
});

// ---------- dashboard client ----------
test("the page inlines formatTemplate and shows every keyed server text through sv()", () => {
  const html = renderDashboardPage(JSON.stringify(emptySnapshot("claude")), "k");
  assert.ok(html.includes("var formatTemplate = (function formatTemplate("), "formatTemplate is inlined before the app");
  const src = readFileSync(new URL("../src/dashboard.js", import.meta.url), "utf8");
  for (const field of ["auth_label", "pacing_badge_text", "intensity_label", "label"]) {
    assert.ok(src.includes(`sv(`) && new RegExp(`sv\\(\\w+, "${field}"\\)`).test(src), "client renders " + field + " with sv()");
  }
  assert.ok(src.includes('m.name_key ? sv(m, "name")'), "machine placeholders are translated, client-sent names are not");
  assert.ok(!/r\.auth_label\b|m\.intensity_label\b/.test(src.replace(/\/\/.*$/gm, "")), "no direct read of a keyed field left");
});
