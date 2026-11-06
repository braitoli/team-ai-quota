import test from "node:test";
import assert from "node:assert/strict";
import { renderDashboardPage, renderRestrictedPage } from "../src/dashboard.js";

test("renderRestrictedPage returns valid auth shell", () => {
  const html = renderRestrictedPage(false);
  assert.ok(html.includes("Claude Quota"));
  assert.ok(html.includes("accessKey"));
  assert.ok(!html.includes("Secret Key không đúng"));

  const htmlErr = renderRestrictedPage(true);
  assert.ok(htmlErr.includes("Secret Key không đúng"));
});

test("renderDashboardPage includes subviews, model filter, and machine analytics sections", () => {
  const mockSnapshot = {
    version: 1,
    provider: "agy",
    total_accounts: 2,
    machine_stats: [
      {
        machine_id: "a1b2c3abcd",
        friendly_label: "DevA",
        os: "darwin",
        connectivity: "online",
        active_account: "admin@example.com",
        burn_rate: 8.5,
        telemetry: { total_tokens: 50000, input_tokens: 35000, output_tokens: 15000 }
      }
    ],
    accounts: []
  };

  const html = renderDashboardPage(JSON.stringify(mockSnapshot), "test-secret-key");

  assert.ok(!html.includes('id="agySubviews"'), "5h/7d switch is gone: both are always shown");
  // Model family filter
  assert.ok(html.includes('id="poolBar"'), "pools are tabs (one pool at a time), not a model filter");
  assert.ok(!html.includes('id="modelFilter"'), "model filter dropdown is gone");

  // Machine analytics sections
  assert.ok(html.includes('id="machStatsNow"'), "Must include machStatsNow panel");
  assert.ok(html.includes('id="machStatsHist"'), "Must include machStatsHist panel");
  assert.ok(html.includes('data-i18n="sec_mach_stats"'), "Must include machine analytics title");

  // Embedded snapshot data
  assert.ok(html.includes("DevA"), "Must include friendly machine label in embedded data");
});

test("account cards and the ranked list come first and show both quotas", () => {
  const html = renderDashboardPage(JSON.stringify({ version: 1, provider: "claude", accounts: [] }), "k");
  const i = (id) => html.indexOf(`id="${id}"`);
  assert.ok(i("cards") > 0 && i("cards") < i("hero") && i("hero") < i("nowKpis"), "cards, then hero, then KPIs");
  assert.ok(html.includes("function wkRow("), "7d row helper must exist");
  assert.ok(html.includes("function decide("), "combined 5h+7d ranking must exist");
  assert.ok(!html.includes("data-sview"), "no 5h/7d switch");
});

test("one view: no tabs, history is a collapsible block, weekly KPIs shown", () => {
  const html = renderDashboardPage(JSON.stringify({ version: 1, provider: "claude", accounts: [] }), "k");
  assert.ok(!html.includes('id="tab-now"') && !html.includes('id="tab-hist"'), "no Bây giờ / Lịch sử tabs");
  assert.ok(html.includes('id="histFold"'), "history lives in a collapsible block");
  assert.ok(html.includes("kpi-7"), "KPI cards carry a 7-day line");
});

test("history has a weekly quota section fed by history_weekly", () => {
  const html = renderDashboardPage(JSON.stringify({ version: 1, provider: "claude", accounts: [], history_weekly: { weeks: [] } }), "k");
  assert.ok(html.includes('id="weekHist"'), "weekly history panel");
  assert.ok(html.includes("function renderWeekHist("), "weekly history renderer");
});

