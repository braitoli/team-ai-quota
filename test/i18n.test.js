import test from "node:test";
import assert from "node:assert/strict";
import {
  SUPPORTED_LANGUAGES,
  DEFAULT_LANG,
  TRANSLATIONS,
  detectLanguage,
  t,
} from "../src/i18n.js";
import { renderDashboardPage } from "../src/dashboard.js";

test("SUPPORTED_LANGUAGES contains exactly 20 languages", () => {
  assert.equal(SUPPORTED_LANGUAGES.length, 20);
  const codes = SUPPORTED_LANGUAGES.map((l) => l.code);
  const expectedCodes = [
    "en",
    "vi",
    "zh-CN",
    "zh-TW",
    "es",
    "ja",
    "de",
    "fr",
    "ko",
    "pt",
    "ru",
    "it",
    "ar",
    "hi",
    "id",
    "tr",
    "pl",
    "nl",
    "th",
    "uk",
  ];
  assert.deepEqual(codes, expectedCodes);
  for (const lang of SUPPORTED_LANGUAGES) {
    assert.ok(lang.code, "Must have code");
    assert.ok(lang.name, "Must have native name");
    assert.ok(TRANSLATIONS[lang.code], `TRANSLATIONS must have ${lang.code}`);
  }
});

test("detectLanguage handles preferred lang, dialects, prefix and fallback", () => {
  // 1. Explicit supported code
  assert.equal(detectLanguage("vi"), "vi");
  assert.equal(detectLanguage("ja"), "ja");
  assert.equal(detectLanguage("zh-TW"), "zh-TW");
  assert.equal(detectLanguage("zh-CN"), "zh-CN");

  // 2. Dialect and script variants
  assert.equal(detectLanguage("zh-HK"), "zh-TW");
  assert.equal(detectLanguage("zh-Hant"), "zh-TW");
  assert.equal(detectLanguage("zh-Hans"), "zh-CN");
  assert.equal(detectLanguage("zh"), "zh-CN");
  assert.equal(detectLanguage("zh-SG"), "zh-CN");

  // 3. Prefix matching from locale
  assert.equal(detectLanguage("vi-VN"), "vi");
  assert.equal(detectLanguage("fr-FR"), "fr");
  assert.equal(detectLanguage("de-DE"), "de");
  assert.equal(detectLanguage("pt-BR"), "pt");
  assert.equal(detectLanguage("es-MX"), "es");

  // 4. Fallback from unsupported
  assert.equal(detectLanguage("xx-YY"), DEFAULT_LANG);
  assert.equal(detectLanguage(null), DEFAULT_LANG);

  // 5. Array of navigator languages
  assert.equal(detectLanguage(null, ["invalid-LANG", "de-AT", "en"]), "de");
  assert.equal(detectLanguage(null, ["zh-MO", "en"]), "zh-TW");
});

test("t() translates and interpolates variables", () => {
  // Standard translation
  assert.equal(t("brand_sub", {}, "en"), "Claude Quota");
  assert.equal(t("label_7d", {}, "en"), "📅 7-Day");
  assert.equal(t("label_7d", {}, "vi"), "📅 7 ngày");

  // Variable interpolation
  assert.equal(
    t("sent_by", { who: "Mac mini" }, "en"),
    "sent by Mac mini"
  );
  assert.equal(
    t("sent_by", { who: "Mac mini" }, "vi"),
    "do Mac mini gửi"
  );
  assert.equal(
    t("client_ver", { ver: "3.0" }, "ja"),
    "クライアント v3.0"
  );

  // Fallback to English when key missing in target language
  const customKey = "non_existent_key_xyz";
  assert.equal(t(customKey, {}, "fr"), customKey);
});

test("All 20 languages contain required key coverage", () => {
  const essentialKeys = [
    "brand_sub",
    "select_lang",
    "select_provider",
    "filter_accounts",
    "refresh_data",
    "toggle_theme",
    "sec_accounts",
    "sec_hero",
    "sec_timeline",
    "sec_mach",
    "sec_mach_stats",
    "sec_hist",
    "label_7d",
    "label_5h",
    "seg_used",
    "seg_risk",
    "seg_free",
    "badge_ready_100",
    "badge_stale",
    "badge_active",
    "act_use_first",
    "act_wait_5h",
    "drawer_title",
    "drawer_close",
  ];

  for (const lang of SUPPORTED_LANGUAGES) {
    const dict = TRANSLATIONS[lang.code];
    assert.ok(dict, `Translation dict missing for ${lang.code}`);
    for (const key of essentialKeys) {
      assert.ok(
        dict[key] && dict[key].length > 0,
        `Language ${lang.code} missing essential key "${key}"`
      );
    }
  }
});

test("renderDashboardPage integrates language selector and i18n data script", () => {
  const html = renderDashboardPage();

  // Language dropdown select exists
  assert.ok(
    html.includes('id="langSelect"'),
    "HTML must include id='langSelect'"
  );
  assert.ok(
    html.includes('class="btn btn-select"'),
    "HTML must style select with btn-select"
  );

  // All 20 options present in select
  for (const lang of SUPPORTED_LANGUAGES) {
    assert.ok(
      html.includes(`value="${lang.code}"`),
      `Select must have option for ${lang.code}`
    );
    assert.ok(
      html.includes(lang.name),
      `Select must display native name ${lang.name}`
    );
  }

  // i18n JSON data script tag exists
  assert.ok(
    html.includes('id="i18n-data"'),
    "HTML must include id='i18n-data' script"
  );
  assert.ok(
    html.includes("window.__I18N"),
    "HTML must bootstrap window.__I18N"
  );

  // data-i18n attributes present for static tags
  assert.ok(
    html.includes('data-i18n="sec_mach"'),
    "HTML must include data-i18n for sec_mach"
  );
  assert.ok(
    html.includes('data-i18n="sec_mach_stats"'),
    "HTML must include data-i18n for sec_mach_stats"
  );
  assert.ok(
    html.includes('data-i18n="sec_hist"'),
    "HTML must include data-i18n for sec_hist"
  );
});