test("7d quota section is displayed on the left and 5h on the right with pulse animation on 7d speed warning/hot", () => {
  const html = renderDashboardPage(JSON.stringify({ version: 1, provider: "claude", accounts: [] }), "k");
  assert.ok(html.includes('<div class="dual">\' + wkCol + cardCol("⏱ 5h"'), "cards render 7d (wkCol) before 5h");
  assert.ok(html.includes('<div class="dual">\' + w7 + winBlock("⏱ 5h"'), "hero renders 7d (w7) before 5h");
  assert.ok(html.includes("rate-pulse"), "rate-pulse CSS class and animation defined");
  assert.ok(html.includes("@keyframes ratePulse"), "keyframes for subtle pulse defined");
});

test("decide() prioritizes 7d over 5h, safely falls back when w is null, and orders 7d reasons first", () => {
  const html = renderDashboardPage(JSON.stringify({ version: 1, provider: "claude", accounts: [] }), "k");

  // Formula checks: 7d weight > 5h weight
  assert.ok(html.includes("0.45 * U7 + 0.35 * U5"), "decide formula must assign primary weight 0.45 to U7 and 0.35 to U5");
  assert.ok(html.includes("0.8 * U5 + 0.2 * H5"), "decide formula must safely fallback to 5h when w is null or f7 is null");

  // Reasons order checks: 7d reasons pushed before 5h reasons
  const idxWkWarn = html.indexOf('d.reasons.push(t("c_wk_low"');
  const idxWkWaste = html.indexOf('d.reasons.push(t("c_wk_waste"');
  const idxWkFresh = html.indexOf('d.reasons.push(t("c_wk_unopened_full"))');
  const idx5hWaste = html.indexOf('d.reasons.push(t("c_5h_waste"');
  const idx5hFresh = html.indexOf('d.reasons.push(t("c_5h_unopened_full"))');

  assert.ok(idxWkWarn > 0, "weekly warning reason exists");
  assert.ok(idxWkWaste > 0, "weekly waste reason exists");
  assert.ok(idxWkFresh > 0, "weekly fresh reason exists");
  assert.ok(idx5hWaste > 0, "5h waste reason exists");
  assert.ok(idx5hFresh > 0, "5h fresh reason exists");

  assert.ok(idxWkWarn < idx5hWaste, "7d warning reason comes before 5h waste");
  assert.ok(idxWkWaste < idx5hWaste, "7d waste reason comes before 5h waste");
  assert.ok(idxWkFresh < idx5hFresh, "7d fresh reason comes before 5h fresh");

  // Hero switch alternative format: 7d before 5h
  assert.ok(
    html.includes('pct(alt.f7)) + " " + t("label_7d") + " · " + pct(alt.f5) + " 5h)</span>"'),
    "hero switch suggestion must format 7d before 5h"
  );
});

test("settings modal button and dialog are rendered with providers, windows and labeling controls", () => {
  const html = renderDashboardPage(JSON.stringify({ version: 1, provider: "claude", accounts: [] }), "k");
  assert.ok(html.includes('id="settingsBtn"'), "header must include settings button #settingsBtn");
  assert.ok(html.includes('id="settingsModal"'), "body must include #settingsModal");
  assert.ok(html.includes('id="settingsScrim"'), "body must include #settingsScrim");
  assert.ok(html.includes('id="settingsSaveBtn"'), "modal must include #settingsSaveBtn");
  assert.ok(html.includes('id="settingsCancelBtn"'), "modal must include #settingsCancelBtn");
  assert.ok(html.includes("ALL_CLI_PROVIDERS"), "client script defines ALL_CLI_PROVIDERS");
  assert.ok(html.includes("function openSettingsModal("), "openSettingsModal function defined");
  assert.ok(html.includes("function saveSettingsModal("), "saveSettingsModal function defined");
});

test("weekly reset passed logic shows 100% free green badge and notes", () => {
  const html = renderDashboardPage(JSON.stringify({ version: 1, provider: "claude", accounts: [] }), "k");
  assert.ok(html.includes("function isWeekResetReady("), "isWeekResetReady helper exists");
  assert.ok(html.includes("function is5hResetReady("), "is5hResetReady helper exists");
  assert.ok(html.includes("badge_week_reset_ready"), "uses badge_week_reset_ready i18n key");
  assert.ok(html.includes("note_reset_ready"), "uses note_reset_ready i18n key");
  assert.ok(html.includes('barHtml([["free", 100]], "")'), "shows 100% green bar on reset ready");
  assert.ok(html.includes("Đã qua giờ reset tuần"), "reason mentions past weekly reset ready 100%");
});

test("monthly 30d quota window column is supported", () => {
  const html = renderDashboardPage(JSON.stringify({ version: 1, provider: "copilot", accounts: [] }), "k");
  assert.ok(html.includes('cardCol("📅 30d"'), "supports 30d monthly card column");
  assert.ok(html.includes('winBlock("📅 30d"'), "supports 30d monthly dual block");
});



// ---------- i18n completeness of the dashboard client ----------
import { readFileSync } from "node:fs";
import { TRANSLATIONS } from "../src/i18n.js";

const VI_DIACRITICS = /[àáảãạăằắẳẵặâầấẩẫậèéẻẽẹêềếểễệìíỉĩịòóỏõọôồốổỗộơờớởỡợùúủũụưừứửữựỳýỷỹỵđĐ]/;
const dashboardSrc = readFileSync(new URL("../src/dashboard.js", import.meta.url), "utf8");

function usedI18nKeys(src) {
  const keys = new Set();
  for (const m of src.matchAll(/\b(?:t|tx|LT|i18nT)\(\s*([^,)]*)/g)) {
    for (const k of m[1].matchAll(/"([a-z0-9_]+)"/g)) keys.add(k[1]);
  }
  for (const m of src.matchAll(/data-i18n(?:-ph|-title)?="([a-z0-9_]+)"/g)) keys.add(m[1]);
  const lk = src.match(/const loginKeys = \[([^\]]*)\]/);
  if (lk) for (const k of lk[1].matchAll(/"([a-z0-9_]+)"/g)) keys.add(k[1]);
  for (const m of src.matchAll(/loginKeys\.push\("([a-z0-9_]+)"\)/g)) keys.add(m[1]);
  return keys;
}
const placeholders = (s) => [...String(s).matchAll(/\{([a-zA-Z0-9_]+)\}/g)].map((m) => m[1]).sort().join(",");

test("every i18n key used by dashboard.js is defined in en and vi, en has no Vietnamese", () => {
  const keys = usedI18nKeys(dashboardSrc);
  assert.ok(keys.size > 150, "found the keys used by the client (" + keys.size + ")");
  for (const k of keys) {
    assert.ok(TRANSLATIONS.en[k] != null, "en defines " + k);
    assert.ok(TRANSLATIONS.vi[k] != null, "vi defines " + k);
    assert.ok(!VI_DIACRITICS.test(TRANSLATIONS.en[k]), "en value of " + k + " has Vietnamese: " + TRANSLATIONS.en[k]);
    assert.equal(placeholders(TRANSLATIONS.en[k]), placeholders(TRANSLATIONS.vi[k]), "placeholders of " + k + " match in en and vi");
  }
});

test("dashboard.js has no Vietnamese literals outside comments", () => {
  const code = dashboardSrc.replace(/\/\*[\s\S]*?\*\//g, "").split("\n").filter((l) => !/^\s*\/\//.test(l)).join("\n");
  const bad = code.split("\n").filter((l) => VI_DIACRITICS.test(l));
  assert.deepEqual(bad, []);
});

test("static shell of the dashboard and login page has no Vietnamese", () => {
  const strip = (html) => html.replace(/<script[\s\S]*?<\/script>/g, "").replace(/<select[\s\S]*?<\/select>/g, "");
  assert.ok(!VI_DIACRITICS.test(strip(renderDashboardPage("{}", "k"))));
  assert.ok(!VI_DIACRITICS.test(strip(renderRestrictedPage(true))));
});
