// Dashboard HTML for team-ai-quota.
// Pure module: no I/O. The server only emits the page shell + the stored snapshot JSON;
// all rendering happens client-side from that snapshot (no metric is recomputed, only
// subset sums for the account filter).

import { SUPPORTED_LANGUAGES, TRANSLATIONS, DEFAULT_LANG, t as i18nT, formatTemplate } from "./i18n.js";

const LOGO_SVG = `<svg class="logo" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40" fill="none" aria-hidden="true">
  <circle cx="20" cy="20" r="5" stroke="#7C3AED" stroke-width="3"></circle>
  <circle cx="20" cy="20" r="11" stroke="#5E4AE8" stroke-width="3"></circle>
  <circle cx="20" cy="20" r="17" stroke="#3D7BE8" stroke-width="3"></circle>
</svg>`;

const SUN_ICON = `<svg class="ico ico-sun" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 3v1m0 16v1m9-9h-1M4 12H3m15.364 6.364l-.707-.707M6.343 6.343l-.707-.707m12.728 0l-.707.707M6.343 17.657l-.707.707M16 12a4 4 0 11-8 0 4 4 0 018 0z" /></svg>`;
const MOON_ICON = `<svg class="ico ico-moon" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M20.354 15.354A9 9 0 018.646 3.646 9.003 9.003 0 0012 21a9.003 9.003 0 008.354-5.646z" /></svg>`;

// Module-scope Lucide SVG icon strings — used in renderDashboardPage template literals (server-side)
// and mirrored as var ICONS inside clientApp() for browser-side use.
const ICONS = {
  settings: '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-2px;display:inline-block;flex-shrink:0" aria-hidden="true"><path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/></svg>',
  calendar: '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-2px;display:inline-block;flex-shrink:0" aria-hidden="true"><path d="M8 2v4"/><path d="M16 2v4"/><rect width="18" height="18" x="3" y="4" rx="2"/><path d="M3 10h18"/></svg>',
  timer: '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-2px;display:inline-block;flex-shrink:0" aria-hidden="true"><line x1="10" x2="14" y1="2" y2="2"/><line x1="12" x2="15" y1="14" y2="11"/><circle cx="12" cy="14" r="8"/></svg>',
  monitor: '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-2px;display:inline-block;flex-shrink:0" aria-hidden="true"><rect width="20" height="14" x="2" y="3" rx="2"/><line x1="8" x2="16" y1="21" y2="21"/><line x1="12" x2="12" y1="17" y2="21"/></svg>',
  "triangle-alert": '<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-2px;display:inline-block;flex-shrink:0" aria-hidden="true"><path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"/><path d="M12 9v4"/><path d="M12 17h.01"/></svg>',
  globe: '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-2px;display:inline-block;flex-shrink:0" aria-hidden="true"><circle cx="12" cy="12" r="10"/><path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20"/><path d="M2 12h20"/></svg>',
};

const FONT_LINKS = `<link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&family=JetBrains+Mono:wght@400;500;600&display=swap" rel="stylesheet">
  <script src="https://cdn.tailwindcss.com"></script>
  <script>
    tailwind.config = {
      darkMode: 'class',
      theme: { extend: { fontFamily: { sans: ['Inter', 'sans-serif'], mono: ['JetBrains Mono', 'monospace'] } } }
    };
  </script>
  <script>
    (function () {
      var t = null;
      try { t = localStorage.getItem('theme'); } catch (e) {}
      if (t === 'light') document.documentElement.classList.remove('dark');
      else document.documentElement.classList.add('dark');
    })();
  </script>`;

function escapeScript(s) {
  return String(s).replace(/</g, "\\u003c").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
}

/**
 * Restricted page: same flow as the old dashboard (key stored in localStorage
 * `cqm_claude_quota_key`, redirect to `/?key=...`).
 */
export function renderRestrictedPage(hasInvalidKey = false) {
  const LT = (k) => i18nT(k, {}, DEFAULT_LANG);
  const loginKeys = ["toggle_theme", "login_subtitle", "login_placeholder", "login_submit"];
  if (hasInvalidKey) loginKeys.push("login_bad_key");
  const loginDict = {};
  for (const code of Object.keys(TRANSLATIONS)) {
    loginDict[code] = {};
    for (const k of loginKeys) if (TRANSLATIONS[code][k] != null) loginDict[code][k] = TRANSLATIONS[code][k];
  }
  const loginDictJson = escapeScript(JSON.stringify(loginDict));
  return `<!DOCTYPE html>
<html lang="en" class="dark">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Team AI Quota</title>
  ${FONT_LINKS}
  <style>
    .ico { width: 16px; height: 16px; }
    .dark .ico-moon, html:not(.dark) .ico-sun { display: none; }
  </style>
</head>
<body class="bg-slate-50 dark:bg-[#070b14] text-slate-800 dark:text-slate-100 min-h-screen w-full overflow-x-hidden font-sans flex items-center justify-center p-4 relative antialiased">
  <button type="button" onclick="toggleTheme()" title="${LT("toggle_theme")}" aria-label="${LT("toggle_theme")}" data-i18n-title="toggle_theme"
    class="absolute top-4 right-4 p-2 rounded-xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 text-slate-600 dark:text-slate-300 hover:text-indigo-600 dark:hover:text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500">
    ${SUN_ICON}${MOON_ICON}
  </button>
  <main class="w-full max-w-sm">
    <div class="bg-white dark:bg-slate-900/80 border border-slate-200 dark:border-slate-800 rounded-2xl p-7 shadow-xl">
      <div class="flex flex-col items-center text-center mb-6">
        <div class="flex items-center gap-2.5 mb-3">
          <svg class="w-9 h-9" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40" fill="none" aria-hidden="true">
            <circle cx="20" cy="20" r="5" stroke="#7C3AED" stroke-width="3"></circle>
            <circle cx="20" cy="20" r="11" stroke="#5E4AE8" stroke-width="3"></circle>
            <circle cx="20" cy="20" r="17" stroke="#3D7BE8" stroke-width="3"></circle>
          </svg>
          <span class="font-extrabold text-2xl tracking-tight bg-gradient-to-r from-purple-500 via-indigo-500 to-blue-500 bg-clip-text text-transparent">Team AI Quota</span>
        </div>
        <h1 class="text-lg font-bold tracking-tight text-slate-900 dark:text-white">Claude Quota</h1>
        <p class="text-sm text-slate-500 dark:text-slate-400 mt-1" data-i18n="login_subtitle">${LT("login_subtitle")}</p>
      </div>
      ${
        hasInvalidKey
          ? `<div role="alert" class="mb-4 p-3 rounded-xl bg-rose-500/10 border border-rose-500/30 text-rose-700 dark:text-rose-300 text-sm" data-i18n="login_bad_key">${LT("login_bad_key")}</div>`
          : ""
      }
      <form id="authForm" class="space-y-4">
        <div>
          <label for="accessKey" class="block text-xs font-semibold text-slate-600 dark:text-slate-400 mb-1.5">Secret Key</label>
          <input type="password" id="accessKey" required autocomplete="current-password" placeholder="${LT("login_placeholder")}" data-i18n-ph="login_placeholder"
            class="w-full bg-slate-100 dark:bg-slate-950 border border-slate-300 dark:border-slate-700 rounded-xl px-3.5 py-2.5 text-sm text-slate-900 dark:text-white placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-indigo-500/60 font-mono" />
        </div>
        <button type="submit" class="w-full bg-indigo-600 hover:bg-indigo-500 text-white font-semibold py-2.5 px-4 rounded-xl text-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-300" data-i18n="login_submit">${LT("login_submit")}</button>
      </form>
    </div>
  </main>
  <script>
    (function () {
      var D = ${loginDictJson};
      var lang = null;
      try { lang = localStorage.getItem('cqm_lang'); } catch (e) {}
      if (!lang || !D[lang]) {
        lang = 'en';
        var list = (navigator.languages && navigator.languages.length) ? navigator.languages : (navigator.language ? [navigator.language] : []);
        outer: for (var i = 0; i < list.length; i++) {
          var it = String(list[i] || '').toLowerCase();
          var pre = it.split(/[-_]/)[0];
          for (var c in D) { if (c.toLowerCase() === it || c.toLowerCase() === pre) { lang = c; break outer; } }
        }
      }
      var d = D[lang] || {}, en = D.en || {};
      function tx(k) { return d[k] != null ? d[k] : en[k]; }
      document.documentElement.lang = lang;
      Array.prototype.forEach.call(document.querySelectorAll('[data-i18n]'), function (el) { el.textContent = tx(el.getAttribute('data-i18n')); });
      Array.prototype.forEach.call(document.querySelectorAll('[data-i18n-ph]'), function (el) { el.placeholder = tx(el.getAttribute('data-i18n-ph')); });
      Array.prototype.forEach.call(document.querySelectorAll('[data-i18n-title]'), function (el) { var v = tx(el.getAttribute('data-i18n-title')); el.title = v; el.setAttribute('aria-label', v); });
    })();
    function toggleTheme() {
      var dark = document.documentElement.classList.toggle('dark');
      try { localStorage.setItem('theme', dark ? 'dark' : 'light'); } catch (e) {}
    }
    (function () {
      var hasError = ${hasInvalidKey ? "true" : "false"};
      var prov = null;
      try { prov = new URL(window.location.href).searchParams.get('provider'); } catch (e) {}
      var provQs = prov ? '&provider=' + encodeURIComponent(prov) : '';
      var saved = null;
      try { saved = localStorage.getItem('cqm_claude_quota_key'); } catch (e) {}
      if (hasError && saved) {
        try { localStorage.removeItem('cqm_claude_quota_key'); } catch (e) {}
      } else if (!hasError && saved) {
        window.location.href = '/?key=' + encodeURIComponent(saved) + provQs;
        return;
      }
      document.getElementById('authForm').addEventListener('submit', function (e) {
        e.preventDefault();
        var val = document.getElementById('accessKey').value.trim();
        if (!val) return;
        try { localStorage.setItem('cqm_claude_quota_key', val); } catch (err) {}
        window.location.href = '/?key=' + encodeURIComponent(val) + provQs;
      });
    })();
  </script>
</body>
</html>`;
}

const PAGE_CSS = `
:root {
  color-scheme: light;
  --page: #f2f4f8; --surface: #ffffff; --surface-2: #f5f6fa; --track: #e8ebf1;
  --line: #e2e6ee; --line-2: #c9d0dc;
  --ink: #0f1625; --ink-2: #465264; --muted: #6f7a8c;
  --used: #2f6fe0; --used-ghost: #b3cdf6; --used-ink: #1f55b8; --risk-ink: #8f5a00; --danger-ink: #b02a2a; --risk: #df9700; --risk-soft: #f6dc9c;
  --free: #149a57; --free-soft: #d9f0e2; --danger: #d23c3c; --danger-soft: #f6c9c9;
  --unknown: #9aa3b2; --unknown-soft: #e3e6ec;
  --focus: #4f46e5;
}
.dark {
  color-scheme: dark;
  --page: #070b14; --surface: #0e1420; --surface-2: #131a27; --track: #1c2433;
  --line: rgba(255,255,255,.08); --line-2: rgba(255,255,255,.16);
  --ink: #e9edf5; --ink-2: #a9b3c4; --muted: #8590a4;
  --used: #5b9bff; --used-ghost: #27457f; --used-ink: #8db9ff; --risk-ink: #f2b02e; --danger-ink: #ff8a8a; --risk: #f2b02e; --risk-soft: #5a4415;
  --free: #33c47c; --free-soft: #17382a; --danger: #f06262; --danger-soft: #57232a;
  --unknown: #5d6778; --unknown-soft: #262e3c;
  --focus: #a5b4fc;
}
html, body { background: var(--page); color: var(--ink); }
body { font-family: Inter, system-ui, sans-serif; font-size: 14px; line-height: 1.45; min-height: 100vh; overflow-x: hidden; -webkit-font-smoothing: antialiased; }
.num { font-variant-numeric: tabular-nums; }
.mono { font-family: 'JetBrains Mono', ui-monospace, monospace; font-variant-numeric: tabular-nums; }
.ico { width: 16px; height: 16px; }
.dark .ico-moon, html:not(.dark) .ico-sun { display: none; }
:focus-visible { outline: 2px solid var(--focus); outline-offset: 2px; border-radius: 6px; }
.muted { color: var(--muted); }
.ink2 { color: var(--ink-2); }
.wrap { max-width: 1280px; margin: 0 auto; padding: 0 16px; }

/* Header */
.top { position: sticky; top: 0; z-index: 30; background: color-mix(in srgb, var(--page) 88%, transparent); backdrop-filter: blur(10px); border-bottom: 1px solid var(--line); }
.top-row { display: flex; align-items: center; gap: 10px; padding: 10px 0 8px; flex-wrap: wrap; }
.brand { display: flex; align-items: center; gap: 8px; text-decoration: none; color: inherit; }
.brand .logo { width: 26px; height: 26px; flex: none; }
.brand-name { font-weight: 800; font-size: 16px; letter-spacing: -0.02em; background: linear-gradient(90deg, #8b5cf6, #6366f1, #3b82f6); -webkit-background-clip: text; background-clip: text; color: transparent; }
.brand-sub { font-weight: 600; font-size: 15px; color: var(--ink); }
.chip-fresh { display: inline-flex; align-items: center; gap: 6px; font-size: 12px; padding: 4px 10px; border-radius: 999px; border: 1px solid var(--line-2); color: var(--ink-2); background: var(--surface); white-space: nowrap; max-width: 100%; overflow: hidden; text-overflow: ellipsis; }
.chip-fresh .pip { width: 8px; height: 8px; border-radius: 50%; background: var(--free); flex: none; }
.chip-fresh.warn { border: 1px dashed var(--ink-2); color: var(--ink); }
.chip-fresh.warn .pip { background: transparent; border: 1.5px solid var(--ink-2); }
.chip-fresh.bad { border: 1.5px solid var(--ink); background: var(--ink); color: var(--surface); font-weight: 600; }
.chip-fresh.bad .pip { background: var(--surface); }
.spacer { flex: 1 1 auto; }
.btn { display: inline-flex; align-items: center; gap: 6px; height: 34px; padding: 0 12px; border-radius: 10px; border: 1px solid var(--line-2); background: var(--surface); color: var(--ink); font-size: 13px; font-weight: 500; cursor: pointer; white-space: nowrap; }
.btn:hover { border-color: var(--used); }
.btn-icon { width: 34px; padding: 0; justify-content: center; }
.btn .caret { width: 12px; height: 12px; color: var(--muted); }
.lang-wrap { position: relative; }
.btn-select {
  cursor: pointer;
  appearance: none;
  -webkit-appearance: none;
  background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 20 20' fill='%236f7a8c'%3E%3Cpath d='M5.5 7.5L10 12l4.5-4.5' stroke='%236f7a8c' stroke-width='1.8' fill='none' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E");
  background-repeat: no-repeat;
  background-position: right 8px center;
  background-size: 14px 14px;
  padding-right: 28px !important;
  font-size: 13px;
  color: var(--ink);
}
.btn-select option {
  background: var(--surface);
  color: var(--ink);
}
.spin { animation: spin .8s linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }

/* Filter popover */
.filter { position: relative; }
.pop { position: absolute; right: 0; top: calc(100% + 6px); width: 320px; max-width: calc(100vw - 32px); background: var(--surface); border: 1px solid var(--line-2); border-radius: 14px; box-shadow: 0 16px 40px rgba(0,0,0,.25); padding: 6px; z-index: 40; }
.pop[hidden] { display: none; }
.pop-row { display: grid; grid-template-columns: 22px minmax(0, 1fr) auto auto; align-items: center; gap: 8px; padding: 6px 8px; border-radius: 10px; }
.pop-row:hover { background: var(--surface-2); }
.pop-row label { display: flex; align-items: center; gap: 8px; min-width: 0; cursor: pointer; }
.pop-row input { width: 16px; height: 16px; accent-color: var(--used); cursor: pointer; }
.pop-row .nm { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 500; }
.pop-all { border-bottom: 1px solid var(--line); margin-bottom: 4px; padding-bottom: 8px; }
.only { font-size: 12px; color: var(--ink-2); background: none; border: 1px solid transparent; border-radius: 8px; padding: 2px 6px; cursor: pointer; white-space: nowrap; }
.only:hover { border-color: var(--line-2); color: var(--ink); }
.pop-note { font-size: 12px; color: var(--muted); padding: 6px 10px 4px; }

/* Layout */
main { padding: 18px 0 48px; }
.section { margin-top: 22px; }
.section-h { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; flex-wrap: wrap; margin-bottom: 10px; }
.section-h h2 { font-size: 16px; font-weight: 700; letter-spacing: -0.01em; }
.cap { font-size: 12px; color: var(--muted); }
.panel { background: var(--surface); border: 1px solid var(--line); border-radius: 16px; padding: 16px; }
.kpis { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 12px; }
.kpi { background: var(--surface); border: 1px solid var(--line); border-radius: 14px; padding: 14px 16px; min-height: 124px; display: flex; flex-direction: column; gap: 6px; }
.kpi-l { font-size: 12px; font-weight: 600; color: var(--ink-2); }
.kpi-v { font-size: 30px; font-weight: 700; letter-spacing: -0.02em; line-height: 1.1; }
.kpi-v small { font-size: 14px; font-weight: 500; color: var(--ink-2); margin-left: 4px; letter-spacing: 0; }
.kpi-h { font-size: 12px; color: var(--muted); margin-top: auto; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }

/* Bars */
.bar { display: flex; gap: 2px; height: 10px; border-radius: 4px; overflow: hidden; background: var(--track); }
.bar.tall { height: 14px; }
.bar > span { display: block; height: 100%; min-width: 0; }
.seg-used { background: var(--used); }
.seg-ghost { background: repeating-linear-gradient(135deg, var(--used-ghost) 0 4px, color-mix(in srgb, var(--used-ghost) 55%, transparent) 4px 7px); }
.seg-risk { background: var(--risk); }
.seg-free { background: var(--free); }
.seg-danger { background: repeating-linear-gradient(135deg, var(--danger) 0 4px, color-mix(in srgb, var(--danger) 55%, transparent) 4px 7px); }
.seg-unknown { background: repeating-linear-gradient(135deg, var(--unknown) 0 3px, transparent 3px 7px); }
.seg-riskq { background: repeating-linear-gradient(135deg, color-mix(in srgb, var(--risk) 55%, transparent) 0 2px, transparent 2px 6px); border: 1.5px dashed var(--risk); box-sizing: border-box; }
.seg-idle { background: repeating-linear-gradient(135deg, var(--risk) 0 3px, var(--risk-soft) 3px 7px); }
.sw { display: inline-block; width: 12px; height: 10px; border-radius: 3px; vertical-align: -1px; }
.legend { display: flex; flex-wrap: wrap; gap: 6px 14px; font-size: 12px; color: var(--ink-2); }
.legend > span { display: inline-flex; align-items: center; gap: 6px; }

/* Account identity */
.dot { display: inline-block; width: 10px; height: 10px; border-radius: 50%; flex: none; box-shadow: 0 0 0 2px var(--surface); }
.acct { display: inline-flex; align-items: center; gap: 7px; font-weight: 600; min-width: 0; max-width: 100%; }
.tr { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.card-h .acct, .drawer-h .acct { flex: 0 1 auto; }
.card-h > span:last-child { flex: none; display: inline-flex; gap: 4px; flex-wrap: wrap; justify-content: flex-end; max-width: 70%; }
.act-acct, .act-main, .wl-card > div { min-width: 0; }
.legend > span { min-width: 0; max-width: 100%; }
.legend .nm { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex-shrink: 0; max-width: 9em; }
.filter .btn .lbl { max-width: 240px; overflow: hidden; text-overflow: ellipsis; }
.meta-v .ver { font-weight: 500; overflow: hidden; text-overflow: ellipsis; min-width: 0; }
.mach-cards { display: block; }
.mchip { font-size: 11px; font-weight: 600; color: var(--ink-2); padding: 2px 7px; border-radius: 999px; border: 1px solid var(--line-2); white-space: nowrap; display: inline-flex; align-items: center; gap: 4px; }
.mchip i { width: 6px; height: 6px; border-radius: 50%; display: inline-block; background: var(--free); }
.mchip.mchip-off i { background: var(--muted); }
.mchip.mchip-idle i { background: var(--risk); }
.mchip.mchip-none i { background: transparent; border: 1px solid var(--muted); }
.card-machs { display: flex; flex-wrap: wrap; gap: 5px; align-items: center; margin-top: 2px; }
.mach-pill { display: inline-flex; align-items: center; gap: 5px; font-size: 11.5px; line-height: 1.2; padding: 3px 8px; border-radius: 6px; border: 1px solid var(--line); background: color-mix(in srgb, var(--surface) 90%, var(--surface-2)); color: var(--ink-2); max-width: 100%; }
.mach-pill-name { font-weight: 600; color: var(--ink); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 140px; }
.mach-pill-sep { color: var(--muted); font-size: 10px; }
.mach-pill-time { font-size: 11px; color: var(--ink-2); white-space: nowrap; }
.conn-dot { width: 7px; height: 7px; border-radius: 50%; display: inline-block; flex-shrink: 0; }
.mconn-online { border-color: color-mix(in srgb, var(--free) 45%, var(--line)); background: color-mix(in srgb, var(--free) 8%, var(--surface)); }
.mconn-online .conn-dot { background: var(--free); box-shadow: 0 0 6px color-mix(in srgb, var(--free) 60%, transparent); }
.mconn-online .mach-pill-name { color: var(--ink); }
.mconn-idle { border-color: color-mix(in srgb, var(--risk) 45%, var(--line)); background: color-mix(in srgb, var(--risk) 8%, var(--surface)); }
.mconn-idle .conn-dot { background: var(--risk); }
.mconn-offline { border-color: var(--line); background: transparent; color: var(--muted); }
.mconn-offline .conn-dot { background: var(--muted); }
.mconn-offline .mach-pill-name { color: var(--ink-2); }
.mconn-error { border-color: color-mix(in srgb, var(--danger) 45%, var(--line)); background: color-mix(in srgb, var(--danger) 8%, var(--surface)); }
.mconn-error .conn-dot { background: var(--danger); }
.mconn-detached { border-color: var(--line-2); border-style: dashed; background: transparent; color: var(--muted); }
.mconn-detached .conn-dot { background: transparent; border: 1.5px solid var(--muted); }
.mconn-detached .mach-pill-name { color: var(--muted); font-weight: 500; }
.mconn-none { border-color: var(--line); border-style: dotted; background: transparent; color: var(--muted); }
.mconn-none .conn-dot { background: var(--track); }
.mconn-none .mach-pill-name { color: var(--muted); font-weight: 500; }
.warn-note { font-size: 12px; color: var(--ink-2); padding: 6px 8px; border-radius: 8px; border-left: 3px solid var(--risk); background: color-mix(in srgb, var(--risk) 10%, transparent); }
.acct .nm { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

/* Badges */
.badge { display: inline-flex; align-items: center; gap: 5px; font-size: 11.5px; font-weight: 600; padding: 2px 8px; border-radius: 999px; border: 1px solid; white-space: nowrap; }
.badge i { width: 7px; height: 7px; border-radius: 2px; display: inline-block; }
.b-active { color: var(--ink); border-color: color-mix(in srgb, var(--used) 55%, transparent); }
.b-active i { background: var(--used); border-radius: 50%; }
.b-fresh { color: var(--ink); border-color: color-mix(in srgb, var(--free) 60%, transparent); }
.b-fresh i { background: var(--free); }
.b-cool { color: var(--ink); border-color: color-mix(in srgb, var(--danger) 55%, transparent); }
.b-cool i { background: var(--danger); border-radius: 0; transform: rotate(45deg); }
.b-late { color: var(--ink); border: 1px dashed var(--ink-2); font-weight: 600; }
.b-late i { background: transparent; border: 1.5px solid var(--ink-2); border-radius: 50%; }
.b-auth { color: var(--ink); border-color: var(--line-2); }
.b-auth i { background: repeating-linear-gradient(135deg, var(--unknown) 0 2px, transparent 2px 4px); outline: 1px solid var(--unknown); }
.b-cap { color: var(--ink); border-color: color-mix(in srgb, var(--danger) 55%, transparent); }
.b-cap i { background: var(--danger); }
.b-rough { color: var(--ink-2); border-color: var(--risk); border-style: dashed; cursor: help; }
.b-rough i { background: repeating-linear-gradient(135deg, var(--risk) 0 2px, transparent 2px 4px); border: 1px solid var(--risk); }
.b-stale { color: var(--danger-ink); border: 1.5px solid var(--danger); background: transparent; font-weight: 700; }
.b-stale i { background: var(--danger); border-radius: 0; }

/* Hero action list */
.hero { padding: 6px; }
.act { display: grid; grid-template-columns: 34px minmax(96px, 140px) minmax(0, 1fr) minmax(260px, 1.3fr); align-items: center; gap: 14px; padding: 12px 12px; border-radius: 12px; }
.act + .act { border-top: 1px solid var(--line); border-radius: 0; }
.rank { width: 28px; height: 28px; border-radius: 9px; display: grid; place-items: center; font-weight: 700; font-size: 14px; background: var(--surface-2); border: 1px solid var(--line-2); }
.rank.warn { color: #fff; background: var(--danger); border-color: var(--danger); }
.rank.q { color: var(--ink-2); border-style: dashed; }
.rank.off { color: var(--muted); border-style: dashed; background: transparent; }
.act.off .act-verb { color: var(--muted); }
.act.off .act-num { color: var(--ink-2); font-weight: 600; }
.act-main { min-width: 0; }
.act-verb { font-size: 13px; color: var(--ink-2); }
.act-num { font-size: 24px; font-weight: 700; letter-spacing: -0.02em; line-height: 1.15; }
.act-num .unit { font-size: 13px; font-weight: 500; color: var(--ink-2); margin-left: 6px; letter-spacing: 0; }
.act-sub { font-size: 12px; color: var(--muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.empty { padding: 22px 16px; color: var(--ink-2); font-size: 13px; }
.empty b { color: var(--ink); display: block; font-size: 14px; margin-bottom: 4px; }

/* Charts */
.chart { width: 100%; position: relative; }
.chart svg { display: block; overflow: visible; }
.chart text { font-family: Inter, system-ui, sans-serif; fill: var(--muted); font-size: 11px; }
.chart text.ink { fill: var(--ink); }
.chart text.ink2 { fill: var(--ink-2); }
.chart text.onfill { fill: var(--ink); font-weight: 600; }
.chart text.onrisk { fill: #0b0b0b; font-weight: 600; }
.chart .grid { stroke: var(--line); stroke-width: 1; }
.chart .axis { stroke: var(--line-2); stroke-width: 1; }
.hit { cursor: default; }
.hit:hover { filter: brightness(1.12); }

/* Weekly quota history */
.wk-row { display: grid; grid-template-columns: 120px minmax(0, 1fr); gap: 6px 14px; align-items: start; padding: 10px 0; border-top: 1px solid var(--line); }
.wk-row:first-of-type { border-top: 0; }
.wk-cells { display: grid; grid-template-columns: repeat(5, minmax(0, 1fr)); gap: 10px; }
.wk-cells > .wk-cur { grid-column: 5; }
@media (max-width: 860px) { .wk-cells { grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); } .wk-cells > .wk-cur { grid-column: auto; } }
.wk-cell { display: flex; flex-direction: column; gap: 5px; min-width: 0; }
.wk-l { font-size: 11.5px; font-weight: 600; color: var(--ink-2); }
.wk-n { font-size: 12px; color: var(--ink-2); }
.wk-cur { border-left: 1px dashed var(--line-2); padding-left: 10px; }
.wk-none { grid-column: 2; font-size: 12px; color: var(--muted); }
@media (max-width: 560px) { .wk-row { grid-template-columns: minmax(0, 1fr); } .wk-none { grid-column: 1; } }

/* Collapsible sections */
.fold > summary { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; flex-wrap: wrap; cursor: pointer; list-style: none; padding: 10px 14px; border: 1px solid var(--line); border-radius: 14px; background: var(--surface); }
.fold > summary::-webkit-details-marker { display: none; }
.fold > summary h2 { font-size: 16px; font-weight: 700; letter-spacing: -0.01em; }
.fold > summary h2::before { content: "▸"; display: inline-block; width: 1.1em; color: var(--muted); }
.fold[open] > summary h2::before { content: "▾"; }
.fold[open] > summary { margin-bottom: 10px; }
.kpi-7 { border-top: 1px solid var(--line); padding-top: 6px; font-size: 12.5px; color: var(--ink-2); display: flex; flex-wrap: wrap; gap: 2px 8px; align-items: baseline; }
.kpi-7 b { color: var(--ink); font-size: 16px; }
.kpi-7 .kpi-7l { font-weight: 600; }

/* Both quotas side by side (cards + ranked list) */
.dual { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; }
.dual:has(> .qcol:nth-child(3)) { grid-template-columns: repeat(3, minmax(0, 1fr)); }
.dual > .qcol + .qcol { border-left: 1px solid var(--line); padding-left: 12px; }
.qcol { display: flex; flex-direction: column; gap: 6px; min-width: 0; }
.qcol-l { font-size: 11.5px; font-weight: 600; color: var(--ink-2); }
.qcol-v { font-size: 24px; font-weight: 700; letter-spacing: -0.02em; line-height: 1; }
.qcol-v small { font-size: 12px; font-weight: 500; color: var(--ink-2); margin-left: 5px; letter-spacing: 0; }
.qcol-n { font-size: 12px; color: var(--ink-2); min-height: 16px; overflow-wrap: anywhere; }

/* Cards */
.cards { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; }
.card { background: var(--surface); border: 1px solid var(--line); border-radius: 14px; padding: 14px 16px; cursor: pointer; text-align: left;
  /* five rows shared with the neighbouring card (subgrid), so header / 5h-7d / notes / machines / meta line up across a row */
  display: grid; grid-row: span 5; grid-template-rows: subgrid; row-gap: 10px; align-content: start; }
.card > * { min-width: 0; }
.card > .slot:empty { margin-bottom: -10px; }
.card:hover { border-color: var(--line-2); }
.card-h { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.card-big { display: flex; align-items: baseline; gap: 8px; }
.card-big .v { font-size: 28px; font-weight: 700; letter-spacing: -0.02em; line-height: 1; }
.card-big .l { font-size: 12px; color: var(--ink-2); }
.card-note { font-size: 12.5px; color: var(--ink-2); min-height: 18px; }
.t-good { color: var(--used-ink); font-weight: 600; }
.t-warn { color: var(--risk-ink); font-weight: 600; }
.t-bad { color: var(--danger-ink); font-weight: 600; }
.spd-hot { color: var(--danger-ink); font-weight: 800; background: color-mix(in srgb, var(--danger) 16%, transparent); border: 1px solid color-mix(in srgb, var(--danger) 55%, transparent); border-radius: 6px; padding: 0 6px; }
.rate-pulse { display: inline-block; transform-origin: center; animation: ratePulse 2.2s ease-in-out infinite; will-change: transform; }
@keyframes ratePulse { 0%, 100% { transform: scale(1); } 50% { transform: scale(1.04); } }
@media (prefers-reduced-motion: reduce) { .rate-pulse { animation: none; } }
.t-q { color: var(--ink); font-style: italic; border-bottom: 1px dashed var(--ink-2); }
.card-meta { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 8px; border-top: 1px solid var(--line); padding-top: 10px; }
.meta-l { font-size: 11px; color: var(--muted); }
.meta-v { font-size: 13px; font-weight: 600; display: flex; align-items: center; gap: 6px; white-space: nowrap; min-width: 0; overflow: hidden; }
.conf { display: inline-flex; gap: 2px; }
.conf i { width: 6px; height: 6px; border-radius: 50%; background: var(--track); display: inline-block; }
.conf i.on { background: var(--ink-2); }
.gauge { width: 42px; height: 6px; border-radius: 3px; background: var(--track); overflow: hidden; display: inline-block; }
.gauge > b { display: block; height: 100%; background: var(--used); border-radius: 3px; }
.gauge.warn > b { background: var(--risk); }
.gauge.bad > b { background: var(--danger); }

/* Tables */
.tbl { width: 100%; border-collapse: collapse; font-size: 13px; }
.tbl th { text-align: left; font-size: 11.5px; font-weight: 600; color: var(--muted); padding: 6px 10px; border-bottom: 1px solid var(--line); white-space: nowrap; }
.tbl td { padding: 8px 10px; border-bottom: 1px solid var(--line); white-space: nowrap; }
.tbl tr:last-child td { border-bottom: 0; }
.tbl .r { text-align: right; }
.wl-cards { display: none; }
.wl-card { display: grid; grid-template-columns: 1fr auto; gap: 4px 10px; padding: 10px 2px; border-bottom: 1px solid var(--line); font-size: 13px; }
.wl-card:last-child { border-bottom: 0; }

/* Heatmap */
.hm-scale { display: inline-block; width: 120px; height: 10px; border-radius: 3px; background: linear-gradient(90deg, color-mix(in oklab, var(--risk) 4%, var(--surface)), var(--risk)); vertical-align: -1px; }

/* Drawer */
.scrim { position: fixed; inset: 0; background: rgba(5,8,15,.45); z-index: 50; }
.scrim[hidden], .drawer[hidden] { display: none; }
.drawer { position: fixed; top: 0; right: 0; bottom: 0; width: min(560px, 100vw); background: var(--surface); border-left: 1px solid var(--line-2); z-index: 60; overflow-y: auto; padding: 18px 18px 32px; box-shadow: -20px 0 50px rgba(0,0,0,.25); }
.drawer-h { display: flex; align-items: center; justify-content: space-between; gap: 10px; margin-bottom: 4px; }
.drawer h3 { font-size: 14px; font-weight: 700; margin: 18px 0 8px; }
.stats { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 10px; margin-top: 12px; }
.stat { background: var(--surface-2); border-radius: 10px; padding: 8px 10px; }
.stat .v { font-size: 17px; font-weight: 700; }
.err { font-size: 12.5px; padding: 10px; border-radius: 10px; background: var(--surface-2); border: 1px dashed var(--line-2); color: var(--ink-2); word-break: break-word; }

/* Tooltip */
#tip { position: fixed; z-index: 80; pointer-events: none; max-width: 280px; background: var(--ink); color: var(--page); font-size: 12px; line-height: 1.45; padding: 7px 10px; border-radius: 8px; white-space: pre-line; box-shadow: 0 8px 24px rgba(0,0,0,.25); }
#tip[hidden] { display: none; }

.grid-2 { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 14px; }
[hidden] { display: none !important; }

@media (max-width: 1080px) {
  .cards { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .act { grid-template-columns: 34px minmax(86px, 120px) minmax(0, 1fr); }
  .act .act-bar { grid-column: 2 / -1; }
}
@media (max-width: 860px) {
  .kpis { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .grid-2 { grid-template-columns: minmax(0, 1fr); }
}
@media (max-width: 640px) {
  .wrap { padding: 0 12px; }
  .brand-sub { display: none; }
  .top-row { gap: 8px; position: relative; }
  .spacer { display: none; }
  .chip-fresh { order: 5; flex: 1 1 100%; justify-content: flex-start; }
  .filter { flex: 1 1 0; min-width: 0; position: static; }
  .filter .btn .lbl { max-width: none; min-width: 0; }
}
@media (max-width: 560px) {
  .act { grid-template-columns: 30px minmax(0, 1fr); gap: 6px 10px; padding: 12px 6px; }
  .act .act-acct { grid-column: 2 / 3; }
  .act .act-main { grid-column: 1 / -1; }
  .act .act-bar { grid-column: 1 / -1; }
  .act-num { font-size: 22px; }
      .kpi { padding: 12px; min-height: 112px; }
  .kpi-v { font-size: 24px; }
  .cards { grid-template-columns: minmax(0, 1fr); }
  .panel { padding: 12px; border-radius: 14px; }
  .tbl-wrap { display: none; }
  .wl-cards { display: block; }
  .drawer { top: auto; left: 0; width: 100vw; max-height: 88vh; border-left: 0; border-top: 1px solid var(--line-2); border-radius: 18px 18px 0 0; padding: 14px 14px 28px; }
  .stats { grid-template-columns: repeat(2, minmax(0, 1fr)); }
}
@media (max-width: 420px) {
  .lbl-pre { display: none; }
  .filter .btn { width: 100%; justify-content: space-between; }
  .filter .btn .lbl { overflow: hidden; text-overflow: ellipsis; }
  .pop { left: 0; right: 0; top: 52px; width: auto; max-width: none; }
}
@media (prefers-reduced-motion: reduce) { .spin { animation: none; } }

/* Provider switcher (one provider at a time) */
.prov { display: inline-flex; gap: 2px; padding: 3px; border-radius: 11px; border: 1px solid var(--line-2); background: var(--surface); }
.prov a { padding: 4px 11px; border-radius: 8px; font-size: 13px; font-weight: 600; color: var(--muted); text-decoration: none; white-space: nowrap; text-align: center; display: inline-flex; align-items: center; justify-content: center; gap: 6px; }
.prov a:hover { color: var(--ink); }
.prov a svg { width: 15px; height: 15px; flex: none; opacity: 0.75; transition: opacity 0.15s ease; }
.prov a:hover svg, .prov a[aria-current="page"] svg { opacity: 1; }
.prov a[data-prov="claude"] svg { color: #d97757; }
.prov a[data-prov="codex"] svg { color: var(--ink); }
.prov a[aria-current="page"] { color: var(--ink); background: color-mix(in srgb, var(--used) 22%, transparent); box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--used) 55%, transparent); }
@media (max-width: 640px) {
  .prov { order: 4; flex: 1 1 100%; }
  .prov a { flex: 1 1 0; }
}

/* Machine analytics cards & chips */
.mach-stats-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: 12px; }
.mach-stat-card { background: var(--surface); border: 1px solid var(--line); border-radius: 14px; padding: 14px 16px; display: flex; flex-direction: column; gap: 8px; }
.mach-stat-card:hover { border-color: var(--line-2); }
.mach-stat-h { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.mach-stat-title { font-weight: 700; font-size: 14.5px; display: flex; align-items: center; gap: 6px; }
.mach-stat-meta { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 6px 12px; font-size: 12px; margin-top: 4px; border-top: 1px solid var(--line); padding-top: 8px; }
.mach-chip-active { font-size: 11.5px; font-weight: 600; color: var(--used-ink); background: color-mix(in srgb, var(--used) 12%, transparent); border: 1px solid color-mix(in srgb, var(--used) 30%, transparent); border-radius: 6px; padding: 2px 7px; display: inline-flex; align-items: center; gap: 4px; }
.mach-chip-dim { font-size: 11.5px; color: var(--muted); background: var(--surface-2); border: 1px solid var(--line); border-radius: 6px; padding: 2px 7px; display: inline-flex; align-items: center; gap: 4px; opacity: 0.75; }
.intensity-badge { display: inline-flex; align-items: center; gap: 4px; font-size: 11px; font-weight: 600; padding: 2px 7px; border-radius: 999px; }
.intensity-high { background: color-mix(in srgb, var(--danger) 15%, transparent); color: var(--danger-ink); border: 1px solid color-mix(in srgb, var(--danger) 40%, transparent); }
.intensity-med { background: color-mix(in srgb, var(--used) 15%, transparent); color: var(--used-ink); border: 1px solid color-mix(in srgb, var(--used) 40%, transparent); }
.intensity-idle { background: var(--surface-2); color: var(--muted); border: 1px solid var(--line-2); }

/* Settings modal & Labeling */
.settings-scrim { position: fixed; inset: 0; background: rgba(5,8,15,.65); z-index: 70; backdrop-filter: blur(4px); }
.settings-scrim[hidden], .settings-modal[hidden] { display: none; }
.settings-modal { position: fixed; top: 50%; left: 50%; transform: translate(-50%, -50%); width: min(720px, calc(100vw - 32px)); max-height: 88vh; background: var(--surface); border: 1px solid var(--line-2); border-radius: 18px; z-index: 75; overflow-y: auto; padding: 22px 24px; box-shadow: 0 24px 60px rgba(0,0,0,.35); box-sizing: border-box; }
.settings-h { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 16px; border-bottom: 1px solid var(--line); padding-bottom: 12px; }
.settings-h h2 { font-size: 17px; font-weight: 700; display: flex; align-items: center; gap: 8px; margin: 0; }
.settings-sec { margin-top: 18px; padding-top: 14px; border-top: 1px solid var(--line); }
.settings-sec:first-of-type { margin-top: 0; padding-top: 0; border-top: 0; }
.settings-sec-title { font-size: 14px; font-weight: 700; color: var(--ink); margin-bottom: 6px; display: flex; align-items: center; gap: 6px; }
.settings-sec-desc { font-size: 12px; color: var(--muted); margin-bottom: 12px; }
.settings-grid { display: flex; flex-direction: column; gap: 8px; max-height: 260px; overflow-y: auto; padding-right: 4px; }
.settings-row { display: grid; grid-template-columns: minmax(130px, 1.2fr) minmax(170px, 1.8fr) auto; gap: 10px; align-items: center; padding: 8px 10px; background: var(--surface-2); border-radius: 10px; border: 1px solid var(--line); }
.settings-prov-row { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 10px; padding: 10px 12px; background: var(--surface-2); border-radius: 10px; border: 1px solid var(--line); }
.settings-input { background: var(--surface); border: 1px solid var(--line-2); border-radius: 8px; padding: 6px 10px; font-size: 13px; color: var(--ink); width: 100%; box-sizing: border-box; }
.settings-input:focus { border-color: var(--focus); outline: none; }
.settings-windows { display: inline-flex; align-items: center; gap: 12px; font-size: 12px; }
.settings-windows label { display: inline-flex; align-items: center; gap: 4px; cursor: pointer; color: var(--ink-2); }
.settings-windows input { accent-color: var(--used); }
.settings-foot { display: flex; align-items: center; justify-content: flex-end; gap: 10px; margin-top: 20px; padding-top: 14px; border-top: 1px solid var(--line); }
.btn-primary { background: #4f46e5; color: #fff; border: 1px solid #4338ca; font-weight: 600; }
.btn-primary:hover { background: #4338ca; }
.btn-ghost { background: transparent; border-color: transparent; }
.btn-ghost:hover { background: var(--surface-2); border-color: var(--line-2); }

/* Pool tabs (a pooled provider shows one pool at a time, same layout as every provider) */
.pool-tabs { margin-top: 10px; }
`;

/**
 * Client application. Serialised with Function.prototype.toString() and run in the
 * browser, so it must not reference anything outside its own body.
 */
function clientApp() {
  "use strict";

  var ICONS = {
    settings: '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-2px;display:inline-block;flex-shrink:0" aria-hidden="true"><path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/></svg>',
    calendar: '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-2px;display:inline-block;flex-shrink:0" aria-hidden="true"><path d="M8 2v4"/><path d="M16 2v4"/><rect width="18" height="18" x="3" y="4" rx="2"/><path d="M3 10h18"/></svg>',
    timer: '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-2px;display:inline-block;flex-shrink:0" aria-hidden="true"><line x1="10" x2="14" y1="2" y2="2"/><line x1="12" x2="15" y1="14" y2="11"/><circle cx="12" cy="14" r="8"/></svg>',
    monitor: '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-2px;display:inline-block;flex-shrink:0" aria-hidden="true"><rect width="20" height="14" x="2" y="3" rx="2"/><line x1="8" x2="16" y1="21" y2="21"/><line x1="12" x2="12" y1="17" y2="21"/></svg>',
    "triangle-alert": '<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-2px;display:inline-block;flex-shrink:0" aria-hidden="true"><path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"/><path d="M12 9v4"/><path d="M12 17h.01"/></svg>',
    globe: '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-2px;display:inline-block;flex-shrink:0" aria-hidden="true"><circle cx="12" cy="12" r="10"/><path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20"/><path d="M2 12h20"/></svg>',
  };

  var KEY_STORE = "cqm_claude_quota_key";
  var FILTER_STORE = "cqm_quota_filter";
  var HIST_STORE = "cqm_quota_hist_open";
  var SETTINGS_STORE = "cqm_settings";
  var H = 3600000;
  var TZ = 7 * H;
  var CURRENT_KEY = window.__QUOTA_KEY || "";

  var ALL_CLI_PROVIDERS = [
    { id: "claude", label: "Claude (Anthropic)", defaultWindows: ["7d", "5h"] },
    { id: "codex", label: "Codex (OpenAI)", defaultWindows: ["7d", "5h"] },
    { id: "agy", label: "Agy (Antigravity)", defaultWindows: ["7d", "5h"] },
    { id: "gemini", label: "Gemini CLI", defaultWindows: ["7d", "5h"] },
    { id: "copilot", label: "GitHub Copilot", defaultWindows: ["30d", "7d", "5h"] },
    { id: "cursor", label: "Cursor", defaultWindows: ["30d", "7d", "5h"] }
  ];

  // ---------- storage helpers ----------
  function sget(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function sset(k, v) { try { localStorage.setItem(k, v); } catch (e) {} }
  function sdel(k) { try { localStorage.removeItem(k); } catch (e) {} }

  // ---------- settings & labeling helpers ----------
  function getSettings() {
    var s = {};
    if (FULL && FULL.settings && typeof FULL.settings === "object") {
      try { s = JSON.parse(JSON.stringify(FULL.settings)); } catch (e) { s = {}; }
    }
    var local = null;
    try { local = JSON.parse(sget(SETTINGS_STORE) || "null"); } catch (e) { local = null; }
    if (local && typeof local === "object") {
      s.providers = Object.assign({}, s.providers || {}, local.providers || {});
      s.machine_labels = Object.assign({}, s.machine_labels || {}, local.machine_labels || {});
      s.account_labels = Object.assign({}, s.account_labels || {}, local.account_labels || {});
    }
    if (!s.providers) {
      s.providers = {
        claude: { enabled: true, windows: ["7d", "5h"] },
        codex: { enabled: true, windows: ["7d", "5h"] },
        agy: { enabled: true, windows: ["7d", "5h"] },
        gemini: { enabled: true, windows: ["7d", "5h"] },
        copilot: { enabled: true, windows: ["30d", "7d", "5h"] },
        cursor: { enabled: true, windows: ["30d", "7d", "5h"] }
      };
    }
    if (!s.machine_labels) s.machine_labels = {};
    if (!s.account_labels) s.account_labels = {};
    return s;
  }

  function getDynamicMachineLabels() {
    return getSettings().machine_labels || {};
  }

  function getAccountLabel(email) {
    if (!email) return "";
    var labels = getSettings().account_labels || {};
    if (labels[email]) return labels[email];
    var low = String(email).toLowerCase();
    for (var k in labels) {
      if (k.toLowerCase() === low) return labels[k];
    }
    return "";
  }

  // ---------- i18n helpers ----------
  var LANG_STORE = "cqm_lang";
  var I18N = window.__I18N || {};
  try {
    if (!window.__I18N || !Object.keys(window.__I18N).length) {
      var i18nEl = document.getElementById("i18n-data");
      if (i18nEl) I18N = JSON.parse(i18nEl.textContent);
    }
  } catch (e) {}

  function detectClientLang() {
    var saved = sget(LANG_STORE);
    if (saved && I18N[saved]) return saved;
    var list = [];
    try {
      if (navigator.languages && navigator.languages.length) list = navigator.languages;
      else if (navigator.language) list = [navigator.language];
    } catch (e) {}
    for (var i = 0; i < list.length; i++) {
      var item = list[i];
      if (!item || typeof item !== "string") continue;
      for (var code in I18N) {
        if (code.toLowerCase() === item.toLowerCase()) return code;
      }
      var lower = item.toLowerCase();
      if (lower.startsWith("zh")) {
        if (lower.includes("tw") || lower.includes("hk") || lower.includes("mo") || lower.includes("hant")) return "zh-TW";
        return "zh-CN";
      }
      var prefix = lower.split(/[-_]/)[0];
      for (var code in I18N) {
        if (code.toLowerCase() === prefix) return code;
      }
    }
    return "en";
  }

  var currentLang = detectClientLang();

  // window labels carry an emoji in the dictionary (settings screen); the cards use an SVG icon instead
  function plainLabel(k) { return t(k).replace(/^[\u{1F300}-\u{1FAFF}\u2300-\u23FF\u2600-\u27BF]\uFE0F?\s*/u, ""); }
  function t(k, vars) {
    var dict = I18N[currentLang] || I18N["en"] || {};
    // singular form: a key "<k>_one" is used when {n} is 1 (languages without one fall back to <k>)
    if (vars && vars.n === 1 && (dict[k + "_one"] != null || (I18N["en"] && I18N["en"][k + "_one"] != null && dict[k] == null))) k = k + "_one";
    var str = dict[k] != null ? dict[k] : (I18N["en"] && I18N["en"][k] != null ? I18N["en"][k] : k);
    if (vars) {
      for (var p in vars) {
        str = str.replace(new RegExp("\\{" + p + "\\}", "g"), vars[p]);
      }
    }
    return str;
  }
  // alias of t() for scopes that shadow `t` with a local variable
  var tx = t;
  // Text the server generated (analytics.js): obj[field] is the English default, obj[field + "_key"] + obj[field + "_params"]
  // let us render it in the current language (formatTemplate is inlined into the page, see renderDashboardPage).
  // Snapshots without the key (stored before it existed, other API consumers) show the plain obj[field].
  var SRV_FMT = {
    time: function (v) { return hm(v); },
    datetime: function (v) { return v == null ? "—" : hm(v) + " " + dm(v); },
    dur: function (v) { return dur(v); }
  };
  function srvLookup(k) {
    var dict = I18N[currentLang] || I18N["en"] || {};
    return dict[k] != null ? dict[k] : (I18N["en"] && I18N["en"][k] != null ? I18N["en"][k] : k);
  }
  function sv(obj, field) {
    var key = obj ? obj[field + "_key"] : null;
    if (key == null) return obj ? obj[field] : undefined;
    return formatTemplate(srvLookup(key), obj[field + "_params"], SRV_FMT, srvLookup);
  }

  function updateStaticTexts() {
    var els = document.querySelectorAll("[data-i18n]");
    for (var i = 0; i < els.length; i++) {
      var k = els[i].getAttribute("data-i18n");
      if (k) els[i].textContent = t(k);
    }
    var refBtn = document.getElementById("refreshBtn");
    if (refBtn) { refBtn.title = t("refresh_data"); refBtn.setAttribute("aria-label", t("refresh_data")); }
    var thmBtn = document.getElementById("themeBtn");
    if (thmBtn) { thmBtn.title = t("toggle_theme"); thmBtn.setAttribute("aria-label", t("toggle_theme")); }
    var errEl = document.getElementById("loadErr");
    if (errEl) { errEl.textContent = t("load_err"); }
    var provBar = document.getElementById("provBar");
    if (provBar) { provBar.setAttribute("aria-label", t("select_provider")); }
    var poolBar = document.getElementById("poolBar");
    if (poolBar) { poolBar.setAttribute("aria-label", t("select_model_group")); }
    var filterPop = document.getElementById("filterPop");
    if (filterPop) { filterPop.setAttribute("aria-label", t("filter_accounts")); }
    var drawer = document.getElementById("drawer");
    if (drawer) { drawer.setAttribute("aria-label", t("drawer_title")); }
    var langSel = document.getElementById("langSelect");
    if (langSel && langSel.value !== currentLang) {
      langSel.value = currentLang;
    }
    var langSelEl = document.getElementById("langSelect");
    if (langSelEl) { langSelEl.setAttribute("aria-label", t("select_lang")); }
    var setModal = document.getElementById("settingsModal");
    if (setModal) { setModal.setAttribute("aria-label", t("settings_btn")); }
    var setClose = document.getElementById("settingsCloseBtn");
    if (setClose) { setClose.setAttribute("aria-label", t("drawer_close")); }
    var setBtn = document.getElementById("settingsBtn");
    if (setBtn) { setBtn.title = t("settings_btn"); setBtn.setAttribute("aria-label", t("settings_btn")); }
    var setModalTitle = document.getElementById("settingsModalTitle");
    if (setModalTitle) { setModalTitle.innerHTML = ICONS.settings + " " + esc(t("settings_title")); }
    var setSave = document.getElementById("settingsSaveBtn");
    if (setSave) { setSave.textContent = t("settings_save"); }
    var setCancel = document.getElementById("settingsCancelBtn");
    if (setCancel) { setCancel.textContent = t("settings_cancel"); }
    TPL = {};
    layoutSig = "";
  }

  // ---------- data ----------
  var S = null;
  var loadError = false;
  try {
    var raw = document.getElementById("snap-data").textContent;
    S = JSON.parse(raw);
  } catch (e) {
    loadError = true;
  }
  function normalise(s) {
    s = s && typeof s === "object" ? s : {};
    s.accounts = Array.isArray(s.accounts) ? s.accounts : [];
    s.opportunity = s.opportunity || {};
    s.heatmap = s.heatmap || {};
    s.history_14d = s.history_14d || {};
    s.settings = s.settings || {};
    return s;
  }
  S = normalise(S);
  // ---------- provider (one at a time) + pools (side-by-side columns) ----------
  var PROV_STORE = "cqm_quota_provider";
  var URL_PROV = null;
  try { URL_PROV = new URL(window.location.href).searchParams.get("provider") || null; } catch (e) {}
  var PROVIDER = S.provider || URL_PROV || "claude";
  var stInit = getSettings();
  var enabledProvIds = Object.keys(stInit.providers || {}).filter(function (id) {
    return stInit.providers[id] && stInit.providers[id].enabled !== false;
  });
  var BASE_PROVIDERS = Array.isArray(S.providers) && S.providers.length ? S.providers : ALL_CLI_PROVIDERS.map(function (p) { return { id: p.id, label: p.label.split(" ")[0] }; });
  var PROVIDERS = BASE_PROVIDERS.filter(function (p) { return enabledProvIds.indexOf(p.id) >= 0; });
  if (!PROVIDERS.length) PROVIDERS = [{ id: "claude", label: "Claude" }];
  if (!PROVIDERS.some(function (p) { return p.id === PROVIDER; })) {
    PROVIDERS.unshift({ id: PROVIDER, label: (ALL_CLI_PROVIDERS.filter(function (p) { return p.id === PROVIDER; })[0] || { label: PROVIDER }).label.split(" ")[0] });
  }
  var POOLS = Array.isArray(S.pools) ? S.pools.filter(function (p) { return p && p.id; }) : [];
  var PROV_LABEL = (PROVIDERS.filter(function (p) { return p.id === PROVIDER; })[0] || { label: PROVIDER }).label;
  if (PROVIDER !== "claude") FILTER_STORE += "_" + PROVIDER;
  var FULL = S; // the whole provider snapshot; S is the current view (FULL or one pool)
  var SUF = ""; // id suffix of the panel being rendered ("" or "-<pool>")
  function $(id) { return document.getElementById(id + SUF); }
  function etagOf(s) { return s.version == null ? null : '"' + (PROVIDER === "claude" ? "" : PROVIDER + "-") + s.version + '"'; }
  function keyOf(r) { return r.account_key || r.email; }
  function rowByKey(k) { for (var i = 0; i < FULL.accounts.length; i++) if (keyOf(FULL.accounts[i]) === k) return FULL.accounts[i]; return null; }
  function uniqEmails() { var seen = {}, out = []; FULL.accounts.forEach(function (a) { if (!seen[a.email]) { seen[a.email] = 1; out.push(a.email); } }); return out; }

  // ---------- 5h and 7d are always shown together (no subview switch) ----------
  // the weekly quota is read per account through wkRow(); the section analytics below stay on the 5h model
  function weekView() { return false; }

  // ---------- pool tabs: a pooled provider (Agy) shows ONE pool at a time, laid out exactly like Claude ----------
  var POOL_STORE = "cqm_quota_pool_" + PROVIDER;
  var URL_POOL = null;
  try { URL_POOL = new URL(window.location.href).searchParams.get("pool"); } catch (e) {}
  var poolSel = URL_POOL || sget(POOL_STORE);
  function curPool() {
    for (var i = 0; i < POOLS.length; i++) if (POOLS[i].id === poolSel) return POOLS[i];
    return POOLS[0] || null;
  }
  function activePools() {
    var p = curPool();
    return p ? [p] : [];
  }
  function setPool(id) {
    poolSel = id;
    sset(POOL_STORE, id);
    try {
      var u = new URL(window.location.href);
      u.searchParams.set("pool", id);
      history.replaceState(null, "", u.pathname + u.search);
    } catch (e) {}
    renderAll();
  }
  function renderPoolTabs() {
    var bar = document.getElementById("poolBar");
    if (!bar) return;
    if (POOLS.length < 2) { bar.hidden = true; return; }
    var cur = curPool();
    bar.innerHTML = POOLS.map(function (p) {
      var n = FULL.accounts.filter(function (r) { return r.pool === p.id; }).length;
      return '<a href="#" data-pool-tab="' + esc(p.id) + '"' + (cur && p.id === cur.id ? ' aria-current="page"' : "") + "><span>" + esc(p.label || p.id) + '</span><span class="muted">' + t("c_n_tk", { n: n }) + "</span></a>";
    }).join("");
    bar.hidden = false;
  }

  function poolView(id) {
    var is7d = weekView();
    var bp = id == null ? FULL
      : is7d
      ? ((FULL.subviews && FULL.subviews["7d"] && FULL.subviews["7d"].by_pool && FULL.subviews["7d"].by_pool[id]) || (FULL.by_pool_7d && FULL.by_pool_7d[id]) || (FULL.by_pool && FULL.by_pool[id]) || {})
      : ((FULL.by_pool && FULL.by_pool[id]) || {});

    var accounts = id == null ? FULL.accounts : FULL.accounts.filter(function (r) { return r.pool === id; });
    if (is7d) {
      // the server re-analysed every row over its weekly window (same model as 5h): overlay it on the row
      var wrows = (FULL.subviews && FULL.subviews["7d"] && FULL.subviews["7d"].rows) || {};
      accounts = accounts.map(function (r) { return Object.assign({}, r, wrows[keyOf(r)] || {}); });
    }

    return normalise({
      version: FULL.version, computed_at: FULL.computed_at, trigger_email: FULL.trigger_email, provider: FULL.provider,
      accounts: accounts,
      totals: is7d ? ((id == null ? (FULL.subviews && FULL.subviews["7d"] && FULL.subviews["7d"].totals) || FULL.totals_7d : bp.totals) || bp.totals) : bp.totals,
      opportunity: is7d ? ((id == null ? (FULL.subviews && FULL.subviews["7d"] && FULL.subviews["7d"].opportunity) || FULL.opportunity_7d : bp.opportunity) || bp.opportunity) : bp.opportunity,
      heatmap: bp.heatmap, golden_hours: bp.golden_hours, history_14d: bp.history_14d,
    });
  }
  // run fn with S scoped to one pool (sfx: id suffix of that pool's panel, "" for the drawer)
  function inView(poolId, sfx, fn) {
    var saveS = S, saveSuf = SUF;
    S = poolId ? poolView(poolId) : (weekView() && !POOLS.length ? poolView(null) : FULL);
    SUF = sfx;
    try { fn(); } finally { S = saveS; SUF = saveSuf; }
  }
  var etag = etagOf(S);
  if (CURRENT_KEY) sset(KEY_STORE, CURRENT_KEY);

  // ---------- formatting ----------
  function esc(v) {
    return String(v == null ? "" : v).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function ms(iso) { if (iso == null) return null; var t = typeof iso === "number" ? iso : Date.parse(iso); return isFinite(t) ? t : null; }
  function g7(t) { return new Date(t + TZ); }
  function pad(n) { return (n < 10 ? "0" : "") + n; }
  function dayKey(t) { var d = g7(t); return d.getUTCFullYear() + "-" + d.getUTCMonth() + "-" + d.getUTCDate(); }
  function hm(t) { if (t == null) return "—"; var d = g7(t); return pad(d.getUTCHours()) + ":" + pad(d.getUTCMinutes()); }
  // reset times: a weekly window needs the date, a 5h one does not
  function hmw(t) { return weekView() ? when(t) : hm(t); }
  function dm(t) { var d = g7(t); return pad(d.getUTCDate()) + "/" + pad(d.getUTCMonth() + 1); }
  // HH:mm, plus DD/MM when not today (GMT+7)
  function when(t) { if (t == null) return "—"; return dayKey(t) === dayKey(Date.now()) ? hm(t) : hm(t) + " " + dm(t); }
  // date suffix "28/10 · " when t is not today (GMT+7)
  function dpre(t) { return t != null && dayKey(t) !== dayKey(Date.now()) ? dm(t) + " · " : ""; }
  function agoShort(d) {
    var m = Math.max(0, Math.round(d / 60000));
    if (m < 1) return t("time_just_now");
    if (m < 60) return t("time_m_ago", { m: m });
    if (m < 1440) return Math.floor(m / 60) + "h" + (m % 60 ? pad(m % 60) : "") + " " + t("time_ago_suffix");
    return t("time_days_ago", { d: Math.floor(m / 1440) });
  }
  function dur(d) {
    if (d == null || !isFinite(d)) return "—";
    var m = Math.max(0, Math.round(d / 60000));
    if (m < 60) return m + "m";
    var h = Math.floor(m / 60); m = m % 60;
    if (h < 24) return h + "h" + (m ? " " + m + "m" : "");
    var dd = Math.floor(h / 24); h = h % 24;
    return dd + t("time_days_short") + (h ? " " + h + "h" : "");
  }
  function ago(d) {
    var m = Math.max(0, Math.round(d / 60000));
    if (m < 1) return t("time_just_now");
    if (m < 60) return t("time_minutes_ago", { m: m });
    var h = Math.floor(m / 60);
    if (h < 24) return h + "h " + (m % 60 ? (m % 60) + "m " : "") + t("time_ago_suffix");
    return t("time_days_ago", { d: Math.floor(h / 24) });
  }
  function pct(v, approx) {
    if (v == null || !isFinite(v)) return "—";
    var a = Math.abs(v);
    var s = a >= 10 || a === 0 ? String(Math.round(v)) : (Math.round(v * 10) / 10).toString();
    return (approx ? "~" : "") + s + "%";
  }
  function num1(v) { return v == null || !isFinite(v) ? "—" : (Math.round(v * 10) / 10).toString(); }
  function sum(arr) { var s = 0; for (var i = 0; i < arr.length; i++) s += +arr[i] || 0; return s; }
  function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }

  // ---------- account identity: by name only (colour is reserved for quota efficiency) ----------
  var shortName = {};
  function rebuildIdentity() {
    var emails = uniqEmails().sort(); // a pooled provider has one row per (email, pool)
    var counts = {};
    emails.forEach(function (e) { var l = String(e).split("@")[0]; counts[l] = (counts[l] || 0) + 1; });
    shortName = {};
    emails.forEach(function (e) { var l = String(e).split("@")[0]; shortName[e] = counts[l] > 1 ? e : l; });
  }
  function nm(e) { return shortName[e] || String(e || "").split("@")[0]; }
  function chip(e, extra) {
    var lbl = getAccountLabel(e);
    if (lbl) {
      return '<span class="acct" title="' + esc(e) + '"><span class="nm">' + esc(lbl) + '</span><span class="muted" style="font-size:11px;font-weight:400;margin-left:4px">(' + esc(nm(e)) + ')</span>' + (extra || "") + "</span>";
    }
    return '<span class="acct" title="' + esc(e) + '"><span class="nm">' + esc(nm(e)) + "</span>" + (extra || "") + "</span>";
  }

  // ---------- filter ----------
  var sel = new Set();
  var filterMode = "all";
  function loadFilter() {
    var all = uniqEmails();
    var f = null;
    try { f = JSON.parse(sget(FILTER_STORE) || "null"); } catch (e) { f = null; }
    if (f && f.mode === "some" && Array.isArray(f.emails)) {
      var keep = f.emails.filter(function (e) { return all.indexOf(e) >= 0; });
      if (keep.length) { filterMode = "some"; sel = new Set(keep); if (keep.length === all.length) filterMode = "all"; return; }
    }
    filterMode = "all";
    sel = new Set(all);
  }
  function saveFilter() {
    var all = uniqEmails();
    if (sel.size >= all.length && all.every(function (e) { return sel.has(e); })) {
      filterMode = "all";
      sset(FILTER_STORE, JSON.stringify({ mode: "all" }));
    } else {
      filterMode = "some";
      sset(FILTER_STORE, JSON.stringify({ mode: "some", emails: Array.from(sel) }));
    }
  }

  // ---------- derive view model (subset sums only) ----------
  function rowOf(e) { for (var i = 0; i < S.accounts.length; i++) if (S.accounts[i].email === e) return S.accounts[i]; return null; }
  function excluded(r) { return r.state_code === "AUTH" || r.weekly_capped; }
  function urgencyRank(r) {
    if (r.state_code === "ACTIVE" && !r.weekly_capped && (r.at_risk_waste || 0) > 0) return 0;
    if (r.state_code === "FRESH" && !r.weekly_capped) return 1;
    if (r.state_code === "ACTIVE" && !r.weekly_capped) return 2;
    if (r.state_code === "COOLDOWN") return 3;
    if (r.weekly_capped) return 4;
    return 5;
  }
  function urgencyScore(r) {
    var rem = r.resets_at ? Math.max(0, (ms(r.resets_at) - Date.now()) / H) : 0;
    return wLo(r) / Math.max(rem, 0.25) + wHi(r) / Math.max(rem, 0.25) * 0.001;
  }
  function sortedRows(rows) {
    return rows.slice().sort(function (a, b) {
      var ra = urgencyRank(a), rb = urgencyRank(b);
      if (ra !== rb) return ra - rb;
      if (ra === 0) return urgencyScore(b) - urgencyScore(a);
      return String(a.email).localeCompare(String(b.email));
    });
  }
  function validAlternative(alt, exceptEmail) {
    if (!alt || !alt.email || alt.email === exceptEmail || !sel.has(alt.email)) return false;
    var r = rowOf(alt.email);
    if (!r || excluded(r) || exhaustInfo(r)) return false;
    return r.state_code === "FRESH" || (r.state_code === "ACTIVE" && (r.free_now || 0) > 0);
  }
  function pickAlternative(exceptEmail) {
    var rows = S.accounts.filter(function (r) { return sel.has(r.email) && r.email !== exceptEmail && !excluded(r); });
    var fresh = rows.filter(function (r) { return r.state_code === "FRESH"; });
    if (fresh.length) return { email: fresh[0].email, free_now: 100, state_code: "FRESH" };
    var act = rows.filter(function (r) { return r.state_code === "ACTIVE" && (r.free_now || 0) > 0 && !exhaustInfo(r); })
      .sort(function (a, b) { return (b.free_now || 0) - (a.free_now || 0); });
    if (act.length) return { email: act[0].email, free_now: act[0].free_now, state_code: "ACTIVE" };
    return null;
  }
  function derive() {
    var rows = S.accounts.filter(function (r) { return sel.has(r.email); });
    var usable = rows.filter(function (r) { return !excluded(r); });
    var v = { rows: rows, sorted: sortedRows(rows) };
    v.freeSum = sum(usable.map(function (r) { return r.free_now; }));
    v.riskRows = rows.filter(function (r) { return r.state_code === "ACTIVE" && !r.weekly_capped && (r.at_risk_waste || 0) > 0; });
    v.riskSum = sum(v.riskRows.map(wLo));
    v.riskMax = sum(v.riskRows.map(wHi));
    v.riskRough = v.riskRows.filter(isRough).length;
    v.fresh = rows.filter(function (r) { return r.state_code === "FRESH" && !r.weekly_capped; });
    v.auth = rows.filter(function (r) { return r.state_code === "AUTH"; });
    v.capped = rows.filter(function (r) { return r.weekly_capped && r.state_code !== "AUTH"; });
    var op = S.opportunity || {};
    v.useBefore = (op.use_before_reset || []).filter(function (o) { return sel.has(o.email); });
    v.freshNow = (op.fresh_now || []).filter(function (o) { return sel.has(o.email); });
    v.exhaust = (op.will_exhaust || []).filter(function (o) { return sel.has(o.email); }).map(function (o) {
      var alt = validAlternative(o.alternative, o.email) ? o.alternative : pickAlternative(o.email);
      return Object.assign({}, o, { alt: alt });
    });
    // every other account, so the ranked list always shows the whole selection
    v.others = (op.others || deriveOthers(v)).filter(function (o) { return sel.has(o.email); });
    // attention: distinct emails (auth ∪ capped ∪ will_exhaust)
    var att = {};
    function addAtt(e, tag) { (att[e] = att[e] || []).push(tag); }
    v.auth.forEach(function (r) { addAtt(r.email, r.auth_state === "expired_idle" ? t("c_att_token") : r.auth_state === "error" ? t("c_att_read_err") : t("c_att_login")); });
    v.capped.forEach(function (r) { addAtt(r.email, t("c_att_capped")); });
    v.exhaust.forEach(function (o) { addAtt(o.email, t("c_att_exhaust")); });
    v.attention = Object.keys(att).map(function (e) { return { email: e, tags: att[e] }; });
    return v;
  }

  // ---------- state helpers ----------
  // 5h bucket switched off because the weekly cap was hit (pooled providers): resets_at is the weekly reset
  function fhdNote(r) {
    var wr = ms(r.weekly_resets_at != null ? r.weekly_resets_at : r.resets_at), now = Date.now();
    var rem = wr != null ? (wr > now ? " · " + t("hours_left", { dur: dur(wr - now) }) : " · " + t("past_reset")) : "";
    return "<b>" + t("badge_weekly_cap_fhd") + "</b>" + (wr != null ? " · " + t("c_weekly_reset_lc") + " <b class=\"num\">" + when(wr) + "</b>" + rem : "");
  }
  function isWeekResetReady(r, w) {
    if (!r || r.state_code === "AUTH") return false;
    if (r.weekly_reset_ready || (w && w.weekly_reset_ready)) return true;
    var rs7 = ms(r.weekly_resets_at || r.weekly_resets_at_passed || (w && w.resets_at));
    if (!rs7) return false;
    var isCapped = r.weekly_capped || (w && (w.weekly_capped || w.free_now === 0 || w.state_code === "COOLDOWN"));
    return isCapped && Date.now() >= rs7;
  }
  function is5hResetReady(r) {
    if (!r || r.state_code === "AUTH") return false;
    var rs5 = ms(r.resets_at);
    if (!rs5) return false;
    return r.state_code === "COOLDOWN" && Date.now() >= rs5;
  }
  function badge(r) {
    var out = "";
    var w = wkRow(r);
    var wkReady = isWeekResetReady(r, w);
    var h5Ready = is5hResetReady(r);
    if (r.state_code === "AUTH") {
      var l = r.auth_state === "expired_idle" ? t("badge_auth_expired") : r.auth_state === "error" ? t("badge_auth_error") : t("badge_auth_login");
      out = '<span class="badge b-auth"><i></i>' + l + "</span>";
    } else if (wkReady) {
      out = '<span class="badge b-fresh" title="' + esc(t("badge_week_reset_ready")) + '"><i></i>' + esc(t("badge_week_reset_ready")) + "</span>";
    } else if (r.weekly_capped) {
      out = '<span class="badge b-cap"' + (r.five_hour_disabled ? ' title="' + esc(t("badge_weekly_cap_fhd")) + '"' : "") + '><i></i>' + t("badge_weekly_cap") + '</span>';
    } else if (r.state_code === "FRESH" || h5Ready) {
      out = '<span class="badge b-fresh"><i></i>' + t("badge_ready_100") + '</span>';
    } else if (r.state_code === "COOLDOWN") {
      if (r.resets_at && Date.now() >= ms(r.resets_at)) {
        out = '<span class="badge b-fresh"><i></i>' + t("badge_past_reset") + '</span>';
      } else {
        out = '<span class="badge b-cool"><i></i>Cooldown</span>';
      }
    } else if (r.state_code === "ACTIVE" && detachedMachList(r).length > 0 && machList(r).length === 0) {
      out = '<span class="badge b-cool"><i></i>' + t("badge_no_machine") + '</span>';
    } else {
      out = '<span class="badge b-active"><i></i>' + t("badge_active") + '</span>';
    }
    if (r.stale && r.state_code !== "AUTH") out += ' <span class="badge b-stale" title="' + esc(t("badge_stale_tip")) + '"><i></i>' + t("badge_stale") + '</span>';
    out += lateBadge(r);
    return out;
  }
  function confDots(c) {
    var n = c === "high" ? 3 : c === "medium" ? 2 : c === "low" ? 1 : 0;
    var label = c === "high" ? t("conf_high") : c === "medium" ? t("conf_medium") : c === "low" ? t("conf_low") : t("conf_none");
    return '<span class="conf" role="img" aria-label="' + label + '" title="' + label + '"><i class="' + (n >= 1 ? "on" : "") + '"></i><i class="' + (n >= 2 ? "on" : "") + '"></i><i class="' + (n >= 3 ? "on" : "") + '"></i></span>';
  }
  function approx(r) { return r.confidence !== "high"; }
  // thin data: the waste figure is a range [lo, hi], not a point estimate
  function wLo(r) { return r.at_risk_waste_min != null ? r.at_risk_waste_min : (r.at_risk_waste || 0); }
  function wHi(r) { return r.at_risk_waste || 0; }
  function isRough(r) { return r.state_code === "ACTIVE" && r.uncertain === true && wHi(r) - wLo(r) >= 1; }
  function wasteTxt(r) { return isRough(r) ? Math.round(wLo(r)) + "–" + pct(wHi(r)) : pct(wHi(r), approx(r)); }
  function roughReason(r) {
    if (r.uncertain_reason === "stale") return t("c_rough_stale");
    if (weekView()) return t("c_rough_week", { n: Math.max(1, Math.round(r.elapsed_hours || 0)) });
    return t("c_rough_min", { n: Math.max(1, Math.round((r.elapsed_hours || 0) * 60)) });
  }
  function roughBadge(r) {
    if (!isRough(r)) return "";
    var t = roughReason(r);
    return '<span class="badge b-rough" tabindex="0" role="note" aria-label="' + esc(tx("badge_rough_estimate") + ": " + t) + '" data-tip="' + esc(t) + '"><i></i>' + tx("badge_rough_estimate") + '</span>';
  }
  // healthy account, but one machine reported an expired/failed token
  function authWarnHtml(r) {
    var w = r && r.auth_warning;
    if (!w || typeof w !== "object" || r.state_code === "AUTH") return "";
    var fallback = w.state === "auth_required" ? t("badge_auth_login") : w.state === "error" ? t("badge_auth_error") : t("badge_auth_expired");
    var label = sv(w, "label");
    if (typeof label !== "string" || !label) label = fallback;
    var at = ms(w.at);
    var tip = [w.error, w.error_kind].filter(function (x) { return typeof x === "string" && x; }).join(" · ");
    var attr = tip ? ' title="' + esc(tip) + '"' : "";
    if (w.from_other_machine === true) {
      return '<div class="warn-note"' + attr + ">" + t("c_auth_warn_other", { label: esc(label), at: at != null ? " " + t("c_at") + " " + esc(when(at)) : "" }) + "</div>";
    }
    // the same machine failed once after measuring fine: say what the current numbers are
    var kind = typeof w.error_kind === "string" && w.error_kind ? w.error_kind : label;
    var lv = ms(w.last_valid_at);
    return '<div class="warn-note"' + attr + ">" + t("c_auth_warn_same", { kind: esc(kind), at: at != null ? " " + t("c_at") + " " + esc(when(at)) : "" }) +
      (lv != null ? " — " + t("c_current_from_ok") + " " + esc(when(lv)) : "") + "</div>";
  }
  function exhaustInfo(r) {
    var ex = ms(r.exhaust_at), rs = ms(r.resets_at);
    var now = Date.now();
    if (r.state_code !== "ACTIVE" || ex == null || rs == null || ex >= rs) return null;
    if ((detachedMachList(r).length > 0 && machList(r).length === 0) || r.stale || now >= rs || ex <= now) return null;
    return { at: ex, already: ex <= now + 60000 };
  }
  // used / ghost / risk / free composition, in % of the window
  function composition(r) {
    if (r.state_code === "AUTH") {
      var u = r.used_percent;
      return u == null ? [["unknown", 100]] : [["used", u], ["unknown", 100 - u]];
    }
    if (r.state_code === "FRESH") return r.weekly_capped ? [["unknown", 100]] : [["free", 100]];
    if (r.five_hour_disabled) return [["unknown", 100]];
    if (r.state_code === "COOLDOWN") return [["used", 100]];
    var used = clamp(r.used_percent || 0, 0, 100);
    if (r.weekly_capped) return [["used", used], ["unknown", 100 - used]];
    var proj = clamp(r.projected_percent != null ? r.projected_percent : used, used, 100);
    var risk = clamp(r.at_risk_waste || 0, 0, 100 - proj);
    var ghost = proj - used;
    var rest = 100 - used - ghost - risk;
    var parts = [["used", used], ["ghost", ghost], ["risk", risk]];
    if (isRough(r)) {
      var lo = clamp(wLo(r), 0, risk);
      parts = [["used", used], ["ghost", ghost], ["riskq", risk - lo], ["risk", lo]];
    }
    if (rest > 0.5) parts.push(["free", rest]);
    return parts;
  }
  function segLabel(k) {
    var dict = {
      used: t("seg_used"), ghost: t("seg_ghost"), risk: t("seg_risk"), riskq: t("seg_riskq"),
      free: t("seg_free"), unknown: t("seg_unknown"), danger: t("seg_danger"), idle: t("seg_idle")
    };
    return dict[k] || k;
  }
  function barHtml(parts, cls, tipPrefix) {
    var tip = parts.filter(function (p) { return p[1] > 0.05; }).map(function (p) { return segLabel(p[0]) + ": " + pct(p[1]); }).join("\n");
    return '<div class="bar ' + (cls || "") + '" data-tip="' + esc((tipPrefix ? tipPrefix + "\n" : "") + tip) + '" role="img" aria-label="' + esc(tip.replace(/\n/g, ", ")) + '">' +
      parts.filter(function (p) { return p[1] > 0.05; }).map(function (p) { return '<span class="seg-' + p[0] + '" style="flex:' + p[1].toFixed(2) + ' 1 0"></span>'; }).join("") + "</div>";
  }

  // ---------- header ----------
  function renderFreshness() {
    var el = document.getElementById("fresh");
    var c = ms(S.computed_at);
    if (!S.version || c == null) {
      el.className = "chip-fresh bad";
      el.innerHTML = '<span class="pip"></span>' + t("no_data");
      return;
    }
    var age = Math.max(0, Date.now() - c);
    el.className = "chip-fresh" + (age > 2 * H ? " bad" : age > 45 * 60000 ? " warn" : "");
    var who = S.trigger_email ? (S.trigger_email === "kv-import" ? t("imported_legacy") : t("sent_by", { who: nm(S.trigger_email) })) : "";
    el.innerHTML = '<span class="pip"></span><span class="tr">' + t("snapshot_at") + ' <b class="num">' + when(c) + "</b> (" + ago(age) + ")" + (who ? " · " + esc(who) : "") + "</span>";
    el.title = t("snapshot_title") + (S.trigger_email ? " · " + S.trigger_email : "");
  }
  function renderFilterButton() {
    var all = uniqEmails().length;
    var lbl;
    if (filterMode === "all" || sel.size >= all) lbl = t("all") + " (" + all + ")";
    else if (sel.size <= 2) lbl = Array.from(sel).map(nm).join(", ");
    else lbl = sel.size + "/" + all;
    document.getElementById("filterLbl").innerHTML = '<span class="lbl-pre">' + t("accounts_label") + ' </span>' + esc(lbl);
    document.getElementById("filterBtn").setAttribute("title", t("accounts_label") + " " + lbl);
  }
  function renderFilterPop() {
    var pop = document.getElementById("filterPop");
    var all = uniqEmails().sort();
    var allOn = all.length && all.every(function (e) { return sel.has(e); });
    var html = '<div class="pop-row pop-all"><input type="checkbox" id="f-all" aria-label="' + esc(t("all_accounts")) + '"' + (allOn ? " checked" : "") + '><label for="f-all"><span class="nm">' + t("all") + '</span></label><span class="cap num">' + sel.size + "/" + all.length + "</span><span></span></div>";
    all.forEach(function (e, i) {
      function freeOf(r) { return r ? (r.state_code === "AUTH" ? "—" : pct(r.weekly_capped ? 0 : r.free_now)) : "—"; }
      var free, freeTip = t("free_now");
      if (POOLS.length) {
        // one value per pool, never summed
        var per = POOLS.map(function (p) { return freeOf(FULL.accounts.filter(function (x) { return x.email === e && x.pool === p.id; })[0]); });
        free = per.join(" · ");
        freeTip += ": " + POOLS.map(function (p, j) { return p.label + " " + per[j]; }).join(" · ");
      } else free = freeOf(rowOf(e));
      html += '<div class="pop-row"><input type="checkbox" id="f-' + i + '" data-email="' + esc(e) + '"' + (sel.has(e) ? " checked" : "") + '><label for="f-' + i + '"><span class="nm" title="' + esc(e) + '">' + esc(nm(e)) + '</span></label><span class="cap num" title="' + esc(freeTip) + '">' + free + '</span><button type="button" class="only" data-only="' + esc(e) + '">' + t("only_this_account") + '</button></div>';
    });
    html += '<div class="pop-note">' + t("filter_note") + '</div>';
    pop.innerHTML = html;
    var cb = document.getElementById("f-all");
    if (cb) {
      var mixed = !allOn && sel.size > 0;
      cb.indeterminate = mixed;
      cb.setAttribute("aria-checked", mixed ? "mixed" : allOn ? "true" : "false");
    }
  }
  function setFilterOpen(open) {
    var pop = document.getElementById("filterPop");
    var btn = document.getElementById("filterBtn");
    pop.hidden = !open;
    btn.setAttribute("aria-expanded", open ? "true" : "false");
    if (open) renderFilterPop();
  }

  // ---------- tab "Bây giờ" ----------
  function kpiCard(label, value, visual, hint, wk) {
    return '<div class="kpi"><div class="kpi-l">' + label + '</div><div class="kpi-v num">' + value + "</div>" + (visual || "") + '<div class="kpi-h">' + hint + "</div>" +
      (wk ? '<div class="kpi-7"><span class="kpi-7l">' + t("label_7d") + '</span><b class="num">' + wk[0] + "</b><span>" + wk[1] + "</span></div>" : "") + "</div>";
  }
  function renderNowKpis(v) {
    var is7d = weekView();
    var el = $("nowKpis");
    var nSel = v.rows.length;
    var exclN = v.rows.filter(excluded).length;
    var freeVis = '<div class="bar tall" role="img" aria-label="' + esc(t("c_aria_free")) + '">' + v.rows.map(function (r) {
      var f = excluded(r) ? 0 : (r.free_now || 0);
      var cls = excluded(r) ? "seg-unknown" : "seg-free";
      return '<span class="' + cls + '" style="flex:1 1 0;opacity:' + (excluded(r) ? 1 : Math.max(0.15, f / 100)) + '" data-tip="' + esc(nm(r.email) + ": " + (excluded(r) ? (r.state_code === "AUTH" ? t("c_unknown_token") : t("c_locked_cap")) : pct(f) + " " + t("free_label"))) + '"></span>';
    }).join("") + "</div>";
    var exclTxt = [];
    if (v.auth.length) exclTxt.push(t("c_excl_token", { n: v.auth.length }));
    if (v.capped.length) exclTxt.push(t("c_excl_capped", { n: v.capped.length }));
    var h1 = "≈ " + num1(v.freeSum / 100) + " " + t(is7d ? "c_cycles_7d" : "c_cycles_5h") + (exclN ? " · " + t("c_excluded") + " " + exclTxt.join(", ") : "");

    var soon = v.riskRows.slice().sort(function (a, b) { return ms(a.resets_at) - ms(b.resets_at); })[0];
    var riskHi = Math.min(v.riskMax, v.freeSum);
    var riskLo = Math.min(v.riskSum, riskHi);
    var riskVis = '<div class="bar tall" role="img" aria-label="' + esc(t("c_aria_risk") + (v.riskRough ? ", " + t("c_uncertain_max") + " " + pct(v.riskMax) : "")) + '">' +
      (v.freeSum > 0 ? '<span class="seg-risk" style="flex:' + riskLo.toFixed(1) + ' 1 0"></span>' + (v.riskRough ? '<span class="seg-riskq" style="flex:' + (riskHi - riskLo).toFixed(1) + ' 1 0"></span>' : "") + '<span style="flex:' + Math.max(0, v.freeSum - riskHi).toFixed(1) + ' 1 0;background:transparent"></span>' : "") + "</div>";
    var h2 = soon ? t("c_earliest_at", { time: "<b class=\"num\">" + hmw(ms(soon.resets_at)) + "</b>", who: esc(nm(soon.email)) }) : t("c_nothing_expiring");
    if (v.riskRough) h2 = '<span class="badge b-rough" tabindex="0" role="note" data-tip="' + esc(t("c_risk_rough_tip")) + '"><i></i>' + t("badge_rough_estimate") + '</span> ' + t("c_max_approx", { n: Math.round(v.riskMax) }) + " · " + h2;

    var freshVis = '<div class="legend" style="min-height:14px">' + v.fresh.map(function (r) { return '<span><span class="nm" title="' + esc(r.email) + '">' + esc(nm(r.email)) + "</span></span>"; }).join("") + "</div>";
    var h3 = v.fresh.length ? t(is7d ? "c_cycle_week_starts" : "c_cycle_5h_starts") : t("c_no_idle_acct");

    var attVis = '<div class="legend" style="min-height:14px">' + v.attention.map(function (a) { return '<span title="' + esc(a.email) + '"><span class="nm">' + esc(nm(a.email)) + '</span> <span class="muted">' + esc(a.tags.join(", ")) + "</span></span>"; }).join("") + "</div>";
    var h4 = v.attention.length ? t("c_att_hint") : t("c_no_alerts");

    // the same four figures over the weekly window (rows the server re-analysed over 7 days)
    var ds = v.rows.map(decide);
    var wkU = ds.filter(function (d) { return d.w && d.status !== "capped" && d.status !== "auth"; });
    var free7 = sum(wkU.map(function (d) { return d.f7; }));
    var risk7Rows = wkU.filter(function (d) { return d.w.state_code === "ACTIVE" && wasteOf7(d) >= 1; });
    var risk7 = sum(risk7Rows.map(wasteOf7));
    var soon7 = risk7Rows.slice().sort(function (a, b) { return a.rs7 - b.rs7; })[0];
    var fresh7 = ds.filter(function (d) { return d.w && d.w.state_code === "FRESH" && d.status !== "capped"; });
    var near7 = ds.filter(function (d) { return d.f7 != null && d.f7 < 25; });
    el.innerHTML =
      kpiCard(t("free_now"), pct(v.freeSum) + "<small>/ " + nSel * 100 + "%</small>", freeVis, h1, [pct(free7) + " / " + nSel * 100 + "%", t("c_left_in_week") + (v.rows.length - wkU.length ? " · " + t("c_excluded") + " " + t("c_n_tk", { n: v.rows.length - wkU.length }) : "")]) +
      kpiCard(t("at_risk_label"), v.riskSum > 0 ? pct(v.riskSum, true) : "0%", riskVis, h2, [risk7 > 0 ? "~" + pct(risk7) : "0%", soon7 ? t("c_earliest_lc") + " " + when(soon7.rs7) + " (" + esc(nm(soon7.r.email)) + ")" : t("c_nothing_expiring_lc")]) +
      kpiCard(t("ready_100_label"), String(v.fresh.length) + "<small>" + t("c_acct_unit") + "</small>", freshVis, h3, [t("c_n_tk", { n: fresh7.length }), t("c_week_unopened") + (fresh7.length ? ": " + fresh7.map(function (d) { return esc(nm(d.r.email)); }).join(", ") : "")]) +
      kpiCard(t("attention_label"), String(v.attention.length) + "<small>" + t("c_acct_unit") + "</small>", attVis, h4, [t("c_n_tk", { n: near7.length }), near7.length ? t("c_near_cap") + " " + near7.map(function (d) { return esc(nm(d.r.email)); }).join(", ") : t("c_none_near_cap")]);
  }

  // Snapshots stored before `opportunity.others` existed: derive the same rows from the account rows.
  function deriveOthers(v) {
    var listed = {};
    v.useBefore.concat(v.freshNow, v.exhaust).forEach(function (o) { listed[o.email] = 1; });
    return v.rows.filter(function (r) { return !listed[r.email] && !(r.state_code === "AUTH" && r.auth_state === "expired_idle"); }).map(function (r) {
      var rs = ms(r.resets_at), now = Date.now();
      var when = rs == null ? "" : hmw(rs) + " (" + (rs > now ? t("hours_left", { dur: dur(rs - now) }) : t("past_reset")) + ")";
      var kind = r.state_code === "AUTH" ? "unreadable" : r.weekly_capped ? "weekly_capped" : r.state_code === "COOLDOWN" ? "cooldown" : r.state_code === "FRESH" ? "idle" : "no_action";
      var text = kind === "unreadable" ? t("c_unmeasured") + " · " + (sv(r, "pacing_badge_text") || t("c_att_login"))
        : kind === "weekly_capped" ? t("badge_weekly_cap") + (when ? " · " + t("c_reopen_at") + " " + when : "")
        : kind === "cooldown" ? t("c_out_of_quota", { win: weekView() ? t("c_win_week") : "5h" }) + " · " + t("c_reopen_at") + " " + when
        : kind === "idle" ? t("badge_ready_100") + " · " + t("c_cycle_unopened", { win: weekView() ? t("c_win_week") : "5h" })
        : t("c_no_switch_needed", { free: r.free_now, when: when });
      return { email: r.email, kind: kind, free_now: r.state_code === "AUTH" ? null : r.free_now, text: text };
    }).sort(function (a, b) { return ((b.free_now == null ? -1 : b.free_now) - (a.free_now == null ? -1 : a.free_now)) || (a.email < b.email ? -1 : 1); });
  }
  // ---------- both quotas of one account: 5h (the row itself) and 7d (server weekly overlay) ----------
  function wkRow(r) {
    if (!r || r.state_code === "AUTH" || r.weekly_used == null) return null;
    var o = FULL.subviews && FULL.subviews["7d"] && FULL.subviews["7d"].rows && FULL.subviews["7d"].rows[keyOf(r)];
    return o && o.free_now != null ? Object.assign({}, r, o) : null;
  }
  function free5Of(r) { return r.state_code === "AUTH" ? null : (r.weekly_capped ? 0 : r.free_now); }
  function free7Of(w) { return w ? (w.weekly_capped ? 0 : w.free_now) : null; }
  // Ranking that looks at BOTH windows. Higher score = use this account first.
  //  U7 = what the week will lose, scaled by how soon it resets (primary: 0.45)
  //  U5 = what the 5h window will lose, scaled by how soon it resets (secondary: 0.35)
  //  room = room left right now (weighted 7d > 5h if week exists, else 5h: 0.20)
  //  gate = demote accounts close to the weekly cap (spending them shortens the week)
  //  score = (0.45*U7 + 0.35*U5 + 0.20*room) * gate ; fallback to 5h when w == null (0.80*U5 + 0.20*H5)
  function decide(r) {
    var w = wkRow(r), now = Date.now();
    var wkReady = isWeekResetReady(r, w);
    var h5Ready = is5hResetReady(r);
    var f5 = wkReady || h5Ready ? 100 : free5Of(r);
    var f7 = wkReady ? 100 : free7Of(w);
    var rs5 = ms(r.resets_at), rs7 = w ? ms(w.resets_at) : (r.weekly_resets_at ? ms(r.weekly_resets_at) : (r.weekly_resets_at_passed ? ms(r.weekly_resets_at_passed) : null));
    var d = { r: r, w: w, f5: f5, f7: f7, rs5: rs5, rs7: rs7, score: 0, status: "ready", reasons: [], week_reset_ready: wkReady, five_hour_reset_ready: h5Ready };
    if (r.state_code === "AUTH") { d.status = "auth"; return d; }
    if (!wkReady && (r.weekly_capped || (f7 != null && f7 <= 5))) { d.status = "capped"; d.reopen = r.weekly_capped && r.weekly_resets_at ? ms(r.weekly_resets_at) : rs7; return d; }
    if (!h5Ready && !wkReady && r.state_code === "COOLDOWN" && rs5 != null && rs5 > now) { d.status = "cooldown"; d.reopen = rs5; return d; }
    var rem5 = rs5 != null ? Math.max(0, (rs5 - now) / H) : 5;
    var rem7 = rs7 != null ? Math.max(0, (rs7 - now) / H) : 168;
    var rough5 = isRough(r);
    var waste5 = (!wkReady && !h5Ready && r.state_code === "ACTIVE") ? wLo(r) : 0;
    var waste7 = (!wkReady && w && w.state_code === "ACTIVE") ? (w.at_risk_waste_min != null ? w.at_risk_waste_min : (w.at_risk_waste || 0)) : 0;
    var U5 = Math.min(100, waste5 * (5 / Math.max(rem5, 1)));
    var U7 = Math.min(100, waste7 * clamp(72 / Math.max(rem7, 12), 0.3, 3));
    var H5 = Math.min(100, f5 == null ? 0 : f5);
    var H7 = Math.min(100, f7 == null ? 0 : f7);
    var room = (w || wkReady) && f7 != null ? (0.6 * H7 + 0.4 * H5) : H5;
    var gate = f7 == null ? 1 : clamp(f7 / 25, 0.15, 1);
    if ((w || wkReady) && f7 != null) {
      d.score = (0.45 * U7 + 0.35 * U5 + 0.2 * room) * gate;
    } else {
      d.score = (0.8 * U5 + 0.2 * H5) * gate;
    }
    if (exhaustInfo(r)) { d.status = "warn"; d.score *= 0.5; }
    if (wkReady) d.reasons.push(t("act_week_reset_ready", { time: hm(rs7) }));
    if (f7 != null && f7 < 25 && !wkReady) d.reasons.push(t("c_wk_low", { pct: pct(f7) }));
    if (waste7 >= 10 && !wkReady) d.reasons.push(t("c_wk_waste", { pct: pct(waste7), time: when(rs7) }));
    if ((w && w.state_code === "FRESH" && !r.weekly_capped) || wkReady) d.reasons.push(t("c_wk_unopened_full"));
    if (waste5 >= 10 && !wkReady && !h5Ready) d.reasons.push(t("c_5h_waste", { amt: (rough5 ? "~" + Math.round(waste5) + "–" + pct(wHi(r)) : pct(waste5, approx(r))), time: hm(rs5) }));
    if ((r.state_code === "FRESH" && !r.weekly_capped) || wkReady || h5Ready) d.reasons.push(t("c_5h_unopened_full"));
    return d;
  }
  var STATUS_ORDER = { ready: 0, warn: 0, cooldown: 1, capped: 2, auth: 3 };
  function ranked(rows) {
    return rows.map(decide).sort(function (a, b) {
      var oa = STATUS_ORDER[a.status], ob = STATUS_ORDER[b.status];
      if (oa !== ob) return oa - ob;
      if (oa === 0) return b.score - a.score || String(a.r.email).localeCompare(String(b.r.email));
      return (a.reopen || 0) - (b.reopen || 0) || String(a.r.email).localeCompare(String(b.r.email));
    });
  }
  // one window as a mini block: label, free %, bar, reset
  function wasteOf7(d) { return d.w ? (d.w.at_risk_waste_min != null ? d.w.at_risk_waste_min : (d.w.at_risk_waste || 0)) : 0; }
  function winBlock(label, r, free, rs, bar, overrideNote) {
    var displayLabel = label === "⏱ 5h" ? ICONS.timer + " " + plainLabel("label_5h") : label === "📅 7d" ? ICONS.calendar + " " + plainLabel("label_7d") : label === "📅 30d" ? ICONS.calendar + " " + plainLabel("label_30d") : label;
    var left = rs != null ? (rs > Date.now() ? t("hours_left", { dur: dur(rs - Date.now()) }) : t("past_reset")) : "";
    var note = overrideNote || (rs != null ? "reset <b class=\"num\">" + when(rs) + "</b> · " + left : "—");
    return '<div class="qcol"><div class="qcol-l">' + displayLabel + '</div><div class="qcol-v num">' + (free == null ? "—" : pct(free)) + '<small>' + t("free_label") + '</small></div>' + bar +
      '<div class="qcol-n">' + note + "</div></div>";
  }
  function dualBlock(d) {
    var r = d.r, w = d.w;
    var wkReady = d.week_reset_ready;
    var h5Ready = d.five_hour_reset_ready;
    var b5 = (wkReady || h5Ready) ? barHtml([["free", 100]], "") : barHtml(composition(r), "");
    var b7 = wkReady ? barHtml([["free", 100]], "") : (w ? barHtml(composition(w), "") : barHtml([["unknown", 100]], ""));
    var w7Note = wkReady ? '<span class="t-good">' + t("note_reset_ready", { time: hm(d.rs7) }) + '</span>' : null;
    var w5Note = (wkReady || h5Ready) ? '<span class="t-good">' + t("note_reset_ready", { time: hm(wkReady ? d.rs7 : d.rs5) }) + '</span>' : null;
    var w7 = (w || wkReady) ? winBlock("📅 7d", w || r, d.f7, d.rs7, b7, w7Note) : '<div class="qcol"><div class="qcol-l">' + t("label_7d") + '</div><div class="qcol-v num">—</div>' + b7 + '<div class="qcol-n">' + (r.state_code === "AUTH" ? t("cannot_read") : t("no_weekly_report")) + "</div></div>";
    var provSettings = (getSettings().providers || {})[PROVIDER] || {};
    var has30d = (Array.isArray(provSettings.windows) ? provSettings.windows.indexOf("30d") >= 0 : Boolean(provSettings.windows && provSettings.windows["30d"])) || r.monthly_used_percent != null || PROVIDER === "copilot" || PROVIDER === "cursor";
    var m30 = "";
    if (has30d) {
      var free30 = r.monthly_free != null ? r.monthly_free : (r.monthly_used_percent != null ? Math.max(0, 100 - r.monthly_used_percent) : null);
      var mBar = r.monthly_used_percent != null ? barHtml([["used", r.monthly_used_percent], ["free", Math.max(0, 100 - r.monthly_used_percent)]], "") : barHtml([["unknown", 100]], "");
      m30 = winBlock("📅 30d", r, free30, ms(r.monthly_resets_at), mBar);
    }
    return '<div class="dual">' + w7 + winBlock("⏱ 5h", r, d.f5, d.rs5, b5, w5Note) + m30 + "</div>";
  }
  function actRow(rank, rankCls, e, verb, numHtml, sub, bar, rowCls) {
    return '<div class="act' + (rowCls ? " " + rowCls : "") + '"><div class="rank ' + rankCls + '" aria-hidden="' + (rankCls ? "false" : "true") + '">' + rank + '</div><div class="act-acct">' + chip(e) + '</div><div class="act-main"><div class="act-verb">' + verb + '</div><div class="act-num num">' + numHtml + '</div><div class="act-sub">' + sub + '</div></div><div class="act-bar">' + bar + "</div></div>";
  }
  function renderHero(v) {
    var el = $("hero");
    var list = ranked(v.rows);
    var html = "";
    var firstReady = null;
    list.forEach(function (d) { if (!firstReady && d.status === "ready") firstReady = d; });
    var n = 0;
    list.forEach(function (d) {
      var r = d.r, e = r.email, bar = dualBlock(d);
      if (d.status === "ready" || d.status === "warn") {
        n++;
        var best = d.status === "ready" && n === 1;
        var verb = d.status === "warn" ? t("act_drain_soon") : best ? t("act_use_first") : t("act_use_next");
        var headline = d.reasons.length ? esc(d.reasons[0]) : t("act_normal");
        var sub = d.reasons.slice(1).map(esc).join(" · ");
        if (d.status === "warn") {
          var ei = exhaustInfo(r);
          var alt = null;
          list.forEach(function (o) { if (!alt && o.status === "ready" && o.r !== r) alt = o; });
          headline = "~" + hm(ei.at) + '<span class="unit">' + t("act_exhaust_note", { time: hm(d.rs5) }) + "</span>";
          sub = (alt ? t("act_switch_to", { email: chip(alt.r.email) }) + ' <span class="muted">(' + (alt.f7 == null ? "—" : pct(alt.f7)) + " " + t("label_7d") + " · " + pct(alt.f5) + " 5h)</span>" : t("act_no_alt")) + (d.reasons.length ? " · " + d.reasons.map(esc).join(" · ") : "");
        }
        html += actRow(d.status === "warn" ? "!" : n, d.status === "warn" ? "warn" : "", e, verb, headline, (sub ? sub + " · " : "") + confDots(effConf(r)), bar);
      } else if (d.status === "cooldown") {
        html += actRow("–", "off", e, t("act_wait_5h"), t("c_at") + " " + hm(d.reopen) + '<span class="unit">' + dur(d.reopen - Date.now()) + "</span>", d.f7 != null ? t("c_wk_left", { pct: pct(d.f7) }) : "", bar, "off");
      } else if (d.status === "capped") {
        html += actRow("–", "off", e, t("act_capped_week"), d.reopen ? t("c_reopen") + " " + when(d.reopen) : t("c_reopen_unknown"), "", bar, "off");
      } else {
        html += actRow("?", "q", e, r.auth_state === "expired_idle" ? t("act_token_expired") : t("act_login_required"), "—" + '<span class="unit">' + t("cannot_read") + "</span>", t("act_relogin_guide", { prov: PROV_LABEL }), bar, "off");
      }
    });
    if (!html) html = '<div class="empty"><b>' + t("no_accounts") + '</b>' + t("no_accounts_filter") + '</div>';
    else if (!firstReady) html = '<div class="empty" style="padding:12px 16px"><b style="display:inline;margin-right:6px">' + t("no_ready_accounts") + '</b></div>' + html;
    el.innerHTML = html;
  }

  // ---------- SVG helpers ----------
  function widthOf(id) { var el = $(id); return Math.max(280, Math.floor((el && el.clientWidth) || 600)); }
  function rect(x, y, w, h, fill, extra) {
    if (w <= 0.2 || h <= 0.2) return "";
    return '<rect x="' + x.toFixed(1) + '" y="' + y.toFixed(1) + '" width="' + w.toFixed(1) + '" height="' + h.toFixed(1) + '" fill="' + fill + '"' + (extra || "") + "/>";
  }
  function tipAttr(t) { return ' class="hit" data-tip="' + esc(t) + '"'; }
  function svgText(x, y, s, cls, anchor, extra) { return '<text x="' + x.toFixed(1) + '" y="' + y.toFixed(1) + '"' + (cls ? ' class="' + cls + '"' : "") + (anchor ? ' text-anchor="' + anchor + '"' : "") + (extra || "") + ">" + esc(s) + "</text>"; }
  function txtW(s, size) { return String(s).length * (size || 11) * 0.56; }

  // ---------- 12h agenda: what happens when, in order ----------
  function renderTimeline(v) {
    var host = $("timeline");
    var tl = (S.opportunity || {}).timeline_12h;
    var lanes = (tl && Array.isArray(tl.lanes) ? tl.lanes : []).filter(function (l) { return sel.has(l.email); });
    var now = Date.now(), to = ms(tl && tl.to);
    var ev = [], reopen = 0, lost = 0, nEx = 0;
    lanes.forEach(function (l) {
      if (l.weekly_capped) return;
      var rs = ms(l.resets_at);
      (l.events || []).forEach(function (e) {
        var at = ms(e.at);
        if (at == null || at < now - 60000 || (to != null && at > to)) return;
        if (e.type === "exhaust") {
          nEx++;
          ev.push({ at: at, tone: "danger", email: l.email, title: t("tl_ev_exhaust"), note: rs != null ? t("tl_refill_at", { time: hm(rs), dur: dur(rs - at) }) : "" });
        } else if (e.type === "reset") {
          var hi = e.expiring_percent || 0, lo = e.expiring_percent_min != null ? e.expiring_percent_min : hi;
          var cd = l.state_code === "COOLDOWN";
          reopen += 100;
          if (!cd) lost += lo;
          var loss = cd || hi < 10 ? "" : (e.uncertain && hi - lo >= 1 ? t("tl_may_lose", { lo: Math.round(lo), hi: pct(hi) }) : t("tl_will_lose", { pct: Math.round(hi) }));
          ev.push({ at: at, tone: cd || hi < 10 ? "free" : "risk", email: l.email, title: cd ? t("tl_ev_reset_cd") : t("tl_ev_reset_gain"), note: loss });
        }
      });
    });
    // weekly resets (7d window) of every selected account
    var nWk = 0;
    v.rows.forEach(function (r) {
      var d = decide(r), at = d.rs7;
      if (!d.w || at == null || at < now - 60000) return;
      var capped = d.status === "capped", lostW = wasteOf7(d);
      nWk++;
      ev.push({ at: at, tone: capped || lostW < 10 ? "free" : "risk", email: r.email, wk: true, title: capped ? t("tl_ev_week_reopen") : t("tl_ev_week_reset"),
        note: capped || lostW < 10 ? "" : t("tl_will_lose", { pct: Math.round(lostW) }) });
    });
    if (!ev.length) { host.innerHTML = '<div class="empty"><b>' + t("no_data") + '</b></div>'; return; }
    ev.sort(function (a, b) { return a.at - b.at; });
    var dot = { free: "var(--free)", risk: "var(--risk)", danger: "var(--danger)" };
    var sumTxt = t("c_tl_sum", { n5: ev.length - nWk, nwk: nWk, reopen: Math.round(reopen) }) + (lost >= 10 ? ' · <span class="t-warn">' + t("c_tl_lost", { pct: Math.round(lost) }) + "</span>" : "") + (nEx ? ' · <span class="t-bad">' + t("c_tl_exhaust_n", { n: nEx }) + "</span>" : "");
    host.innerHTML = '<div class="cap" style="margin-bottom:6px">' + sumTxt + "</div>" + ev.map(function (e) {
      return '<div style="display:grid;grid-template-columns:78px 14px minmax(0,1fr) auto;gap:10px;align-items:center;padding:7px 0;border-top:1px solid var(--line, rgba(128,128,128,.18))">' +
        '<span class="num" style="font-weight:700">' + (e.wk ? when(e.at) : hm(e.at)) + "</span>" +
        '<i style="width:10px;height:10px;border-radius:3px;background:' + dot[e.tone] + '"></i>' +
        "<div>" + chip(e.email) + ' <span class="badge b-auth" style="padding:0 6px">' + (e.wk ? t("c_badge_7d") : "5h") + "</span> <span>" + esc(e.title) + "</span>" + (e.note ? ' <span class="' + (e.tone === "risk" ? "t-warn" : "muted") + '">· ' + esc(e.note) + "</span>" : "") + "</div>" +
        '<span class="muted num" style="white-space:nowrap">' + t("tl_after", { dur: dur(Math.max(0, e.at - now)) }) + "</span></div>";
    }).join("");
  }

  // ---------- account cards ----------
  // ---------- machines (who MEASURES an account; quota itself is per account) ----------
  // Lateness is judged against the real clock (the snapshot only refreshes when a report arrives).
  // Limits come from the server: ~20 min for the latest client, ~40 min for old ones.
  function lateMin(m) {
    var lv = ms(m.last_valid);
    var lim = m.late_after_min || 20;
    if (lv == null) return { min: null, lim: lim };
    var d = Math.round((Date.now() - lv) / 60000);
    return d > lim ? { min: d, lim: lim } : null;
  }
  function machStatus(m) {
    if (m.status === "error") return "error";
    return lateMin(m) || m.last_valid == null ? "silent" : "ok";
  }
  function machBadge(m) {
    var st = machStatus(m);
    if (st === "error") return '<span class="badge b-auth"><i></i>' + t("c_last_err", { kind: esc(m.last_error_kind || t("c_err_lc")) }) + "</span>";
    if (st === "silent") {
      var l = lateMin(m);
      return l && l.min != null
        ? '<span class="badge b-late" title="' + esc(t("c_late_limit_tip", { lim: l.lim })) + '"><i></i>' + t("c_late", { dur: esc(dur(l.min * 60000)), lim: l.lim }) + "</span>"
        : '<span class="badge b-late"><i></i>' + t("c_unmeasured") + '</span>';
    }
    return '<span class="badge b-fresh"><i></i>' + t("c_reporting") + '</span>';
  }
  // Account-level: freshest valid measurement among its machines vs that machine's limit
  function acctLate(r) {
    if (!r || r.state_code === "AUTH") return null;
    var best = null;
    machList(r).forEach(function (m) { var lv = ms(m.last_valid); if (lv != null && (!best || lv > best.lv)) best = { lv: lv, lim: m.late_after_min || 20 }; });
    if (!best) return null;
    var d = Math.round((Date.now() - best.lv) / 60000);
    return d > best.lim ? { min: d, lim: best.lim } : null;
  }
  // Silence: no valid number for longer than the machine limit. The last numbers are then only a lower bound
  // (usage only grows inside a window), so show the age and a range, and trust the prediction less.
  function silenceOf(r) {
    var l = r.stale ? { min: Math.round((Date.now() - (ms(r.last_report_at) || Date.now())) / 60000), lim: 20 } : acctLate(r);
    return l || null;
  }
  function effConf(r) {
    var l = silenceOf(r), c = r.confidence;
    if (!l) return c;
    if (l.min > l.lim * 2) return "low";
    return c === "high" ? "medium" : c;
  }
  function silenceNote(r) {
    var l = r.state_code === "ACTIVE" ? silenceOf(r) : null;
    if (!l) return "";
    var best = null;
    machList(r).forEach(function (m) { var lv = ms(m.last_valid); if (lv != null && (best == null || lv > best)) best = lv; });
    var used = r.used_percent || 0;
    var hi = Math.min(100, used + (r.velocity || 0) * l.min / 60);
    return '<div class="card-note" style="margin-top:4px"><span class="t-q" title="' + esc(t("c_silence_tip", { lim: l.lim })) + '">' + esc(t("c_silence_text", { time: best != null ? when(best) : "?", ago: dur(l.min * 60000), range: pct(used) + "–" + pct(hi) })) + "</span></div>";
  }
  function lateBadge(r) {
    var l = r.stale ? null : acctLate(r);
    return l ? ' <span class="badge b-late" title="' + esc(t("c_stale_tip", { lim: l.lim })) + '"><i></i>' + t("c_stale_fig", { dur: esc(dur(l.min * 60000)) }) + "</span>" : "";
  }
  function updWhyMap() { return { gh_missing: t("c_upd_gh_missing"), gh_unauthenticated: t("c_upd_gh_unauth"), unverified_commit: t("c_upd_unverified"), disabled: t("c_upd_disabled"), current: t("c_upd_waiting"), skipped_recent: t("c_upd_waiting") }; }
  function updWhy(m) {
    var st = m && m.update_status;
    if (!st) return t("c_upd_none");
    var why = updWhyMap();
    if (why[st]) return why[st];
    if (st.indexOf("failed:") === 0) return t("c_upd_failed", { err: st.slice(7) });
    return st;
  }
  function resolveMachName(m) {
    if (!m) return t("c_machine_lc");
    if (m.known_label) return m.known_label;
    var mid = String(m.machine_id || "").trim().toLowerCase();
    var ids = String(m.id_short || "").trim().toLowerCase().replace(/^#/, "");
    var raw = String(m.name_key ? sv(m, "name") : (m.name || m.machine_name || "")).trim();
    var low = raw.toLowerCase();
    var dyn = getDynamicMachineLabels();
    for (var dk in dyn) {
      if (!dyn[dk]) continue;
      var dkl = dk.trim().toLowerCase();
      if (mid && (mid === dkl || mid.indexOf(dkl) === 0)) return dyn[dk];
      if (ids && ids === dkl) return dyn[dk];
      if (low === dkl || low.indexOf(dkl) >= 0) return dyn[dk];
    }
    return raw.replace(/\.local$/i, "") || (m.machine_id && m.machine_id !== "unknown" ? t("c_machine_lc") + " " + String(m.machine_id).slice(0, 6) : t("c_machine_lc"));
  }
  function isMappedMach(name) {
    var dyn = getDynamicMachineLabels();
    for (var dk in dyn) {
      if (dyn[dk] === name) return true;
    }
    return false;
  }
  function machOutdated(m) { return m && m.outdated ? '<div class="muted" style="grid-column:1/-1;font-size:12px">' + t("c_outdated", { why: esc(updWhy(m)) }) + "</div>" : ""; }
  function machPlace(m) { var t = [m.country, m.ip].filter(function (x) { return typeof x === "string" && x; }).join(" · "); return t || "—"; }
  function machName(m) {
    var name = resolveMachName(m);
    if (isMappedMach(name)) {
      return '<b title="' + esc(name + (m.os ? " · " + m.os : "")) + '">' + esc(name) + "</b>";
    }
    return '<b>' + esc(name) + "</b>" + (m.os ? ' <span class="muted">' + esc(m.os) + "</span>" : "") + (m.id_short && m.id_short !== "—" ? ' <span class="muted num" title="' + esc(t("c_machine_id")) + '">#' + esc(m.id_short) + "</span>" : "");
  }
  function machList(r) { return Array.isArray(r && r.active_machines) ? r.active_machines : (Array.isArray(r && r.machines) ? r.machines : []); }
  function detachedMachList(r) { return Array.isArray(r && r.detached_machines) ? r.detached_machines : []; }
  function machAgo(d) {
    if (d == null || !isFinite(d)) return "—";
    var m = Math.max(0, Math.round(d / 60000));
    if (m < 1) return t("time_just_now");
    if (m < 60) return t("time_minutes_ago", { m: m });
    var h = Math.floor(m / 60);
    var rem = m % 60;
    if (h < 24) return rem ? t("c_ago_hours_rem", { h: h, rem: rem }) : t("c_ago_hours", { h: h });
    return t("time_days_ago", { d: Math.floor(h / 24) });
  }
  function machConn(m, refNow) {
    if (!m) return "offline";
    if (m.connectivity) return m.connectivity;
    if (m.status === "error") return "error";
    var t = ms(m.last_seen) || ms(m.last_valid) || 0;
    if (!t) return "offline";
    var diff = Math.max(0, refNow - t);
    if (diff <= 20 * 60000) return "online";
    if (diff <= 120 * 60000) return "idle";
    return "offline";
  }
  function connLabel(conn) {
    if (conn === "online") return t("c_conn_online");
    if (conn === "idle") return t("c_conn_idle");
    if (conn === "error") return t("c_conn_error");
    return t("c_conn_offline");
  }
  function cardMachHtml(r, refNow) {
    var act = machList(r);
    var det = detachedMachList(r);

    if (act.length > 0) {
      return '<div class="card-machs">' + act.map(function (m) {
        var conn = machConn(m, refNow);
        var t = ms(m.last_seen) || ms(m.last_valid);
        var relTime = t ? machAgo(refNow - t) : "—";
        var absTime = t ? when(t) : "—";
        var name = resolveMachName(m);
        var tip = isMappedMach(name)
          ? esc(name + (m.os ? " · " + m.os : "") + " · " + connLabel(conn) + " · " + tx("c_last_ping", { abs: absTime, rel: relTime }) + (m.ip ? " · IP: " + m.ip : ""))
          : esc(name + (m.id_short && m.id_short !== "—" ? " (#" + m.id_short + ")" : "") + (m.os ? " · " + m.os : "") + " · " + connLabel(conn) + " · " + tx("c_last_ping", { abs: absTime, rel: relTime }) + (m.ip ? " · IP: " + m.ip : ""));
        return '<span class="mach-pill mconn-' + conn + '" title="' + tip + '">' +
          '<i class="conn-dot"></i>' +
          '<span class="mach-pill-name">' + ICONS.monitor + ' ' + esc(name) + '</span>' +
          '<span class="mach-pill-sep">•</span>' +
          '<span class="mach-pill-time num">' + esc(relTime) + '</span>' +
        '</span>';
      }).join("") + '</div>';
    }

    if (det.length > 0) {
      var lastM = det[0];
      var t = ms(lastM.last_seen_here || lastM.last_seen);
      var relTime = t ? machAgo(refNow - t) : "—";
      var absTime = t ? when(t) : "—";
      var dest = lastM.moved_to ? nm(lastM.moved_to) : tx("c_other_acct");
      var name = resolveMachName(lastM);
      var tip = esc(tx("c_moved_tip", { name: name, to: lastM.moved_to || tx("c_other_account"), at: lastM.moved_at ? " " + tx("c_at") + " " + when(ms(lastM.moved_at)) : "", abs: absTime, rel: relTime }));
      return '<div class="card-machs">' +
        '<span class="mach-pill mconn-detached" title="' + tip + '">' +
          '<i class="conn-dot"></i>' +
          '<span class="mach-pill-name">' + tx("c_no_active_mach") + '</span>' +
          '<span class="mach-pill-sep">•</span>' +
          '<span class="mach-pill-time">' + tx("c_moved_to_short", { dest: esc(dest) }) + (t ? ' (' + tx("c_before") + ': ' + esc(name) + ' · ' + esc(relTime) + ')' : '') + '</span>' +
        '</span>' +
      '</div>';
    }

    var lr = ms(r.last_report_at);
    var tip = esc(tx("c_no_mach_info") + (lr ? " · " + tx("c_last_report_at") + " " + when(lr) : ""));
    return '<div class="card-machs">' +
      '<span class="mach-pill mconn-none" title="' + tip + '">' +
        '<i class="conn-dot"></i>' +
        '<span class="mach-pill-name">' + tx("c_no_mach") + '</span>' +
        (lr ? '<span class="mach-pill-sep">•</span><span class="mach-pill-time">' + tx("c_updated") + ' ' + esc(machAgo(refNow - lr)) + '</span>' : '') +
      '</span>' +
    '</div>';
  }
  function machChip(r) {
    var act = machList(r);
    var det = detachedMachList(r);
    if (act.length > 0) {
      return '<span class="mchip mchip-on" title="' + esc(t("c_n_machs_using", { n: act.length })) + '"><i></i>' + t("c_n_mach", { n: act.length }) + "</span>";
    }
    if (det.length > 0) {
      return '<span class="mchip mchip-off" title="' + esc(t("c_acct_left_mach")) + '"><i></i>' + t("c_n_mach", { n: 0 }) + "</span>";
    }
    return "";
  }
  function machDrawerHtml(r) {
    var act = machList(r);
    var det = detachedMachList(r);
    if (!act.length && !det.length) return '<div class="empty">' + t("c_no_mach_reported") + '</div>';
    var c = Math.max(Date.now(), ms(r.computed_at) || 0);
    function seen(m) { var t = ms(m.last_seen); return t == null ? "—" : machAgo(c - t); }
    function measured(m) { var t = ms(m.last_valid); return t == null ? tx("c_unmeasured_lc") : tx("c_measured", { at: when(t), ago: machAgo(c - t) }); }
    var html = "";
    if (act.length) {
      html += '<div style="font-size:12px;font-weight:700;color:var(--ink-2);margin:10px 0 6px">' + t("c_active_machs", { n: act.length }) + '</div>' +
        '<div class="mach-cards">' + act.map(function (m) {
          return '<div class="wl-card"><div>' + machName(m) + '</div><div style="text-align:right">' + machBadge(m) + '</div><div class="muted num" title="' + esc(t("c_first_seen") + " " + when(ms(m.first_seen))) + '">' + esc(measured(m)) + " · ping " + esc(seen(m)) + '</div><div class="muted num" style="text-align:right">' + m.reports_ok + " ok / " + m.reports_err + ' ' + t("c_err_lc") + '</div><div class="muted num">' + esc(m.client_version ? "v" + m.client_version : t("client_old")) + '</div><div class="muted num" style="text-align:right;word-break:break-all">' + esc(machPlace(m)) + "</div>" + machOutdated(m) + "</div>";
        }).join("") + "</div>";
    }
    if (det.length) {
      html += '<div style="font-size:12px;font-weight:700;color:var(--muted);margin:14px 0 6px">' + t("c_prev_machs", { n: det.length }) + '</div>' +
        '<div class="mach-cards">' + det.map(function (m) {
          var tHere = ms(m.last_seen_here || m.last_seen);
          return '<div class="wl-card" style="opacity:0.85"><div>' + machName(m) + '</div><div style="text-align:right"><span class="badge b-late"><i></i>' + t("c_moved_to", { who: esc(nm(m.moved_to)) }) + '</span></div><div class="muted num">' + t("c_last_ping_here") + ' ' + esc(tHere ? when(tHere) + " (" + machAgo(c - tHere) + ")" : "—") + '</div><div class="muted num" style="text-align:right">' + t("c_moved_at") + ' ' + esc(when(ms(m.moved_at))) + '</div><div class="muted num">' + esc(m.client_version ? "v" + m.client_version : t("client_old")) + '</div><div class="muted num" style="text-align:right;word-break:break-all">' + esc(machPlace(m)) + '</div></div>';
        }).join("") + "</div>";
    }
    return html;
  }
  function renderMachines(v) {
    var host = $("mach");
    if (!host) return;
    var accts = v.sorted;
    var byId = {};
    accts.forEach(function (r) {
      var act = machList(r);
      var det = detachedMachList(r);
      act.forEach(function (m) {
        var name = resolveMachName(m);
        var midKey = isMappedMach(name) ? "mapped:" + name.toLowerCase() : m.machine_id;
        var o = byId[midKey] || (byId[midKey] = { id: m.machine_id, name: name, os: m.os, id_short: isMappedMach(name) ? name : m.id_short, raw_name: isMappedMach(name) ? null : m.raw_name, known_label: m.known_label, seen: 0, cells: {} });
        var t = ms(m.last_seen) || 0;
        if (t >= o.seen) { o.seen = t; o.name = name; o.os = m.os; }
        o.cells[r.email] = { ...m, is_current: true };
        if (m.outdated && t >= o.seen) { o.outdated = true; o.update_status = m.update_status; }
        else if (t >= o.seen) { o.outdated = false; }
      });
      det.forEach(function (m) {
        var name = resolveMachName(m);
        var midKey = isMappedMach(name) ? "mapped:" + name.toLowerCase() : m.machine_id;
        var o = byId[midKey] || (byId[midKey] = { id: m.machine_id, name: name, os: m.os, id_short: isMappedMach(name) ? name : m.id_short, raw_name: isMappedMach(name) ? null : m.raw_name, known_label: m.known_label, seen: 0, cells: {} });
        var t = ms(m.last_seen_here || m.last_seen) || 0;
        if (t > o.seen) { o.seen = t; o.name = name; o.os = m.os; }
        if (!o.cells[r.email]) {
          o.cells[r.email] = { ...m, is_current: false };
        }
      });
    });
    var rows = Object.keys(byId).map(function (k) { return byId[k]; }).sort(function (a, b) { return b.seen - a.seen; });
    var head = '<div class="cap" style="margin-bottom:10px">' + esc(t("c_mach_cap")) + "</div>";
    if (!rows.length) { host.innerHTML = head + '<div class="empty">' + t("c_no_mach_data") + '</div>'; return; }
    function cell(m) {
      if (!m) return '<span class="muted">—</span>';
      var lv = ms(m.last_valid);
      if (m.is_current === false) {
        return '<span class="muted num" style="text-decoration:line-through;opacity:0.65" title="' + esc(t("c_moved_cell_tip", { who: nm(m.moved_to), time: when(lv) })) + '">' + esc(lv == null ? t("c_unmeasured_lc") : when(lv)) + " (" + t("c_moved_lc") + ")</span>";
      }
      var st = machStatus(m);
      var mark = st === "ok" ? "" : st === "error" ? " " + ICONS["triangle-alert"] : " " + ICONS.timer;
      return '<span class="num" title="' + esc(st === "ok" ? t("c_reporting") : st === "silent" ? t("c_late_cell_tip", { lim: m.late_after_min || 20 }) : t("c_last_err", { kind: m.last_error_kind || "" })) + '"' + (st === "ok" ? "" : ' style="color:var(--ink);font-weight:700;text-decoration:underline dotted"') + ">" + esc(lv == null ? t("c_unmeasured_lc") : when(lv)) + (st === "ok" ? "" : mark) + "</span>";
    }
    var tbl = '<div class="tbl-wrap"><table class="tbl"><thead><tr><th>' + t("mach_title") + '</th>' + accts.map(function (r) { return '<th class="r">' + esc(nm(r.email)) + "</th>"; }).join("") + "</tr></thead><tbody>" + rows.map(function (o) {
      return "<tr><td>" + machName(o) + (o.outdated ? '<div class="muted" style="font-size:12px">' + t("c_outdated", { why: esc(updWhy(o)) }) + "</div>" : "") + "</td>" + accts.map(function (r) { return '<td class="r">' + cell(o.cells[r.email]) + "</td>"; }).join("") + "</tr>";
    }).join("") + "</tbody></table></div>";
    var cards = '<div class="wl-cards">' + rows.map(function (o) {
      return '<div class="wl-card" style="grid-template-columns:1fr"><div>' + machName(o) + "</div>" + (o.outdated ? '<div class="muted" style="font-size:12px">' + t("c_outdated", { why: esc(updWhy(o)) }) + "</div>" : "") + accts.filter(function (r) { return o.cells[r.email]; }).map(function (r) {
        return '<div style="display:flex;justify-content:space-between;gap:8px"><span>' + chip(r.email) + "</span>" + cell(o.cells[r.email]) + "</div>";
      }).join("") + "</div>";
    }).join("") + "</div>";
    host.innerHTML = head + tbl + cards + '<div class="cap" style="margin-top:8px">' + t("c_mach_foot") + '</div>';
  }

  // one-line status of one window (r = the 5h row, or the 5h row overlaid with its weekly analysis)
  function windowNote(r, rough) {
    var rs = ms(r.resets_at), now = Date.now();
    var remTxt = rs != null ? (rs > now ? t("hours_left", { dur: dur(rs - now) }) : t("past_reset")) : "";
    var ei = exhaustInfo(r);
    if (r.state_code === "AUTH") return esc(r.auth_state === "expired_idle" ? t("c_token_idle", { pct: pct(r.used_percent) }) : (sv(r, "auth_label") || t("badge_auth_login")));
    if (r.five_hour_disabled) return fhdNote(r);
    if (r.weekly_capped) return t("c_locked_by_cap") + (r.weekly_resets_at ? " · " + t("c_reopen") + " " + when(ms(r.weekly_resets_at)) : "");
    if (r.state_code === "FRESH") return t("c_cycle_not_open") + (r.idle_since ? " · " + t("c_idle_since") + " " + when(ms(r.idle_since)) : "");
    if (r.state_code === "COOLDOWN") return '<span class="t-bad">' + t("c_recovers_at", { time: '<b class="num">' + when(rs) + "</b>" }) + "</span> · " + remTxt;
    if (ei) return '<span class="t-bad">' + (ei.already ? t("c_may_be_empty") : t("c_empty_at", { time: when(ei.at) })) + "</span> · reset " + when(rs) + " (" + remTxt + ")";
    if (isRough(r)) return '<span class="t-warn">' + t("c_may_surplus", { amt: "<b>" + wasteTxt(r) + "</b>" }) + "</span> " + t("c_at") + " " + when(rs) + " · " + remTxt + " " + roughBadge(r);
    if ((r.at_risk_waste || 0) > 0.5) return '<span class="t-warn">' + t("c_will_lose", { amt: "<b>" + pct(r.at_risk_waste, approx(r)) + "</b>" }) + " " + t("c_at") + " " + when(rs) + "</span> · " + remTxt;
    return '<span class="t-good">' + t("c_used_before_reset", { time: when(rs) }) + "</span>";
  }
  // burn speed vs the even pace that would use exactly 100% of the window (20%/h for 5h, 100/7 %/day for 7d):
  // <= pace green, up to 2x pace yellow, above 2x red with a strong warning
  function speedHtml(v, pace, unit, win, conf, extraCls) {
    var tone = v <= pace ? "t-good" : v <= pace * 2 ? "t-warn" : "spd-hot";
    var pulse = (extraCls && (tone === "t-warn" || tone === "spd-hot")) ? " " + extraCls : "";
    var tip = t("c_speed_tip", { win: win, v: num1(v) + unit, pace: num1(pace) + unit }) + (tone === "spd-hot" ? " · " + t("c_speed_hot", { x: num1(v / pace) }) : tone === "t-warn" ? " · " + t("c_speed_fast") : " · " + t("c_speed_ok"));
    return '<span class="' + tone + pulse + '" title="' + esc(tip) + '">' + (tone === "spd-hot" ? ICONS["triangle-alert"] + " " : "") + num1(v) + unit + "</span> " + confDots(conf);
  }
  // the provider reset this quota by hand: the pace below is measured from that moment
  function resetTag(iso) {
    var t = ms(iso);
    return t == null ? "" : '<span class="badge b-fresh" style="margin-right:4px" title="' + esc(tx("c_provider_reset_tip", { time: when(t) })) + '"><i></i>↺ reset ' + esc(when(t)) + "</span>";
  }
  function cardCol(label, r, free, noteHtml, resetIso, barOverride) {
    var displayLabel = label === "⏱ 5h" ? ICONS.timer + " " + plainLabel("label_5h") : label === "📅 7d" ? ICONS.calendar + " " + plainLabel("label_7d") : label === "📅 30d" ? ICONS.calendar + " " + plainLabel("label_30d") : label;
    var bar = barOverride || barHtml(composition(r), "");
    return '<div class="qcol"><div class="qcol-l">' + displayLabel + '</div><div class="qcol-v num">' + (free == null ? "—" : pct(free)) + "<small>" + (free == null ? t("unknown_label") : t("free_label")) + "</small></div>" +
      bar + '<div class="qcol-n">' + resetTag(resetIso) + noteHtml + "</div></div>";
  }
  function renderCards(v) {
    var el = $("cards");
    if (!v.sorted.length) { el.innerHTML = '<div class="empty"><b>' + t("no_accounts") + '</b>' + t("no_accounts_prompt") + '</div>'; return; }
    var ref = Math.max(Date.now(), ms(S.computed_at) || 0);
    el.innerHTML = ranked(v.rows).map(function (d) {
      var r = d.r, w = d.w;
      var wkReady = d.week_reset_ready;
      var h5Ready = d.five_hour_reset_ready;
      var rate = r.state_code === "ACTIVE" ? speedHtml(r.velocity, 100 / 5, "%/h", "5h", effConf(r)) : '<span class="muted">—</span>';
      var rate7 = w && w.state_code === "ACTIVE" && w.velocity != null ? speedHtml(w.velocity * 24, 100 / 7, t("c_unit_per_day"), t("c_win_7d"), w.confidence, "rate-pulse") : '<span class="muted">—</span>';
      var lr = ms(r.last_report_at);
      var age = lr != null ? agoShort(ref - lr) : "—";
      var wkBar = wkReady ? barHtml([["free", 100]], "") : (w ? barHtml(composition(w), "") : barHtml([["unknown", 100]], ""));
      var wkNote = wkReady ? '<span class="t-good">' + t("note_reset_ready", { time: hm(d.rs7) }) + '</span>' : (w ? windowNote(w) : null);
      var wkCol = (w || wkReady) ? cardCol("📅 7d", w || r, d.f7, wkNote, r.reset_weekly_at, wkBar) :
        '<div class="qcol"><div class="qcol-l">' + t("label_7d") + '</div><div class="qcol-v num">—<small>' + t("unknown_label") + '</small></div>' + barHtml([["unknown", 100]], "") +
        '<div class="qcol-n muted">' + (r.state_code === "AUTH" ? t("cannot_read") : t("no_weekly_report")) + "</div></div>";
      var h5Bar = (wkReady || h5Ready) ? barHtml([["free", 100]], "") : null;
      var h5Note = (wkReady || h5Ready) ? '<span class="t-good">' + t("note_reset_ready", { time: hm(wkReady ? d.rs7 : d.rs5) }) + '</span>' : windowNote(r);

      var provSettings = (getSettings().providers || {})[PROVIDER] || {};
      var has30d = (Array.isArray(provSettings.windows) ? provSettings.windows.indexOf("30d") >= 0 : Boolean(provSettings.windows && provSettings.windows["30d"])) || r.monthly_used_percent != null || PROVIDER === "copilot" || PROVIDER === "cursor";
      var monthCol = "";
      if (has30d) {
        var free30 = r.monthly_free != null ? r.monthly_free : (r.monthly_used_percent != null ? Math.max(0, 100 - r.monthly_used_percent) : null);
        var mBar = r.monthly_used_percent != null ? barHtml([["used", r.monthly_used_percent], ["free", Math.max(0, 100 - r.monthly_used_percent)]], "") : barHtml([["unknown", 100]], "");
        var mRs = ms(r.monthly_resets_at);
        var mNote = mRs != null ? ("reset " + when(mRs)) : (r.monthly_used_percent != null ? (t("c_used_lc") + " " + pct(r.monthly_used_percent)) : "—");
        monthCol = cardCol("📅 30d", r, free30, mNote, null, mBar);
      }

      var metaRow = '<div><div class="meta-l">' + t("speed_7d") + '</div><div class="meta-v num">' + rate7 + '</div></div>' +
           '<div><div class="meta-l">' + t("speed_5h") + '</div><div class="meta-v num">' + rate + '</div></div>' +
           '<div><div class="meta-l">' + t("report_label") + '</div><div class="meta-v" title="' + esc(t("client_ver", { ver: r.client_version ? "v" + r.client_version : t("client_old") }) + " · " + when(lr)) + '">' + esc(age) + ' <span class="muted ver">' + esc(r.client_version ? "v" + r.client_version : t("client_old")) + '</span></div></div>';

      return '<div class="card" role="button" tabindex="0" data-open="' + esc(keyOf(r)) + '" aria-label="' + esc(nm(r.email)) + '">' +
        '<div class="card-h">' + chip(r.email) + '<span style="display:flex;gap:6px;align-items:center;flex-wrap:wrap;justify-content:flex-end">' + machChip(r) + badge(r) + "</span></div>" +
        '<div class="dual">' + wkCol + cardCol("⏱ 5h", r, d.f5, h5Note, r.reset_5h_at, h5Bar) + monthCol + "</div>" +
        '<div class="slot">' + silenceNote(r) + authWarnHtml(r) + "</div>" +
        '<div class="slot">' + cardMachHtml(r, ref) + "</div>" +
        '<div class="card-meta">' + metaRow + '</div>' +
        "</div>";
    }).join("");
  }

  // ---------- machine stats & telemetry (per-machine usage and efficiency) ----------
  function renderNowMachineStats() {
    var host = document.getElementById("machStatsNow");
    if (!host) return;
    var mList = Array.isArray(FULL.machine_stats) ? FULL.machine_stats : [];
    if (!mList.length) {
      host.innerHTML = '<div class="empty">' + t("c_no_mach_stats_hint") + '</div>';
      return;
    }
    var now = Date.now();
    var is7d = weekView();
    var cardsHtml = mList.map(function (m) {
      var name = m.friendly_label || resolveMachName(m);
      var conn = m.connectivity || "offline";
      var connBadge = conn === "online" ? '<span class="badge b-fresh"><i></i>Online</span>' :
                      conn === "idle" ? '<span class="badge b-rough"><i></i>' + t("c_conn_idle_short") + '</span>' :
                      conn === "error" ? '<span class="badge b-cap"><i></i>' + t("c_error_short") + '</span>' :
                      '<span class="badge b-late"><i></i>Offline</span>';
      var intTone = m.intensity === "high" ? "intensity-high" :
                    m.intensity === "moderate" ? "intensity-med" : "intensity-idle";
      var intLabel = m.intensity === "high" ? t("mach_int_high") :
                     m.intensity === "moderate" ? t("mach_int_mod") :
                     m.intensity === "unknown" ? t("mach_int_unknown") :
                     m.intensity === "idle" ? "💤 " + (sv(m, "intensity_label") || t("mach_int_idle")) : t("mach_int_offline");
      var intBadge = '<span class="intensity-badge ' + intTone + '">' + intLabel + '</span>';

      var acctHtml = "";
      if (m.active_account) {
        var q = m.active_quota || {};
        var used = is7d ? (q.weekly_used != null ? q.weekly_used : q.used_percent) : q.used_percent;
        var reset = is7d ? q.weekly_resets_at : q.resets_at;
        var free = used != null ? clamp(100 - used, 0, 100) : null;
        var resetTxt = reset ? (is7d ? t("c_weekly_reset_lc") + " " + when(ms(reset)) : "reset " + hm(ms(reset))) : "";
        acctHtml = '<div style="margin-top:4px">' +
          '<div style="font-size:11.5px;color:var(--muted);font-weight:600;margin-bottom:2px">' + t("mach_holding_title") + '</div>' +
          '<div style="display:flex;align-items:center;justify-content:space-between;gap:8px">' +
            chip(m.active_account) +
            (used != null ? '<span class="num font-semibold" style="font-size:13px">' + pct(used) + ' ' + t("c_used_short") + ' <span class="muted font-normal">(' + pct(free) + ' ' + t("free_label") + ')</span></span>' : '<span class="muted">—</span>') +
          '</div>' +
          (resetTxt ? '<div class="muted num" style="font-size:11px;margin-top:2px">' + esc(resetTxt) + '</div>' : '') +
        '</div>';
      } else {
        acctHtml = '<div style="margin-top:4px">' +
          '<div style="font-size:11.5px;color:var(--muted);font-weight:600;margin-bottom:2px">' + t("mach_holding_title") + '</div>' +
          '<div class="muted" style="font-size:13px">' + t("mach_no_holding") + '</div>' +
        '</div>';
      }

      var touched = Array.isArray(m.accounts_touched) ? m.accounts_touched : [];
      var touchedHtml = "";
      if (touched.length > 0) {
        touchedHtml = '<div style="margin-top:6px">' +
          '<div style="font-size:11.5px;color:var(--muted);font-weight:600;margin-bottom:4px">' + t("mach_rotation", { count: touched.length }) + '</div>' +
          '<div style="display:flex;flex-wrap:wrap;gap:4px">' +
          touched.map(function (at) {
            if (at.is_active) {
              return '<span class="mach-chip-active" title="' + esc(t("mach_logged_in")) + '">● ' + esc(nm(at.email)) + '</span>';
            } else {
              var tHere = ms(at.last_seen_here);
              return '<span class="mach-chip-dim" title="' + esc(t("mach_previously_used", { time: tHere ? when(tHere) : '—' })) + '">○ ' + esc(nm(at.email)) + '</span>';
            }
          }).join("") +
          '</div>' +
        '</div>';
      }

      var tokByAcct = touched.filter(function (at) { return at.tokens && (at.tokens.input + at.tokens.output) > 0; })
        .sort(function (a, b) { return (b.tokens.input + b.tokens.output) - (a.tokens.input + a.tokens.output); });
      var tokTotal = tokByAcct.reduce(function (n, at) { return n + at.tokens.input + at.tokens.output; }, 0);
      var tokFmt = function (n) { return n >= 1000000 ? (n / 1000000).toFixed(1) + "M" : n >= 1000 ? Math.round(n / 1000) + "k" : String(n); };
      var tokAcctHtml = tokByAcct.length ? '<div style="margin-top:6px">' +
        '<div style="font-size:11.5px;color:var(--muted);font-weight:600;margin-bottom:4px">' + t("mach_tokens_by_acct") + '</div>' +
        tokByAcct.map(function (at) {
          var tot = at.tokens.input + at.tokens.output;
          var share = tokTotal ? Math.round(tot / tokTotal * 100) : 0;
          return '<div style="display:flex;justify-content:space-between;gap:8px;font-size:12px;margin-top:2px" title="' +
            esc(tokFmt(at.tokens.input) + " in / " + tokFmt(at.tokens.output) + " out · " + at.tokens.msgs + " msg") + '">' +
            '<span>' + esc(nm(at.email)) + '</span>' +
            '<span class="num"><b>' + tokFmt(tot) + '</b> <span class="muted">(' + share + '%)</span></span></div>';
        }).join("") + '</div>' : "";

      var telem = m.telemetry;
      var tk1 = m.usage_tokens_1h;
      var burnTxt = tk1 == null ? "—" : (tk1 >= 1000000 ? (tk1 / 1000000).toFixed(1) + "M" : tk1 >= 1000 ? Math.round(tk1 / 1000) + "k" : String(tk1)) + " token/h";
      var telemHtml = "";
      if (telem && (telem.total_tokens > 0 || telem.total_messages > 0)) {
        var tokStr = telem.total_tokens >= 1000000 ? (telem.total_tokens / 1000000).toFixed(1) + "M" :
                     telem.total_tokens >= 1000 ? Math.round(telem.total_tokens / 1000) + "k" : telem.total_tokens;
        var inTok = telem.input_tokens >= 1000 ? Math.round(telem.input_tokens / 1000) + "k" : (telem.input_tokens || 0);
        var outTok = telem.output_tokens >= 1000 ? Math.round(telem.output_tokens / 1000) + "k" : (telem.output_tokens || 0);
        telemHtml = '<div style="margin-top:6px;padding-top:6px;border-top:1px dashed var(--line);font-size:12px">' +
          '<div style="display:flex;justify-content:space-between;color:var(--ink)">' +
            '<span><b>' + tokStr + '</b> tokens</span>' +
            '<span class="muted">(' + inTok + ' in / ' + outTok + ' out)</span>' +
          '</div>' +
          (telem.total_messages ? '<div class="muted" style="font-size:11px;margin-top:2px">' + telem.total_messages + ' ' + t("c_messages") + ' · ' + (telem.total_sessions || 0) + ' ' + t("c_sessions") + '</div>' : '') +
        '</div>';
      }

      var ls = ms(m.last_seen);
      var seenStr = ls ? machAgo(now - ls) : "—";
      var footer = '<div class="mach-stat-meta">' +
        '<div><span class="meta-l" title="' + esc(t("mach_usage_rate_tip")) + '">' + t("mach_usage_rate") + '</span><div class="meta-v num">' + esc(burnTxt) + '</div></div>' +
        '<div><span class="meta-l">' + t("mach_last_ping") + '</span><div class="meta-v" title="' + (ls ? when(ls) : '') + '">' + esc(seenStr) + '</div></div>' +
        '<div><span class="meta-l">' + t("mach_reports") + '</span><div class="meta-v num">' + m.reports_ok + ' ok / ' + m.reports_err + ' err</div></div>' +
        '<div><span class="meta-l">Client</span><div class="meta-v">' + esc(m.client_version ? "v" + m.client_version : t("client_old")) + '</div></div>' +
      '</div>';

      return '<div class="mach-stat-card">' +
        '<div class="mach-stat-h">' +
          '<div class="mach-stat-title">' + ICONS.monitor + ' ' + esc(name) + (m.os ? ' <span class="muted font-normal text-xs" style="font-size:11.5px">' + esc(m.os) + '</span>' : '') + '</div>' +
          '<div style="display:flex;gap:4px;align-items:center">' + intBadge + connBadge + '</div>' +
        '</div>' +
        acctHtml +
        touchedHtml +
        tokAcctHtml +
        telemHtml +
        footer +
      '</div>';
    }).join("");

    host.innerHTML = '<div class="mach-stats-grid">' + cardsHtml + '</div>';
  }

  function renderHistMachineStats() {
    var host = document.getElementById("machStatsHist");
    if (!host) return;
    var mList = Array.isArray(FULL.machine_stats) ? FULL.machine_stats : [];
    if (!mList.length) {
      host.innerHTML = '<div class="empty">' + t("mach_no_stats") + '</div>';
      return;
    }
    var now = Date.now();
    var rows = mList.map(function (m) {
      var name = m.friendly_label || resolveMachName(m);
      var conn = m.connectivity || "offline";
      var connBadge = conn === "online" ? '<span class="badge b-fresh"><i></i>Online</span>' :
                      conn === "idle" ? '<span class="badge b-rough"><i></i>' + t("c_conn_idle_short") + '</span>' :
                      '<span class="badge b-late"><i></i>Offline</span>';
      var intTone = m.intensity === "high" ? "intensity-high" :
                    m.intensity === "moderate" ? "intensity-med" : "intensity-idle";
      var intLabel = m.intensity === "high" ? t("mach_int_high") :
                     m.intensity === "moderate" ? t("mach_int_mod") :
                     m.intensity === "unknown" ? t("mach_int_unknown") :
                     m.intensity === "idle" ? "💤 " + (sv(m, "intensity_label") || t("mach_int_idle")) : t("mach_int_offline");
      var intBadge = '<span class="intensity-badge ' + intTone + '">' + intLabel + '</span>';

      var curAcct = m.active_account ? chip(m.active_account) : '<span class="muted">—</span>';
      var quotaVal = (m.active_quota && m.active_quota.used_percent != null) ? pct(m.active_quota.used_percent) : "—";

      var touched = Array.isArray(m.accounts_touched) ? m.accounts_touched : [];
      var touchedChips = touched.map(function (at) {
        return at.is_active ? '<span class="mach-chip-active">● ' + esc(nm(at.email)) + '</span>' :
               '<span class="mach-chip-dim">○ ' + esc(nm(at.email)) + '</span>';
      }).join(" ");

      var telem = m.telemetry;
      var tokStr = (telem && telem.total_tokens > 0) ?
        (telem.total_tokens >= 1000000 ? (telem.total_tokens / 1000000).toFixed(1) + "M" : Math.round(telem.total_tokens / 1000) + "k") : "—";

      var ls = ms(m.last_seen);
      var seenStr = ls ? machAgo(now - ls) : "—";

      return '<tr>' +
        '<td><b>' + ICONS.monitor + ' ' + esc(name) + '</b>' + (m.os ? ' <span class="muted">' + esc(m.os) + '</span>' : '') + '</td>' +
        '<td>' + connBadge + ' ' + intBadge + '</td>' +
        '<td>' + curAcct + '</td>' +
        '<td class="r num">' + quotaVal + '</td>' +
        '<td><div style="display:flex;flex-wrap:wrap;gap:4px">' + (touchedChips || '<span class="muted">—</span>') + '</div></td>' +
        '<td class="r num font-semibold">' + tokStr + '</td>' +
        '<td class="r num muted">' + m.reports_ok + ' ok / ' + m.reports_err + ' err</td>' +
        '<td class="r muted" title="' + (ls ? when(ls) : '') + '">' + esc(seenStr) + '</td>' +
      '</tr>';
    }).join("");

    var tbl = '<div class="tbl-wrap"><table class="tbl"><thead><tr>' +
      '<th>' + t("mach_title") + '</th>' +
      '<th>' + t("mach_status") + '</th>' +
      '<th>' + t("mach_holding") + '</th>' +
      '<th class="r">' + t("mach_quota_now") + '</th>' +
      '<th>' + t("mach_rotation", { count: "" }).replace(/\(\s*\)/, "").trim() + '</th>' +
      '<th class="r">' + t("mach_tokens") + '</th>' +
      '<th class="r">' + t("mach_reports") + '</th>' +
      '<th class="r">' + t("mach_last_ping") + '</th>' +
    '</tr></thead><tbody>' + rows + '</tbody></table></div>';

    host.innerHTML = tbl;
  }

  // ---------- heatmap (shared by history tab + drawer) ----------
  function heatColor(frac) { return "color-mix(in oklab, var(--risk) " + Math.round(4 + clamp(frac, 0, 1) * 96) + "%, var(--surface))"; }
  function heatmapSvg(hostId, rowsDef) {
    var W = widthOf(hostId);
    var narrow = W < 560;
    var LW = narrow ? 58 : 96;
    var cw = (W - LW) / 24;
    var ch = narrow ? 20 : 24;
    var out = [];
    for (var hgt = 0; hgt < 24; hgt += narrow ? 3 : 2) out.push(svgText(LW + hgt * cw + cw / 2, 11, pad(hgt), "", "middle"));
    rowsDef.forEach(function (rd, i) {
      var y = 18 + i * (ch + 2) + (rd.team ? 6 : 0);
      var lbl = rd.label.length > (narrow ? 7 : 12) ? rd.label.slice(0, narrow ? 6 : 11) + "…" : rd.label;
      out.push(svgText(0, y + ch / 2 + 4, lbl, "ink", "start", rd.team ? ' font-weight="700"' : ' font-weight="500"'));
      for (var hh = 0; hh < 24; hh++) {
        var val = rd.values[hh] || 0;
        var frac = val / rd.max;
        var tip = rd.label + " · " + pad(hh) + ":00–" + pad((hh + 1) % 24) + ":00\n~" + num1(val) + "% " + t("c_hm_tip") + (rd.max ? " (" + t("c_hm_cap", { pct: Math.round(frac * 100) }) + ")" : "");
        out.push(rect(LW + hh * cw + 1, y, cw - 2, ch, heatColor(frac), tipAttr(tip) + ' rx="3"'));
      }
    });
    var Hh = 18 + rowsDef.length * (ch + 2) + 10;
    return '<svg width="' + W + '" height="' + Hh + '" viewBox="0 0 ' + W + " " + Hh + '" role="img" aria-label="' + esc(t("c_aria_heatmap")) + '">' + out.join("") + "</svg>";
  }
  function goldenText(team) {
    var idx = team.map(function (v, i) { return { h: i, v: v }; }).filter(function (o) { return o.v > 0; })
      .sort(function (a, b) { return b.v - a.v || a.h - b.h; }).slice(0, 3).map(function (o) { return o.h; }).sort(function (a, b) { return a - b; });
    if (!idx.length) return "";
    var ranges = [], s = idx[0], p = idx[0];
    for (var i = 1; i <= idx.length; i++) {
      if (i < idx.length && idx[i] === p + 1) { p = idx[i]; continue; }
      ranges.push(pad(s) + "–" + pad((p + 1) % 24) + "h");
      if (i < idx.length) { s = p = idx[i]; }
    }
    return ranges.join(", ");
  }
  function hmRowsFor(emails, withTeam) {
    var hm0 = S.heatmap || {};
    var acc = Array.isArray(hm0.accounts) ? hm0.accounts : [];
    var rows = [];
    var team = new Array(24).fill(0);
    var order = emails;
    order.forEach(function (e) {
      var a = acc.filter(function (x) { return x.email === e; })[0];
      if (!a || !Array.isArray(a.values)) return;
      for (var i = 0; i < 24; i++) team[i] += +a.values[i] || 0;
      rows.push({ email: e, label: nm(e), values: a.values, max: 20 });
    });
    if (withTeam && rows.length > 1) rows.push({ team: true, label: t("c_whole_team"), values: team, max: 20 * rows.length });
    return { rows: rows, team: team };
  }

  // ---------- weekly basis ----------
  // An account with a weekly quota is measured per closed week (its 5h cycles are capped by the weekly limit, so
  // "5h waste" is not meaningful for it); accounts without one keep the 5h-cycle statistics.
  var WK_SHOWN = 4;
  function wkAll() { return (FULL.history_weekly && Array.isArray(FULL.history_weekly.weeks)) ? FULL.history_weekly.weeks : []; }
  function wkClosed(r) {
    var key = keyOf(r);
    return wkAll().filter(function (w) { return w.account_key === key; }).sort(function (a, b) { return ms(a.end_at) - ms(b.end_at); }).slice(-WK_SHOWN);
  }
  function isWk(r) { return r.weekly_used != null || wkClosed(r).length > 0; }
  // used/lost in "weekly quotas of one account" (1 = a whole week's quota)
  function wkStats(r) {
    var c = wkClosed(r);
    if (!c.length) return { n: 0 };
    var u = sum(c.map(function (w) { return clamp(w.final_used, 0, 100); })) / 100;
    var l = sum(c.map(function (w) { return clamp(w.waste, 0, 100); })) / 100;
    return { n: c.length, used: u, lost: l, efficiency: u + l > 0 ? u / (u + l) * 100 : null };
  }
  function histKpisWeekly(wrows) {
    var st = wrows.map(function (r) { return { r: r, s: wkStats(r) }; }).filter(function (x) { return x.s.n > 0; });
    var U = sum(st.map(function (x) { return x.s.used; })), L = sum(st.map(function (x) { return x.s.lost; })), N = sum(st.map(function (x) { return x.s.n; }));
    var eff = U + L > 0 ? U / (U + L) * 100 : null;
    var effBar = U + L > 0 ? '<div class="bar tall"><span class="seg-used" style="flex:' + U + ' 1 0"></span><span class="seg-risk" style="flex:' + L + ' 1 0"></span></div>' : "";
    var worst = st.slice().sort(function (a, b) { return b.s.lost - a.s.lost; })[0];
    var hint0 = t("c_no_closed_week");
    return kpiCard(t("hist_eff"), eff == null ? "—" : '<span class="' + effTone(eff) + '">' + pct(eff) + "</span>", effBar, N ? t("c_cap_used") + " · " + t("c_wk_basis", { n: N }) : hint0) +
      kpiCard(t("hist_waste"), N ? "≈ " + num1(L) + "<small>" + t("c_weeks_unit") + "</small>" : "—", N ? '<div class="bar tall"><span class="seg-risk" style="flex:' + L + ' 1 0"></span></div>' : "", N ? t("c_wk_waste_hint") : hint0) +
      kpiCard(t("hist_wk_closed"), N + "<small>" + t("c_wk_short") + "</small>", "", N ? t("c_wk_closed_hint", { a: st.length }) : hint0) +
      kpiCard(t("hist_worst"), worst ? '<span class="acct" style="font-size:24px"><span class="tr" title="' + esc(worst.r.email) + '">' + esc(nm(worst.r.email)) + "</span></span>" : "—", "", worst ? t("c_wk_worst_hint", { n: num1(worst.s.lost), eff: pct(worst.s.efficiency) }) : "");
  }

  // ---------- tab "Lịch sử 14 ngày" ----------
  function renderHistory(v) {
    var emails = v.sorted.map(function (r) { return r.email; });
    var rows = v.rows;
    var st = rows.map(function (r) { return r.stats_14d || {}; });
    var U = sum(st.map(function (s) { return s.used_windows; })), Wd = sum(st.map(function (s) { return s.wasted_windows; })), I = sum(st.map(function (s) { return s.idle_windows; }));
    var cap = U + Wd + I;
    var eff = cap > 0 ? U / cap * 100 : null;
    var effHi = cap > 0 ? sum(st.map(function (s) { return (s.efficiency_max != null ? s.efficiency_max : s.efficiency || 0) / 100 * ((s.used_windows || 0) + (s.wasted_windows || 0) + (s.idle_windows || 0)); })) / cap * 100 : null;
    var unkW = sum(st.map(function (s) { return s.uncertain_windows; })), silentH = sum(st.map(function (s) { return s.silent_hours; }));
    var idleH = sum(st.map(function (s) { return s.idle_hours; }));
    var worst = rows.slice().sort(function (a, b) { var x = a.stats_14d || {}, y = b.stats_14d || {}; return ((y.wasted_windows || 0) + (y.idle_windows || 0)) - ((x.wasted_windows || 0) + (x.idle_windows || 0)); })[0];
    var ws = worst && worst.stats_14d;
    var lowEff = rows.filter(function (r) { return r.stats_14d && r.stats_14d.efficiency != null; }).sort(function (a, b) { return a.stats_14d.efficiency - b.stats_14d.efficiency; })[0];
    var effBar = cap > 0 ? '<div class="bar tall" data-tip="' + esc(t("c_eff_tip", { u: num1(U), w: num1(Wd), i: num1(I) })) + '"><span class="seg-used" style="flex:' + U + ' 1 0"></span><span class="seg-risk" style="flex:' + Wd + ' 1 0"></span><span class="seg-idle" style="flex:' + I + ' 1 0"></span></div>' : "";
    var wasteBar = cap > 0 ? '<div class="bar tall"><span class="seg-risk" style="flex:' + Wd + ' 1 0"></span><span class="seg-idle" style="flex:' + I + ' 1 0"></span></div>' : "";
    // Observed span per account (heatmap.observed_days), not a flat 14 days: history may be only hours old.
    var hmAcc = (S.heatmap && Array.isArray(S.heatmap.accounts)) ? S.heatmap.accounts : [];
    var obsDays = emails.map(function (e) { var a = hmAcc.filter(function (x) { return x.email === e; })[0]; return a && a.observed_days ? Math.min(14, +a.observed_days) : 0; });
    var obsH = Math.round(sum(obsDays) * 24);
    var maxDays = obsDays.length ? Math.max.apply(null, obsDays) : 0;
    var spanText = maxDays >= 13.5 ? t("c_14_days") : t("c_days_of_data", { n: num1(maxDays) }) + (maxDays < 3 ? " (" + t("c_still_thin") + ")" : "");
    var hoursBar = '<div class="bar tall"><span class="seg-idle" style="flex:' + Math.min(idleH, obsH) + ' 1 0"></span><span style="flex:' + Math.max(0, obsH - idleH) + ' 1 0;background:transparent"></span></div>';
    $("histKpis").innerHTML =
      kpiCard(t("hist_eff"), eff == null ? "—" : '<span class="' + effTone(eff) + '">' + effText(eff, effHi) + "</span>", effBar, t("c_cap_used") + " · " + spanText + (unkW ? " · " + t("c_unk_cycles", { n: unkW, h: Math.round(silentH) }) : "")) +
      kpiCard(t("hist_waste"), "≈ " + num1(Wd + I) + "<small>" + t("c_cycles_unit") + "</small>", wasteBar, t("c_waste_hint", { w: num1(Wd), i: num1(I) })) +
      kpiCard(t("hist_idle_h"), Math.round(idleH) + "<small>" + t("c_hours_unit") + "</small>", hoursBar, t("c_over_h", { n: obsH })) +
      kpiCard(t("hist_worst"), worst ? '<span class="acct" style="font-size:24px"><span class="tr" title="' + esc(worst.email) + '">' + esc(nm(worst.email)) + "</span></span>" : "—", "", ws ? t("c_worst_hint", { n: num1((ws.wasted_windows || 0) + (ws.idle_windows || 0)), eff: pct(ws.efficiency) }) + (lowEff && lowEff !== worst ? " · " + t("c_lowest_pct") + " " + esc(nm(lowEff.email)) + " " + effText(lowEff.stats_14d.efficiency, lowEff.stats_14d.efficiency_max) : "") : "");

    var wrows = rows.filter(isWk);
    if (wrows.length) $("histKpis").innerHTML = histKpisWeekly(wrows);
    renderWeekHist(v);
    renderWeekWaste(wrows);
    renderDaily(emails);
    var hmd = hmRowsFor(emails, true);
    var hmHost = $("heatmap");
    hmHost.innerHTML = hmd.rows.length ? heatmapSvg("heatmap", hmd.rows) : '<div class="empty"><b>' + t("c_no_hour_data") + '</b>' + t("c_need_closed_cycle") + '</div>';
    var gt = goldenText(hmd.team);
    $("golden").innerHTML = gt ? t("hist_golden", { ranges: "<b>" + gt + "</b>" }) : "";
    renderEfficiency(v.sorted);
    renderWindowLog();
  }
  // ---------- weekly quota history: closed weeks per account + the week in progress ----------
  function renderWeekHist(v) {
    var host = $("weekHist");
    var all = (FULL.history_weekly && Array.isArray(FULL.history_weekly.weeks)) ? FULL.history_weekly.weeks : [];
    var closedAll = [];
    var html = v.sorted.map(function (r) {
      var key = keyOf(r);
      var closed = all.filter(function (w) { return w.account_key === key; }).sort(function (a, b) { return ms(a.end_at) - ms(b.end_at); }).slice(-4);
      closedAll = closedAll.concat(closed);
      var cells = closed.map(function (w) {
        var u = clamp(w.final_used, 0, 100), lost = clamp(w.waste, 0, 100 - u);
        return '<div class="wk-cell"><div class="wk-l">' + esc(dm(ms(w.start_at)) + " – " + dm(ms(w.end_at))) + '</div>' +
          barHtml([["used", u], ["risk", lost]], "") +
          '<div class="wk-n num">' + t("c_used_short") + ' <b>' + pct(u) + '</b> · ' + t("c_lost_short") + ' <span class="' + (lost >= 30 ? "t-warn" : "muted") + '">' + pct(lost) + "</span></div></div>";
      }).join("");
      var wr = ms(r.weekly_resets_at);
      var cur;
      if (r.weekly_used == null) cur = '<div class="wk-cell wk-cur"><div class="wk-l">' + t("week_this_week") + '</div>' + barHtml([["unknown", 100]], "") + '<div class="wk-n muted">' + t("c_no_week_figure") + '</div></div>';
      else {
        var cu = clamp(r.weekly_used, 0, 100);
        cur = '<div class="wk-cell wk-cur"><div class="wk-l">' + t("week_running") + (r.reset_weekly_at ? " " + resetTag(r.reset_weekly_at) : "") + "</div>" + barHtml([["used", cu]], "") +
          '<div class="wk-n num">' + t("c_used_short") + ' <b>' + pct(cu) + "</b>" + (wr != null ? ' · reset <b>' + esc(when(wr)) + "</b>" : "") + "</div></div>";
      }
      var note = closed.length ? "" : '<div class="wk-none">' + t("c_no_closed_week") + (wr != null ? " · " + t("c_first_closes_at") + " " + esc(when(wr)) : "") + "</div>";
      return '<div class="wk-row"><div class="wk-acct">' + chip(r.email) + '</div><div class="wk-cells">' + cells + cur + "</div>" + note + "</div>";
    }).join("");
    if (!html) { host.innerHTML = '<div class="empty"><b>' + t("no_accounts") + '</b></div>'; return; }
    var U = sum(closedAll.map(function (w) { return w.final_used; })), n = closedAll.length;
    var head = n ? '<div class="cap" style="margin-bottom:8px">' + t("week_closed_sum", { n: "<b>" + n + "</b>", used: "<b>" + pct(U / n) + "</b>", waste: "<b>" + pct(100 - U / n) + "</b>" }) + "</div>"
      : '<div class="cap" style="margin-bottom:8px">' + t("week_start_hint") + '</div>';
    host.innerHTML = head + html;
  }
  // Wasted weekly quota per calendar week (Mon-Sun, GMT+7) of the closed weeks of the accounts that have one.
  function renderWeekWaste(wrows) {
    var host = $("weekWaste"), sec = $("weekWasteSec");
    wrows = wrows.filter(function (r) { return sel.has(r.email); });
    sec.style.display = wrows.length ? "" : "none";
    if (!wrows.length) return;
    var buckets = {};
    wrows.forEach(function (r) {
      wkClosed(r).forEach(function (w) {
        var d = g7(ms(w.end_at) - 1), dow = (d.getUTCDay() + 6) % 7;
        var start = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - dow) - TZ;
        var b = buckets[start] || (buckets[start] = { start: start, per: [] });
        b.per.push({ email: r.email, lost: clamp(w.waste, 0, 100) / 100 });
      });
    });
    var rows = Object.keys(buckets).map(function (k) { var b = buckets[k]; b.lost = sum(b.per.map(function (o) { return o.lost; })); return b; }).sort(function (a, b) { return b.start - a.start; });
    if (!rows.length) { host.innerHTML = '<div class="empty"><b>' + t("c_no_closed_week") + "</b>" + t("week_start_hint") + "</div>"; $("weekWasteLegend").innerHTML = ""; return; }
    var maxV = Math.max(0.5, Math.max.apply(null, rows.map(function (r) { return r.lost; })));
    host.innerHTML = rows.map(function (r) {
      var label = dm(r.start) + "–" + dm(r.start + 6 * 86400000);
      var top = r.per.slice().sort(function (a, b) { return b.lost - a.lost; })[0];
      var tip = label + ": " + t("c_week_waste_tip", { tot: num1(r.lost) }) + "\n" + r.per.filter(function (o) { return o.lost > 0.005; }).map(function (o) { return nm(o.email) + " " + num1(o.lost); }).join(" · ");
      return '<div style="display:grid;grid-template-columns:118px minmax(0,1fr) auto;gap:10px;align-items:center;padding:4px 0" data-tip="' + esc(tip) + '">' +
        '<span class="muted num">' + esc(label) + "</span>" +
        '<div class="bar" style="width:' + Math.max(2, r.lost / maxV * 100).toFixed(1) + '%"><span class="seg-risk" style="flex:' + r.lost.toFixed(2) + ' 1 0"></span></div>' +
        '<span class="num" style="white-space:nowrap">' + (r.lost < 0.05 ? "0" : "≈ " + num1(r.lost)) + (top && r.lost >= 0.5 ? ' <span class="muted">· ' + esc(nm(top.email)) + " " + t("c_most") + "</span>" : "") + "</span></div>";
    }).join("");
    $("weekWasteLegend").innerHTML = '<span><span class="sw seg-risk"></span>' + t("c_legend_week_lost") + "</span>";
  }
  function renderDaily(emails) {
    var host = $("daily");
    var h = S.history_14d || {};
    var days = Array.isArray(h.days) ? h.days : [];
    var wkEmails = {};
    FULL.accounts.forEach(function (r) { if (isWk(r)) wkEmails[r.email] = 1; });
    var daily = (Array.isArray(h.daily) ? h.daily : []).filter(function (d) { return sel.has(d.email) && !wkEmails[d.email]; });
    $("dailySec").style.display = !daily.length && Object.keys(wkEmails).length ? "none" : "";
    if (!days.length || !daily.length) { host.innerHTML = '<div class="empty"><b>' + t("c_no_history") + '</b>' + t("c_history_hint") + '</div>'; $("dailyLegend").innerHTML = ""; return; }
    var rows = days.map(function (d, di) {
      var per = daily.map(function (a) { return { email: a.email, w: (+(a.waste_pct || [])[di] || 0) / 100, i: (+(a.idle_h || [])[di] || 0) / 5 }; });
      return { d: d, per: per, w: sum(per.map(function (o) { return o.w; })), i: sum(per.map(function (o) { return o.i; })) };
    });
    var first = 0;
    while (first < rows.length - 1 && rows[first].w + rows[first].i < 0.005) first++;
    rows = rows.slice(first).reverse();
    var maxV = Math.max(0.5, Math.max.apply(null, rows.map(function (r) { return r.w + r.i; })));
    host.innerHTML = rows.map(function (r) {
      var tot = r.w + r.i;
      var top = r.per.slice().sort(function (a, b) { return (b.w + b.i) - (a.w + a.i); })[0];
      var tip = r.d + ": " + t("c_daily_tip", { tot: num1(tot), w: num1(r.w), i: num1(r.i) }) + "\n" + r.per.filter(function (o) { return o.w + o.i > 0.005; }).map(function (o) { return nm(o.email) + " " + num1(o.w + o.i); }).join(" · ");
      return '<div style="display:grid;grid-template-columns:44px minmax(0,1fr) auto;gap:10px;align-items:center;padding:4px 0" data-tip="' + esc(tip) + '">' +
        '<span class="muted num">' + esc(r.d) + "</span>" +
        '<div class="bar" style="width:' + Math.max(2, tot / maxV * 100).toFixed(1) + '%"><span class="seg-risk" style="flex:' + r.w.toFixed(2) + ' 1 0"></span><span class="seg-idle" style="flex:' + r.i.toFixed(2) + ' 1 0"></span></div>' +
        '<span class="num" style="white-space:nowrap">' + (tot < 0.05 ? "0" : "≈ " + num1(tot)) + (top && tot >= 0.5 ? ' <span class="muted">· ' + esc(nm(top.email)) + " " + t("c_most") + "</span>" : "") + "</span></div>";
    }).join("");
    $("dailyLegend").innerHTML = '<span><span class="sw seg-risk"></span>' + t("c_legend_lost") + '</span><span><span class="sw seg-idle"></span>' + t("c_legend_idle") + '</span>';
  }
  function renderEfficiency(rows) {
    var host = $("eff");
    var effOf = function (r) { if (isWk(r)) { var w = wkStats(r); return w.n ? w.efficiency || 0 : -1; } return r.stats_14d.efficiency || 0; };
    var list = rows.filter(function (r) { return r.stats_14d || isWk(r); }).slice().sort(function (a, b) { return effOf(b) - effOf(a); });
    if (!list.length) { host.innerHTML = '<div class="empty"><b>' + t("no_data") + '</b></div>'; return; }
    host.innerHTML = list.map(function (r) {
      if (isWk(r)) return effRowWeekly(r);
      var s = r.stats_14d;
      var parts = [["used", s.used_windows || 0], ["risk", s.wasted_windows || 0], ["idle", s.idle_windows || 0]];
      var tot = sum(parts.map(function (p) { return p[1]; }));
      var tip = nm(r.email) + " · " + t("c_eff_acct_tip", { used: num1(s.used_windows), w: num1(s.wasted_windows), i: num1(s.idle_windows), h: Math.round(s.idle_hours || 0), n: s.windows_closed || 0, avg: pct(s.avg_waste_per_window) });
      return '<div style="display:grid;grid-template-columns:minmax(64px,110px) minmax(0,1fr) 48px;gap:10px;align-items:center;padding:6px 0"><div>' + chip(r.email) + '<div class="muted" style="font-size:11px">' + t("c_lost_cycles", { n: num1((s.wasted_windows || 0) + (s.idle_windows || 0)) }) + "</div></div>" +
        '<div class="bar tall" data-tip="' + esc(tip) + '" role="img" aria-label="' + esc(tip.replace(/\n/g, ", ")) + '">' + (tot > 0 ? parts.map(function (p) { return '<span class="seg-' + p[0] + '" style="flex:' + p[1].toFixed(2) + ' 1 0"></span>'; }).join("") : "") + "</div>" +
        '<div class="num ' + effTone(s.efficiency) + '" style="text-align:right;font-weight:700;white-space:nowrap" title="' + esc(effNote(s)) + '">' + effText(s.efficiency, s.efficiency_max) + "</div></div>";
    }).join("");
  }
  function effRowWeekly(r) {
    var w = wkStats(r);
    var left = '<div>' + chip(r.email) + '<div class="muted" style="font-size:11px">' + (w.n ? t("c_lost_wk", { n: num1(w.lost) }) : t("c_no_closed_week")) + "</div></div>";
    if (!w.n) return '<div style="display:grid;grid-template-columns:minmax(64px,110px) minmax(0,1fr) 48px;gap:10px;align-items:center;padding:6px 0">' + left + '<div class="bar tall"></div><div class="num muted" style="text-align:right">—</div></div>';
    var tip = nm(r.email) + " · " + t("c_eff_wk_tip", { used: num1(w.used), w: num1(w.lost), n: w.n, avg: pct(w.used / w.n * 100) });
    return '<div style="display:grid;grid-template-columns:minmax(64px,110px) minmax(0,1fr) 48px;gap:10px;align-items:center;padding:6px 0">' + left +
      '<div class="bar tall" data-tip="' + esc(tip) + '" role="img" aria-label="' + esc(tip.replace(/\n/g, ", ")) + '"><span class="seg-used" style="flex:' + w.used.toFixed(2) + ' 1 0"></span><span class="seg-risk" style="flex:' + w.lost.toFixed(2) + ' 1 0"></span></div>' +
      '<div class="num ' + effTone(w.efficiency) + '" style="text-align:right;font-weight:700;white-space:nowrap">' + pct(w.efficiency) + "</div></div>";
  }
  function effText(lo, hi) { return lo == null ? "—" : hi != null && hi - lo >= 2 ? Math.round(lo) + "–" + Math.round(hi) + "%" : pct(lo); }
  function effNote(s) {
    var t = [];
    if (s.uncertain_windows) t.push(tx("c_eff_unc", { n: s.uncertain_windows, h: Math.round(s.silent_hours || 0) }));
    if (s.weekly_binding) t.push(tx("c_eff_weekly", { used: Math.round(s.weekly_used), h: Math.round(s.idle_excluded_hours || 0) }));
    return t.join(" · ");
  }
  function effTone(v) { return v == null ? "" : v >= 75 ? "t-good" : v >= 50 ? "t-warn" : "t-bad"; }
  function fmtRange(s, e) { return dm(s) + " " + hm(s) + "–" + (dayKey(s) === dayKey(e) ? "" : dm(e) + " ") + hm(e); }
  function windowsFor(filterFn, limit) {
    var w = (S.history_14d || {}).windows;
    return (Array.isArray(w) ? w : []).filter(filterFn).slice(0, limit);
  }
  function miniUsed(u) { return '<div class="bar" style="width:70px;display:inline-flex;vertical-align:middle"><span class="seg-used" style="flex:' + clamp(u, 0, 100) + ' 1 0"></span><span class="seg-risk" style="flex:' + (100 - clamp(u, 0, 100)) + ' 1 0"></span></div>'; }
  function renderWindowLog() {
    var list = windowsFor(function (w) { return sel.has(w.email); }, 50);
    var host = $("wlog");
    if (!list.length) { host.innerHTML = '<div class="empty"><b>' + t("c_no_closed_cycle") + '</b>' + t("c_cycle_closes_when") + '</div>'; return; }
    var tbl = '<div class="tbl-wrap"><table class="tbl"><thead><tr><th>' + t("c_th_time") + '</th><th>' + t("account") + '</th><th>' + t("seg_used") + '</th><th class="r">' + t("c_th_waste") + '</th><th class="r">' + t("c_th_err") + '</th></tr></thead><tbody>' +
      list.map(function (w) {
        return "<tr><td class=\"num\">" + fmtRange(w.start, w.end) + "</td><td>" + chip(w.email) + '</td><td class="num">' + miniUsed(w.used) + " " + pct(w.used) + '</td><td class="r num">' + pct(w.waste) + '</td><td class="r num muted">±' + Math.round(w.unc || 0) + "m</td></tr>";
      }).join("") + "</tbody></table></div>";
    var cards = '<div class="wl-cards">' + list.map(function (w) {
      return '<div class="wl-card"><div>' + chip(w.email) + '</div><div class="num" style="text-align:right">' + fmtRange(w.start, w.end) + '</div><div>' + miniUsed(w.used) + ' <span class="num">' + pct(w.used) + '</span></div><div class="num" style="text-align:right">' + t("c_lost_short") + ' ' + pct(w.waste) + ' <span class="muted">±' + Math.round(w.unc || 0) + "m</span></div></div>";
    }).join("") + "</div>";
    host.innerHTML = tbl + cards;
  }

  // ---------- drawer ----------
  var drawerKey = null;
  var lastFocus = null;
  function openDrawer(e) {
    drawerKey = e;
    lastFocus = document.activeElement;
    document.getElementById("scrim").hidden = false;
    document.getElementById("drawer").hidden = false;
    renderDrawer();
    var c = document.getElementById("drawerClose");
    if (c) c.focus();
  }
  function closeDrawer() {
    drawerKey = null;
    document.getElementById("scrim").hidden = true;
    document.getElementById("drawer").hidden = true;
    if (lastFocus && lastFocus.focus) { try { lastFocus.focus(); } catch (e) {} }
  }
  function burnSvg(r) {
    var host = document.getElementById("burn");
    var ws = ms(r.window_start), rs = ms(r.resets_at), c = ms(r.computed_at);
    if (r.five_hour_disabled) {
      host.innerHTML = '<div class="empty"><b>' + tx("badge_weekly_cap_fhd") + "</b>" + tx("c_5h_off") + (rs != null ? " " + tx("c_at") + " " + when(rs) : "") + ".</div>";
      return;
    }
    if (r.state_code === "FRESH" || r.state_code === "AUTH" || ws == null || rs == null) {
      host.innerHTML = '<div class="empty"><b>' + (r.state_code === "AUTH" ? tx("c_cannot_read_quota") : tx("c_cycle_not_open")) + "</b>" + (r.state_code === "AUTH" ? tx("c_relogin_prov", { prov: PROV_LABEL }) : tx("c_5h_starts_used")) + "</div>";
      return;
    }
    var W = widthOf("burn"), Hc = 210, padL = 34, padR = 10, padT = 12, padB = 24;
    function X(t) { return padL + (clamp(t, ws, rs) - ws) / (rs - ws) * (W - padL - padR); }
    function Y(v) { return padT + (1 - clamp(v, 0, 100) / 100) * (Hc - padT - padB); }
    var out = [];
    [0, 25, 50, 75, 100].forEach(function (g) {
      out.push('<line class="' + (g === 0 ? "axis" : "grid") + '" x1="' + padL + '" x2="' + (W - padR) + '" y1="' + Y(g) + '" y2="' + Y(g) + '"' + (g === 100 ? ' style="stroke:var(--danger);stroke-opacity:.55"' : "") + "/>");
      out.push(svgText(padL - 6, Y(g) + 4, g + "%", "", "end"));
    });
    for (var t = Math.ceil(ws / H) * H; t < rs; t += H) out.push(svgText(X(t), Hc - 6, hm(t), "", "middle"));
    var used = clamp(r.used_percent || 0, 0, 100);
    var cx = X(c);
    if (r.state_code === "ACTIVE") {
      var remH = Math.max(0, (rs - c) / H);
      var ex = ms(r.exhaust_at);
      if (r.confidence !== "high") {
        var rates = [r.rate_window, r.rate_recent, r.velocity].filter(function (x) { return x != null && isFinite(x); });
        var lo = Math.min.apply(null, rates.length ? rates : [0]), hi = Math.max.apply(null, rates.length ? rates : [0]);
        if (hi - lo < 0.5) { lo = (r.velocity || 0) * 0.5; hi = Math.max((r.velocity || 0) * 1.5, r.rate_window || 0); }
        function band(rt) { var pts = []; for (var k = 0; k <= 12; k++) { var tt = c + (rs - c) * k / 12; pts.push([X(tt), Y(used + rt * (tt - c) / H)]); } return pts; }
        var a = band(lo), b = band(hi).reverse();
        out.push('<polygon points="' + a.concat(b).map(function (p) { return p[0].toFixed(1) + "," + p[1].toFixed(1); }).join(" ") + '" fill="var(--used)" fill-opacity="0.12"' + tipAttr(tx("c_band_tip", { conf: r.confidence === "low" ? tx("c_conf_low_w") : tx("c_conf_mid_w"), range: num1(lo) + "–" + num1(hi) + "%/h" })) + "/>");
      }
      var pts = [[cx, Y(used)]];
      if (ex != null && ex < rs) { pts.push([X(ex), Y(100)]); pts.push([X(rs), Y(100)]); }
      else pts.push([X(rs), Y(used + (r.velocity || 0) * remH)]);
      out.push('<polyline points="' + pts.map(function (p) { return p[0].toFixed(1) + "," + p[1].toFixed(1); }).join(" ") + '" fill="none" stroke="var(--used)" stroke-width="2" stroke-dasharray="5 4" stroke-linecap="round"/>');
      var endV = ex != null && ex < rs ? 100 : clamp(used + (r.velocity || 0) * remH, 0, 100);
      var lbl = ex != null && ex < rs ? tx("c_empty_lc", { time: hm(ex) }) : tx("c_projected_lc", { v: pct(endV, approx(r)) });
      out.push(svgText(Math.min(W - padR, X(rs)) - 2, Y(endV) - 6, lbl, "ink2", "end"));
    }
    var hs = (Array.isArray(r.history) ? r.history : []).map(function (p) { return [ms(p.timestamp), +p.used_percent]; })
      .filter(function (p) { return p[0] != null && p[0] >= ws - 60000 && p[0] <= c + 60000 && isFinite(p[1]); }).sort(function (x, y) { return x[0] - y[0]; });
    if (!hs.length || hs[hs.length - 1][0] < c - 60000) hs.push([c, used]);
    out.push('<polyline points="' + hs.map(function (p) { return X(p[0]).toFixed(1) + "," + Y(p[1]).toFixed(1); }).join(" ") + '" fill="none" stroke="var(--used)" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>');
    hs.forEach(function (p) { out.push('<circle cx="' + X(p[0]).toFixed(1) + '" cy="' + Y(p[1]).toFixed(1) + '" r="6" fill="transparent"' + tipAttr(hm(p[0]) + ": " + pct(p[1])) + "/>"); });
    out.push('<line x1="' + cx.toFixed(1) + '" x2="' + cx.toFixed(1) + '" y1="' + padT + '" y2="' + (Hc - padB) + '" stroke="var(--ink-2)" stroke-width="1"/>');
    out.push('<circle cx="' + cx.toFixed(1) + '" cy="' + Y(used).toFixed(1) + '" r="4.5" fill="var(--used)" stroke="var(--surface)" stroke-width="2"/>');
    out.push(svgText(cx + 4, padT + 10, tx("c_snapshot_at", { time: hm(c) }), "ink2", cx > W - 120 ? "end" : "start", cx > W - 120 ? ' dx="-8"' : ""));
    host.innerHTML = '<svg width="' + W + '" height="' + Hc + '" viewBox="0 0 ' + W + " " + Hc + '" role="img" aria-label="' + esc(tx("c_aria_burn")) + '">' + out.join("") + "</svg>";
  }
  function renderDrawer() {
    if (!drawerKey) return;
    var r0 = rowByKey(drawerKey);
    if (!r0 || !sel.has(r0.email)) { closeDrawer(); return; }
    // scope S to the row's pool so its windows / heatmap are that pool's (claude: the whole snapshot)
    inView(r0.pool || null, "", function () { renderDrawerRow(r0); });
  }
  function renderDrawerRow(r) {
    var d = document.getElementById("drawerBody");
    var rs = ms(r.resets_at), c = ms(r.computed_at), now = Date.now();
    var remTxt = rs ? (rs > now ? t("hours_left", { dur: dur(rs - now) }) : t("past_reset")) : "";
    var free = r.state_code === "AUTH" ? null : (r.weekly_capped ? 0 : r.free_now);
    var ei = exhaustInfo(r);
    var stats =
      '<div class="stat"><div class="meta-l">' + t("free_now") + '</div><div class="v num">' + (free == null ? "—" : pct(free)) + "</div></div>" +
      '<div class="stat"><div class="meta-l">' + (ei ? t("c_empty_at_lbl") : isRough(r) ? t("c_surplus_at_reset") : t("c_lose_at_reset")) + '</div><div class="v num">' + (ei ? (approx(r) ? "~" : "") + hm(ei.at) : r.state_code === "ACTIVE" ? wasteTxt(r) : "—") + "</div>" + (!ei && isRough(r) ? '<div class="meta-l">' + roughBadge(r) + "</div>" : "") + "</div>" +
      '<div class="stat"><div class="meta-l">' + (r.five_hour_disabled ? t("c_reset_week") : "Reset") + '</div><div class="v num">' + (rs ? when(rs) : "—") + '</div><div class="meta-l">' + remTxt + "</div></div>" +
      '<div class="stat"><div class="meta-l">' + t("c_speed") + '</div><div class="v num">' + (r.state_code === "ACTIVE" ? num1(r.velocity) + "%/h" : "—") + "</div>" + (r.state_code === "ACTIVE" ? '<div class="meta-l">' + confDots(effConf(r)) + "</div>" : "") + "</div>" +
      '<div class="stat"><div class="meta-l">' + t("c_needed") + '</div><div class="v num">' + (r.burn_needed_per_h != null ? num1(r.burn_needed_per_h) + "%/h" : "—") + "</div></div>" +
      (r.weekly_used != null || r.pool ? '<div class="stat"><div class="meta-l">' + t("c_week") + '</div><div class="v num">' + (r.weekly_used == null ? "—" : pct(r.weekly_used)) + '</div><div class="meta-l">' + (r.weekly_used == null ? t("c_old_client_no_fig") : r.weekly_resets_at ? t("c_reopen") + " " + when(ms(r.weekly_resets_at)) : "") + "</div></div>" : "");
    var wins = windowsFor(function (w) { return w.email === r.email; }, 10);
    var wtbl = wins.length ? '<div class="tbl-wrap"><table class="tbl"><thead><tr><th>' + t("c_th_cycle") + '</th><th>' + t("seg_used") + '</th><th class="r">' + t("c_th_waste") + '</th><th class="r">' + t("c_th_err") + '</th></tr></thead><tbody>' + wins.map(function (w) {
      return '<tr><td class="num">' + fmtRange(w.start, w.end) + '</td><td class="num">' + miniUsed(w.used) + " " + pct(w.used) + '</td><td class="r num">' + pct(w.waste) + '</td><td class="r num muted">±' + Math.round(w.unc || 0) + "m</td></tr>";
    }).join("") + "</tbody></table></div>" + '<div class="wl-cards">' + wins.map(function (w) {
      return '<div class="wl-card"><div class="num">' + fmtRange(w.start, w.end) + '</div><div class="num" style="text-align:right">' + t("c_lost_short") + ' ' + pct(w.waste) + '</div><div>' + miniUsed(w.used) + ' <span class="num">' + pct(w.used) + '</span></div><div class="num muted" style="text-align:right">±' + Math.round(w.unc || 0) + "m</div></div>";
    }).join("") + "</div>" : '<div class="empty">' + t("c_no_closed_14d") + '</div>';
    var err = r.state_code === "AUTH" ? '<div class="err" style="margin-top:12px"><b>' + esc(sv(r, "auth_label") || t("c_auth_err")) + "</b>" + (r.auth_error ? "<br>" + esc(r.auth_error) : "") + (r.auth_at ? '<br><span class="muted">' + t("c_at") + ' ' + when(ms(r.auth_at)) + "</span>" : "") + "</div>" : "";
    d.innerHTML =
      '<div class="drawer-h"><div style="display:flex;flex-direction:column;gap:6px;min-width:0">' + chip(r.email) + '<div class="muted" style="font-size:12px;word-break:break-all">' + esc(r.email) + (r.pool_label ? " · " + esc(r.pool_label) : "") + "</div></div>" +
      '<button type="button" class="btn btn-icon" id="drawerClose" aria-label="' + esc(t("drawer_close")) + '"><svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" stroke-linecap="round"/></svg></button></div>' +
      '<div style="margin-top:6px">' + badge(r) + "</div>" + err + (authWarnHtml(r) ? '<div style="margin-top:10px">' + authWarnHtml(r) + "</div>" : "") +
      '<div class="stats">' + stats + "</div>" +
      "<h3>" + t("drawer_cur_cycle") + "</h3>" +
      '<div class="legend" style="margin-bottom:6px"><span><span class="sw seg-used" style="height:3px"></span>' + t("drawer_actual") + '</span><span><span class="sw" style="height:0;border-top:2px dashed var(--used)"></span>' + t("drawer_projected") + '</span>' + (r.state_code === "ACTIVE" && r.confidence !== "high" ? '<span><span class="sw" style="background:var(--used);opacity:.18"></span>' + t("drawer_band") + '</span>' : "") + "</div>" +
      '<div class="chart" id="burn"></div>' +
      "<h3>" + t("drawer_machines") + "</h3>" + machDrawerHtml(r) + '<div class="cap" style="margin-top:6px">' + esc(t("c_mach_cap")) + "</div>" +
      "<h3>" + t("drawer_recent") + "</h3>" + wtbl +
      "<h3>" + t("drawer_idle_14d") + "</h3>" + '<div class="chart" id="drawerHm"></div>' +
      '<div class="cap" style="margin-top:6px">' + t("drawer_last_rep", { rep: when(ms(r.last_report_at)), ver: esc(r.client_version ? "v" + r.client_version : t("client_old")), calc: when(c) }) + "</div>";
    burnSvg(r);
    var hmd = hmRowsFor([r.email], false);
    document.getElementById("drawerHm").innerHTML = hmd.rows.length ? heatmapSvg("drawerHm", hmd.rows) : '<div class="empty">' + t("no_data") + "</div>";
  }

  // ---------- tabs ----------
  var histOpen = sget(HIST_STORE) === "1";
  function setHistOpen(open) {
    histOpen = open;
    sset(HIST_STORE, open ? "1" : "0");
    if (open) renderAll(); // the charts size themselves to the container, so draw them once it is visible
  }

  // ---------- provider bar + pool columns ----------
  function provHref(id) {
    try { var u = new URL(window.location.href); u.searchParams.set("provider", id); return u.pathname + u.search; } catch (e) { return "/?provider=" + encodeURIComponent(id) + "&key=" + encodeURIComponent(CURRENT_KEY); }
  }
  // brand marks: Claude and OpenAI (used for Codex, as on its own docs site) from simple-icons (CC0 data),
  // Antigravity from antigravity.google/favicon.svg; the first two use currentColor, tinted by CSS
  var PROV_ICON = {
    claude: ["0 0 24 24", '<path fill="currentColor" d="m4.7144 15.9555 4.7174-2.6471.079-.2307-.079-.1275h-.2307l-.7893-.0486-2.6956-.0729-2.3375-.0971-2.2646-.1214-.5707-.1215-.5343-.7042.0546-.3522.4797-.3218.686.0608 1.5179.1032 2.2767.1578 1.6514.0972 2.4468.255h.3886l.0546-.1579-.1336-.0971-.1032-.0972L6.973 9.8356l-2.55-1.6879-1.3356-.9714-.7225-.4918-.3643-.4614-.1578-1.0078.6557-.7225.8803.0607.2246.0607.8925.686 1.9064 1.4754 2.4893 1.8336.3643.3035.1457-.1032.0182-.0728-.164-.2733-1.3539-2.4467-1.445-2.4893-.6435-1.032-.17-.6194c-.0607-.255-.1032-.4674-.1032-.7285L6.287.1335 6.6997 0l.9957.1336.419.3642.6192 1.4147 1.0018 2.2282 1.5543 3.0296.4553.8985.2429.8318.091.255h.1579v-.1457l.1275-1.706.2368-2.0947.2307-2.6957.0789-.7589.3764-.9107.7468-.4918.5828.2793.4797.686-.0668.4433-.2853 1.8517-.5586 2.9021-.3643 1.9429h.2125l.2429-.2429.9835-1.3053 1.6514-2.0643.7286-.8196.85-.9046.5464-.4311h1.0321l.759 1.1293-.34 1.1657-1.0625 1.3478-.8804 1.1414-1.2628 1.7-.7893 1.36.0729.1093.1882-.0183 2.8535-.607 1.5421-.2794 1.8396-.3157.8318.3886.091.3946-.3278.8075-1.967.4857-2.3072.4614-3.4364.8136-.0425.0304.0486.0607 1.5482.1457.6618.0364h1.621l3.0175.2247.7892.522.4736.6376-.079.4857-1.2142.6193-1.6393-.3886-3.825-.9107-1.3113-.3279h-.1822v.1093l1.0929 1.0686 2.0035 1.8092 2.5075 2.3314.1275.5768-.3218.4554-.34-.0486-2.2039-1.6575-.85-.7468-1.9246-1.621h-.1275v.17l.4432.6496 2.3436 3.5214.1214 1.0807-.17.3521-.6071.2125-.6679-.1214-1.3721-1.9246L14.38 17.959l-1.1414-1.9428-.1397.079-.674 7.2552-.3156.3703-.7286.2793-.6071-.4614-.3218-.7468.3218-1.4753.3886-1.9246.3157-1.53.2853-1.9004.17-.6314-.0121-.0425-.1397.0182-1.4328 1.9672-2.1796 2.9446-1.7243 1.8456-.4128.164-.7164-.3704.0667-.6618.4008-.5889 2.386-3.0357 1.4389-1.882.929-1.0868-.0062-.1579h-.0546l-6.3385 4.1164-1.1293.1457-.4857-.4554.0608-.7467.2307-.2429 1.9064-1.3114Z"/>'],
    agy: ["22 24 88 86", '<g transform="translate(12 10)"> <path d="M89.6992 93.695C94.3659 97.195 101.366 94.8617 94.9492 88.445C75.6992 69.7783 79.7825 18.445 55.8659 18.445C31.9492 18.445 36.0325 69.7783 16.7825 88.445C9.78251 95.445 17.3658 97.195 22.0325 93.695C40.1159 81.445 38.9492 59.8617 55.8659 59.8617C72.7825 59.8617 71.6159 81.445 89.6992 93.695Z" fill="#3186FF"/> <mask id="ag_fav_m" style="mask-type:alpha" maskUnits="userSpaceOnUse" x="13" y="18" width="85" height="78"> <path d="M89.6992 93.695C94.3659 97.195 101.366 94.8617 94.9492 88.445C75.6992 69.7783 79.7825 18.445 55.8659 18.445C31.9492 18.445 36.0325 69.7783 16.7825 88.445C9.78251 95.445 17.3658 97.195 22.0325 93.695C40.1159 81.445 38.9492 59.8617 55.8659 59.8617C72.7825 59.8617 71.6159 81.445 89.6992 93.695Z" fill="black"/> </mask> <g mask="url(#ag_fav_m)"> <g filter="url(#ag_fav_f0)"><ellipse cx="22.7873" cy="26.8098" rx="22.7873" ry="26.8098" transform="matrix(-0.112784 0.99362 -0.99362 -0.112781 66.2473 -15.5344)" fill="#FFE432"/></g> <g filter="url(#ag_fav_f1)"><ellipse cx="96.491" cy="35.1231" rx="29.5007" ry="30.1492" transform="rotate(76.9243 96.491 35.1231)" fill="#FC413D"/></g> <g filter="url(#ag_fav_f2)"><ellipse cx="9.02988" cy="41.6647" rx="30.832" ry="39.9417" transform="rotate(74.1257 9.02988 41.6647)" fill="#00B95C"/></g> <g filter="url(#ag_fav_f3)"><ellipse cx="11.2212" cy="42.8915" rx="30.22" ry="33.2695" transform="rotate(45.6065 11.2212 42.8915)" fill="#00B95C"/></g> <g filter="url(#ag_fav_f4)"><ellipse cx="75.7546" cy="104.822" rx="29.0177" ry="27.943" transform="rotate(76.9243 75.7546 104.822)" fill="#3186FF"/></g> <g filter="url(#ag_fav_f5)"><ellipse cx="33.5661" cy="35.4043" rx="33.5661" ry="35.4043" transform="matrix(-0.409539 0.912293 -0.912294 -0.409537 101.25 -15.1674)" fill="#FBBC04"/></g> <g filter="url(#ag_fav_f6)"><path d="M2.56802 149.695C-15.8116 142.48 15.5987 83.1163 23.4093 63.2203C31.22 43.3244 52.4514 33.0447 70.831 40.26C89.2107 47.4753 110.996 87.2162 103.185 107.112C95.3742 127.008 20.9477 156.91 2.56802 149.695Z" fill="#3186FF"/></g> <g filter="url(#ag_fav_f7)"><path d="M113.934 75.8079C109.013 81.5509 96.1724 78.6224 85.253 69.2667C74.3335 59.911 69.4704 47.6711 74.391 41.928C79.3116 36.185 92.1525 39.1136 103.072 48.4692C113.991 57.8249 118.855 70.0648 113.934 75.8079Z" fill="#749BFF"/></g> <g filter="url(#ag_fav_f8)"><ellipse cx="92.611" cy="23.7962" rx="44.2411" ry="27.5016" transform="rotate(34.0763 92.611 23.7962)" fill="#FC413D"/></g> <g filter="url(#ag_fav_f9)"><ellipse cx="23.4949" cy="29.5887" rx="23.7071" ry="13.7869" transform="rotate(112.516 23.4949 29.5887)" fill="#FFEE48"/></g> </g> </g> <defs> <filter id="ag_fav_f0" x="2.49348" y="-26.5423" width="69.0899" height="61.2525" filterUnits="userSpaceOnUse" color-interpolation-filters="sRGB"><feGaussianBlur stdDeviation="3.89034"/></filter> <filter id="ag_fav_f1" x="28.7524" y="-32.0333" width="135.477" height="134.313" filterUnits="userSpaceOnUse" color-interpolation-filters="sRGB"><feGaussianBlur stdDeviation="18.8078"/></filter> <filter id="ag_fav_f2" x="-62.2884" y="-21.9253" width="142.637" height="127.18" filterUnits="userSpaceOnUse" color-interpolation-filters="sRGB"><feGaussianBlur stdDeviation="15.9884"/></filter> <filter id="ag_fav_f3" x="-52.5697" y="-20.8346" width="127.582" height="127.452" filterUnits="userSpaceOnUse" color-interpolation-filters="sRGB"><feGaussianBlur stdDeviation="15.9884"/></filter> <filter id="ag_fav_f4" x="17.3619" y="45.4646" width="116.786" height="118.715" filterUnits="userSpaceOnUse" color-interpolation-filters="sRGB"><feGaussianBlur stdDeviation="15.1937"/></filter> <filter id="ag_fav_f5" x="-7.44765" y="-60.4737" width="125.303" height="122.858" filterUnits="userSpaceOnUse" color-interpolation-filters="sRGB"><feGaussianBlur stdDeviation="13.7698"/></filter> <filter id="ag_fav_f6" x="-27.7086" y="13.3597" width="157.119" height="162.029" filterUnits="userSpaceOnUse" color-interpolation-filters="sRGB"><feGaussianBlur stdDeviation="12.297"/></filter> <filter id="ag_fav_f7" x="50.4638" y="16.981" width="87.3973" height="83.7738" filterUnits="userSpaceOnUse" color-interpolation-filters="sRGB"><feGaussianBlur stdDeviation="11.0036"/></filter> <filter id="ag_fav_f8" x="34.2604" y="-28.457" width="116.701" height="104.506" filterUnits="userSpaceOnUse" color-interpolation-filters="sRGB"><feGaussianBlur stdDeviation="9.29385"/></filter> <filter id="ag_fav_f9" x="-15.1522" y="-15.9493" width="77.2941" height="91.076" filterUnits="userSpaceOnUse" color-interpolation-filters="sRGB"><feGaussianBlur stdDeviation="11.5027"/></filter> </defs>'],
    codex: ["0 0 24 24", '<path fill="currentColor" d="M22.2819 9.8211a5.9847 5.9847 0 0 0-.5157-4.9108 6.0462 6.0462 0 0 0-6.5098-2.9A6.0651 6.0651 0 0 0 4.9807 4.1818a5.9847 5.9847 0 0 0-3.9977 2.9 6.0462 6.0462 0 0 0 .7427 7.0966 5.98 5.98 0 0 0 .511 4.9107 6.051 6.051 0 0 0 6.5146 2.9001A5.9847 5.9847 0 0 0 13.2599 24a6.0557 6.0557 0 0 0 5.7718-4.2058 5.9894 5.9894 0 0 0 3.9977-2.9001 6.0557 6.0557 0 0 0-.7475-7.0729zm-9.022 12.6081a4.4755 4.4755 0 0 1-2.8764-1.0408l.1419-.0804 4.7783-2.7582a.7948.7948 0 0 0 .3927-.6813v-6.7369l2.02 1.1686a.071.071 0 0 1 .038.052v5.5826a4.504 4.504 0 0 1-4.4945 4.4944zm-9.6607-4.1254a4.4708 4.4708 0 0 1-.5346-3.0137l.142.0852 4.783 2.7582a.7712.7712 0 0 0 .7806 0l5.8428-3.3685v2.3324a.0804.0804 0 0 1-.0332.0615L9.74 19.9502a4.4992 4.4992 0 0 1-6.1408-1.6464zM2.3408 7.8956a4.485 4.485 0 0 1 2.3655-1.9728V11.6a.7664.7664 0 0 0 .3879.6765l5.8144 3.3543-2.0201 1.1685a.0757.0757 0 0 1-.071 0l-4.8303-2.7865A4.504 4.504 0 0 1 2.3408 7.872zm16.5963 3.8558L13.1038 8.364 15.1192 7.2a.0757.0757 0 0 1 .071 0l4.8303 2.7913a4.4944 4.4944 0 0 1-.6765 8.1042v-5.6772a.79.79 0 0 0-.407-.667zm2.0107-3.0231l-.142-.0852-4.7735-2.7818a.7759.7759 0 0 0-.7854 0L9.409 9.2297V6.8974a.0662.0662 0 0 1 .0284-.0615l4.8303-2.7866a4.4992 4.4992 0 0 1 6.6802 4.66zM8.3065 12.863l-2.02-1.1638a.0804.0804 0 0 1-.038-.0567V6.0742a4.4992 4.4992 0 0 1 7.3757-3.4537l-.142.0805L8.704 5.459a.7948.7948 0 0 0-.3927.6813zm1.0976-2.3654l2.602-1.4998 2.6069 1.4998v2.9994l-2.5974 1.4997-2.6067-1.4997Z"/>'],
    gemini: ["0 0 24 24", '<path fill="currentColor" d="M12 2L14.5 9.5L22 12L14.5 14.5L12 22L9.5 14.5L2 12L9.5 9.5L12 2Z"/>'],
    copilot: ["0 0 24 24", '<path fill="currentColor" d="M12 2C6.477 2 2 6.477 2 12c0 4.42 2.865 8.167 6.839 9.49.5.092.682-.217.682-.482 0-.237-.008-.866-.013-1.7-2.782.604-3.369-1.34-3.369-1.34-.454-1.156-1.11-1.464-1.11-1.464-.908-.62.069-.608.069-.608 1.003.07 1.53 1.03 1.53 1.03.892 1.529 2.341 1.087 2.91.832.092-.647.35-1.088.636-1.338-2.22-.253-4.555-1.11-4.555-4.943 0-1.091.39-1.984 1.029-2.683-.103-.253-.446-1.27.098-2.647 0 0 .84-.269 2.75 1.025A9.578 9.578 0 0 1 12 6.836c.85.004 1.705.114 2.504.336 1.909-1.294 2.747-1.025 2.747-1.025.546 1.377.203 2.394.1 2.647.64.699 1.028 1.592 1.028 2.683 0 3.842-2.339 4.687-4.566 4.935.359.309.678.919.678 1.852 0 1.336-.012 2.415-.012 2.743 0 .267.18.578.688.48C19.138 20.163 22 16.418 22 12c0-5.523-4.477-10-10-10z"/>'],
    cursor: ["0 0 24 24", '<path fill="currentColor" d="M13.64 21.97l-2.73-5.91-4.14 4.14V2.21l14.28 14.28h-6.28l2.76 5.82-3.89 1.66z"/>']
  };
  function provIcon(id) {
    var ic = PROV_ICON[id];
    return ic ? '<svg viewBox="' + ic[0] + '" aria-hidden="true">' + ic[1] + "</svg>" : "";
  }
  function renderProvBar() {
    var bar = document.getElementById("provBar");
    bar.innerHTML = PROVIDERS.map(function (p) {
      return '<a href="' + esc(provHref(p.id)) + '" data-prov="' + esc(p.id) + '"' + (p.id === PROVIDER ? ' aria-current="page"' : "") + ">" + provIcon(p.id) + "<span>" + esc(p.label || p.id) + "</span></a>";
    }).join("");
    bar.hidden = false;
    if (PROVIDER !== "claude") {
      document.getElementById("brandSub").textContent = PROV_LABEL + " Quota";
      document.title = PROV_LABEL + " Quota · Team AI Quota";
    }
  }
  // pooled provider: each tab panel becomes one column per pool (same sections, ids suffixed "-<pool>")
  var TPL = {};
  var layoutSig = "";
  function poolSfx(p) { return "-" + String(p.id).replace(/[^A-Za-z0-9_-]/g, ""); }
  function buildLayout() {
    var ap = activePools();
    var sig = ap.map(function (p) { return p.id + ":" + p.label; }).join("|");
    if (sig === layoutSig) return;
    layoutSig = sig;
    ["quotaPanelsNow", "quotaPanelsHist"].forEach(function (cid) {
      var el = document.getElementById(cid);
      if (!el) return;
      if (TPL[cid] == null) TPL[cid] = el.innerHTML;
      if (!ap.length) { el.innerHTML = TPL[cid]; return; }
      var sfx = poolSfx(ap[0]);
      el.innerHTML = '<div data-pool="' + esc(ap[0].id) + '">' + TPL[cid].replace(/\sid="([^"]+)"/g, function (m, id) { return ' id="' + id + sfx + '"'; }) + "</div>";
    });
  }
  function renderPanels() {
    var v = derive();
    renderNowKpis(v);
    renderHero(v);
    renderTimeline(v);
    renderCards(v);
    renderMachines(v);
    if (histOpen) renderHistory(v);
  }

  // ---------- render all ----------
  function renderAll() {
    rebuildIdentity();
    renderFreshness();
    renderPoolTabs();
    renderFilterButton();
    if (!document.getElementById("filterPop").hidden) renderFilterPop();
    var errBox = document.getElementById("loadErr");
    errBox.hidden = !loadError;
    buildLayout();
    var ap = activePools();
    if (!ap.length) inView(null, "", renderPanels);
    else ap.forEach(function (p) { inView(p.id, poolSfx(p), renderPanels); });
    renderNowMachineStats();
    if (histOpen) renderHistMachineStats();
    renderDrawer();
  }

  // ---------- tooltip ----------
  var tipEl = document.getElementById("tip");
  var tipTarget = null;
  function showTip(target, x, y) {
    var t = target.getAttribute("data-tip");
    if (!t) return;
    tipTarget = target;
    tipEl.textContent = t;
    tipEl.hidden = false;
    var w = tipEl.offsetWidth, h = tipEl.offsetHeight;
    var left = clamp(x + 12, 8, window.innerWidth - w - 8);
    var top = y + 16 + h > window.innerHeight - 8 ? y - h - 12 : y + 16;
    tipEl.style.left = left + "px";
    tipEl.style.top = Math.max(8, top) + "px";
  }
  function hideTip() { tipEl.hidden = true; tipTarget = null; }
  document.addEventListener("pointermove", function (e) {
    if (e.pointerType === "touch") return;
    var t = e.target && e.target.closest ? e.target.closest("[data-tip]") : null;
    if (t) showTip(t, e.clientX, e.clientY); else if (tipTarget) hideTip();
  });
  document.addEventListener("scroll", hideTip, { passive: true });

  // ---------- settings modal ----------
  function updateProvidersFromSettings() {
    var st = getSettings();
    var enabledIds = Object.keys(st.providers || {}).filter(function (id) {
      return st.providers[id] && st.providers[id].enabled !== false;
    });
    var base = Array.isArray(S.providers) && S.providers.length ? S.providers : ALL_CLI_PROVIDERS.map(function (p) { return { id: p.id, label: p.label.split(" ")[0] }; });
    PROVIDERS = base.filter(function (p) { return enabledIds.indexOf(p.id) >= 0; });
    if (!PROVIDERS.length) PROVIDERS = [{ id: "claude", label: "Claude" }];
    if (!PROVIDERS.some(function (p) { return p.id === PROVIDER; })) {
      PROVIDERS.unshift({ id: PROVIDER, label: (ALL_CLI_PROVIDERS.filter(function (p) { return p.id === PROVIDER; })[0] || { label: PROVIDER }).label.split(" ")[0] });
    }
  }

  function appendMachRow(grid, mid, val) {
    var div = document.createElement("div");
    div.className = "settings-row";
    div.setAttribute("data-mach-row", "");
    div.innerHTML =
      '<div><span class="num" style="font-weight:600;font-size:12px;word-break:break-all" title="' + esc(mid) + '">' + esc(mid) + '</span><input type="hidden" data-mach-id value="' + esc(mid) + '"></div>' +
      '<div><input type="text" class="settings-input" data-mach-val value="' + esc(val || "") + '" placeholder="' + esc(t("c_ph_friendly")) + '"></div>' +
      '<div><button type="button" class="btn btn-icon btn-ghost" data-del-row title="' + esc(t("c_del_label")) + '">✕</button></div>';
    grid.appendChild(div);
  }

  function appendAcctRow(grid, em, val) {
    var div = document.createElement("div");
    div.className = "settings-row";
    div.setAttribute("data-acct-row", "");
    div.innerHTML =
      '<div><span class="num" style="font-weight:600;font-size:12px;word-break:break-all" title="' + esc(em) + '">' + esc(em) + '</span><input type="hidden" data-acct-email value="' + esc(em) + '"></div>' +
      '<div><input type="text" class="settings-input" data-acct-val value="' + esc(val || "") + '" placeholder="' + esc(t("c_ph_acct_label")) + '"></div>' +
      '<div><button type="button" class="btn btn-icon btn-ghost" data-del-row title="' + esc(t("c_del_label")) + '">✕</button></div>';
    grid.appendChild(div);
  }

  function openSettingsModal() {
    var modal = document.getElementById("settingsModal");
    var scrim = document.getElementById("settingsScrim");
    var btn = document.getElementById("settingsBtn");
    var body = document.getElementById("settingsBody");
    var status = document.getElementById("settingsStatus");
    if (!modal || !scrim || !body) return;
    if (status) status.textContent = "";

    var st = getSettings();
    var provs = st.providers || {};
    var machLabels = st.machine_labels || {};
    var acctLabels = st.account_labels || {};

    var provRows = ALL_CLI_PROVIDERS.map(function (p) {
      var conf = provs[p.id] || { enabled: true, windows: p.defaultWindows };
      var isEn = conf.enabled !== false;
      var wins = Array.isArray(conf.windows)
        ? conf.windows
        : (conf.windows && typeof conf.windows === "object"
            ? Object.keys(conf.windows).filter(function(k) { return conf.windows[k]; })
            : p.defaultWindows);
      var has7d = wins.indexOf("7d") >= 0;
      var has5h = wins.indexOf("5h") >= 0;
      var has30d = wins.indexOf("30d") >= 0;
      return '<div class="settings-prov-row">' +
        '<div style="display:flex;align-items:center;gap:8px">' +
          '<input type="checkbox" id="sett-p-' + p.id + '" data-sett-prov="' + p.id + '"' + (isEn ? ' checked' : '') + '>' +
          '<label for="sett-p-' + p.id + '" style="font-weight:600;display:flex;align-items:center;gap:6px;cursor:pointer">' +
            provIcon(p.id) + '<span>' + esc(p.label) + '</span>' +
          '</label>' +
        '</div>' +
        '<div class="settings-windows">' +
          '<span class="muted" style="font-size:11px">' + esc(t("label_windows")) + ':</span>' +
          '<label><input type="checkbox" data-sett-win="' + p.id + '" value="7d"' + (has7d ? ' checked' : '') + '> 7d</label>' +
          '<label><input type="checkbox" data-sett-win="' + p.id + '" value="5h"' + (has5h ? ' checked' : '') + '> 5h</label>' +
          '<label><input type="checkbox" data-sett-win="' + p.id + '" value="30d"' + (has30d ? ' checked' : '') + '> 30d (' + esc(t("label_30d")) + ')</label>' +
        '</div>' +
      '</div>';
    }).join("");

    var machSet = {};
    if (FULL && FULL.machine_stats) {
      if (Array.isArray(FULL.machine_stats)) {
        FULL.machine_stats.forEach(function (m) { if (m && m.machine_id) machSet[m.machine_id] = 1; else if (m && m.machine) machSet[m.machine] = 1; });
      } else if (typeof FULL.machine_stats === "object") {
        Object.keys(FULL.machine_stats).forEach(function (k) { machSet[k] = 1; });
      }
    }
    if (FULL && Array.isArray(FULL.accounts)) {
      FULL.accounts.forEach(function (a) {
        if (Array.isArray(a.machines)) a.machines.forEach(function (m) { if (m) machSet[m] = 1; });
      });
    }
    Object.keys(machLabels).forEach(function (k) { machSet[k] = 1; });
    var machListArr = Object.keys(machSet).sort();

    var machRows = machListArr.map(function (m) {
      var val = machLabels[m] || "";
      return '<div class="settings-row" data-mach-row>' +
        '<div><span class="num" style="font-weight:600;font-size:12px;word-break:break-all" title="' + esc(m) + '">' + esc(m) + '</span><input type="hidden" data-mach-id value="' + esc(m) + '"></div>' +
        '<div><input type="text" class="settings-input" data-mach-val value="' + esc(val) + '" placeholder="' + esc(resolveMachName(m) !== m ? resolveMachName(m) : t("c_ph_friendly")) + '"></div>' +
        '<div><button type="button" class="btn btn-icon btn-ghost" data-del-row title="' + esc(t("c_del_label")) + '">✕</button></div>' +
      '</div>';
    }).join("");

    var acctSet = {};
    uniqEmails().forEach(function (e) { acctSet[e] = 1; });
    Object.keys(acctLabels).forEach(function (k) { acctSet[k] = 1; });
    var acctListArr = Object.keys(acctSet).sort();

    var acctRows = acctListArr.map(function (e) {
      var val = acctLabels[e] || "";
      return '<div class="settings-row" data-acct-row>' +
        '<div><span class="num" style="font-weight:600;font-size:12px;word-break:break-all" title="' + esc(e) + '">' + esc(e) + '</span><input type="hidden" data-acct-email value="' + esc(e) + '"></div>' +
        '<div><input type="text" class="settings-input" data-acct-val value="' + esc(val) + '" placeholder="' + esc(nm(e) || t("c_ph_acct_label")) + '"></div>' +
        '<div><button type="button" class="btn btn-icon btn-ghost" data-del-row title="' + esc(t("c_del_label")) + '">✕</button></div>' +
      '</div>';
    }).join("");

    body.innerHTML =
      '<div class="settings-sec">' +
        '<div class="settings-sec-title"><span>🔌 ' + esc(t("settings_providers_sec")) + '</span></div>' +
        '<div class="settings-sec-desc">' + esc(t("settings_enable_prov")) + '</div>' +
        '<div class="settings-grid" style="max-height:none">' + provRows + '</div>' +
      '</div>' +
      '<div class="settings-sec">' +
        '<div class="settings-sec-title"><span>' + ICONS.monitor + ' ' + esc(t("settings_mach_sec")) + '</span></div>' +
        '<div class="settings-sec-desc">' + esc(t("c_sett_mach_desc")) + '</div>' +
        '<div class="settings-grid" id="settingsMachGrid">' + machRows + '</div>' +
        '<div style="margin-top:8px;display:flex;gap:8px">' +
          '<input type="text" id="newMachId" class="settings-input" style="flex:1" placeholder="' + esc(t("c_ph_new_mach_id")) + '">' +
          '<input type="text" id="newMachVal" class="settings-input" style="flex:1" placeholder="' + esc(t("c_ph_new_mach_label")) + '">' +
          '<button type="button" class="btn" id="addNewMachBtn">+ ' + esc(t("settings_add_row")) + '</button>' +
        '</div>' +
      '</div>' +
      '<div class="settings-sec">' +
        '<div class="settings-sec-title"><span>👤 ' + esc(t("settings_acct_sec")) + '</span></div>' +
        '<div class="settings-sec-desc">' + esc(t("c_sett_acct_desc")) + '</div>' +
        '<div class="settings-grid" id="settingsAcctGrid">' + acctRows + '</div>' +
        '<div style="margin-top:8px;display:flex;gap:8px">' +
          '<input type="text" id="newAcctEmail" class="settings-input" style="flex:1" placeholder="' + esc(t("c_ph_new_email")) + '">' +
          '<input type="text" id="newAcctVal" class="settings-input" style="flex:1" placeholder="' + esc(t("c_ph_new_acct_label")) + '">' +
          '<button type="button" class="btn" id="addNewAcctBtn">+ ' + esc(t("settings_add_row")) + '</button>' +
        '</div>' +
      '</div>';

    modal.hidden = false;
    scrim.hidden = false;
    if (btn) btn.setAttribute("aria-expanded", "true");
  }

  function closeSettingsModal() {
    var modal = document.getElementById("settingsModal");
    var scrim = document.getElementById("settingsScrim");
    var btn = document.getElementById("settingsBtn");
    if (modal) modal.hidden = true;
    if (scrim) scrim.hidden = true;
    if (btn) {
      btn.setAttribute("aria-expanded", "false");
      try { btn.focus(); } catch (e) {}
    }
  }

  function saveSettingsModal() {
    var modal = document.getElementById("settingsModal");
    var status = document.getElementById("settingsStatus");
    if (!modal) return;
    if (status) status.textContent = t("c_saving");

    var provs = {};
    ALL_CLI_PROVIDERS.forEach(function (p) {
      var cb = document.getElementById("sett-p-" + p.id);
      var isEn = cb ? cb.checked : true;
      var winCbs = modal.querySelectorAll('input[data-sett-win="' + p.id + '"]:checked');
      var wins = [];
      for (var i = 0; i < winCbs.length; i++) wins.push(winCbs[i].value);
      if (!wins.length) wins = p.defaultWindows;
      provs[p.id] = { enabled: isEn, windows: wins };
    });

    var machLabels = {};
    var machRows = modal.querySelectorAll("[data-mach-row]");
    for (var i = 0; i < machRows.length; i++) {
      var idIn = machRows[i].querySelector("[data-mach-id]");
      var valIn = machRows[i].querySelector("[data-mach-val]");
      if (idIn && valIn && idIn.value.trim() && valIn.value.trim()) {
        machLabels[idIn.value.trim()] = valIn.value.trim();
      }
    }
    var newMId = document.getElementById("newMachId");
    var newMVal = document.getElementById("newMachVal");
    if (newMId && newMVal && newMId.value.trim() && newMVal.value.trim()) {
      machLabels[newMId.value.trim()] = newMVal.value.trim();
    }

    var acctLabels = {};
    var acctRows = modal.querySelectorAll("[data-acct-row]");
    for (var j = 0; j < acctRows.length; j++) {
      var emIn = acctRows[j].querySelector("[data-acct-email]");
      var aValIn = acctRows[j].querySelector("[data-acct-val]");
      if (emIn && aValIn && emIn.value.trim() && aValIn.value.trim()) {
        acctLabels[emIn.value.trim()] = aValIn.value.trim();
      }
    }
    var newAEm = document.getElementById("newAcctEmail");
    var newAVal = document.getElementById("newAcctVal");
    if (newAEm && newAVal && newAEm.value.trim() && newAVal.value.trim()) {
      acctLabels[newAEm.value.trim()] = newAVal.value.trim();
    }

    var newSettings = {
      providers: provs,
      machine_labels: machLabels,
      account_labels: acctLabels
    };

    sset(SETTINGS_STORE, JSON.stringify(newSettings));
    if (FULL) { FULL.settings = newSettings; S.settings = newSettings; }

    if (CURRENT_KEY) {
      try {
        fetch("/api/settings", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-api-key": CURRENT_KEY
          },
          body: JSON.stringify(newSettings)
        }).catch(function () {});
      } catch (e) {}
    }

    updateProvidersFromSettings();
    renderProvBar();
    renderAll();

    if (status) status.textContent = t("settings_saved");
    setTimeout(function () {
      closeSettingsModal();
    }, 400);
  }

  // ---------- events ----------
  document.addEventListener("click", function (e) {
    var t = e.target;
    if (!t || !t.closest) return;
    if (t.closest("#settingsBtn")) { openSettingsModal(); return; }
    if (t.closest("#settingsCloseBtn") || t.closest("#settingsCancelBtn") || t.id === "settingsScrim") { closeSettingsModal(); return; }
    if (t.closest("#settingsSaveBtn")) { saveSettingsModal(); return; }
    if (t.closest("#addNewMachBtn")) {
      var nId = document.getElementById("newMachId");
      var nVal = document.getElementById("newMachVal");
      var gridM = document.getElementById("settingsMachGrid");
      if (nId && nVal && gridM && nId.value.trim()) {
        appendMachRow(gridM, nId.value.trim(), nVal.value.trim());
        nId.value = ""; nVal.value = "";
      }
      return;
    }
    if (t.closest("#addNewAcctBtn")) {
      var nEm = document.getElementById("newAcctEmail");
      var nAVal = document.getElementById("newAcctVal");
      var gridA = document.getElementById("settingsAcctGrid");
      if (nEm && nAVal && gridA && nEm.value.trim()) {
        appendAcctRow(gridA, nEm.value.trim(), nAVal.value.trim());
        nEm.value = ""; nAVal.value = "";
      }
      return;
    }
    var delBtn = t.closest("[data-del-row]");
    if (delBtn) {
      var row = delBtn.closest(".settings-row");
      if (row) {
        var txt = row.querySelector("input[type=text]");
        if (txt) txt.value = "";
        row.style.opacity = "0.3";
      }
      return;
    }
    var pt = t.closest("[data-pool-tab]");
    if (pt) { e.preventDefault(); setPool(pt.getAttribute("data-pool-tab")); return; }
    if (t.closest("#filterBtn")) { setFilterOpen(document.getElementById("filterPop").hidden); return; }
    var only = t.closest("[data-only]");
    if (only) { sel = new Set([only.getAttribute("data-only")]); saveFilter(); renderAll(); return; }
    if (t.closest("#drawerClose") || t.id === "scrim") { closeDrawer(); return; }
    var open = t.closest("[data-open]");
    if (open) { openDrawer(open.getAttribute("data-open")); return; }
    if (t.closest("#themeBtn")) {
      var dark = document.documentElement.classList.toggle("dark");
      sset("theme", dark ? "dark" : "light");
      return;
    }
    if (t.closest("#refreshBtn")) { poll(true); return; }
    var pv = t.closest("[data-prov]");
    if (pv) { sset(PROV_STORE, pv.getAttribute("data-prov")); return; } // the link reloads with that provider's data
    var tipT = t.closest("[data-tip]");
    if (tipT && (e.pointerType === "touch" || e.pointerType === "pen" || !e.pointerType)) {
      if (tipTarget === tipT) hideTip(); else { var rc = tipT.getBoundingClientRect(); showTip(tipT, e.clientX || rc.left + rc.width / 2, e.clientY || rc.top); }
    } else if (tipTarget && !tipT) hideTip();
    if (!t.closest("#filter") && !document.getElementById("filterPop").hidden) setFilterOpen(false);
  });
  document.addEventListener("change", function (e) {
    var t = e.target;
    if (!t || t.type !== "checkbox") return;
    if (t.id === "f-all") {
      if (t.checked) sel = new Set(S.accounts.map(function (a) { return a.email; }));
      else { renderFilterPop(); return; } // cannot end with zero selected
      saveFilter(); renderAll(); return;
    }
    var em = t.getAttribute("data-email");
    if (!em) return;
    if (t.checked) sel.add(em);
    else if (sel.size > 1) sel.delete(em);
    else { t.checked = true; return; }
    saveFilter(); renderAll();
  });
  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape") {
      var settModal = document.getElementById("settingsModal");
      if (settModal && !settModal.hidden) { closeSettingsModal(); return; }
      if (!document.getElementById("filterPop").hidden) { setFilterOpen(false); document.getElementById("filterBtn").focus(); return; }
      if (drawerKey) { closeDrawer(); return; }
      hideTip();
    }
    if ((e.key === "Enter" || e.key === " ") && e.target && e.target.getAttribute && e.target.getAttribute("data-open")) {
      e.preventDefault();
      openDrawer(e.target.getAttribute("data-open"));
    }
  });
  var rzT = null, lastW = window.innerWidth;
  window.addEventListener("resize", function () {
    if (window.innerWidth === lastW) return;
    lastW = window.innerWidth;
    clearTimeout(rzT);
    rzT = setTimeout(renderAll, 150);
  });

  // ---------- refresh ----------
  var inflight = false;
  function poll(manual) {
    if (inflight || !CURRENT_KEY) return;
    if (!manual && document.visibilityState !== "visible") return;
    inflight = true;
    var icon = document.getElementById("refreshIcon");
    if (icon) icon.classList.add("spin");
    var headers = { "Accept": "application/json", "x-api-key": CURRENT_KEY };
    if (etag) headers["If-None-Match"] = etag;
    fetch("/status?provider=" + encodeURIComponent(PROVIDER) + "&key=" + encodeURIComponent(CURRENT_KEY), { headers: headers, cache: "no-store" })
      .then(function (res) {
        if (res.status === 401) {
          sdel(KEY_STORE);
          window.location.href = "/";
          return null;
        }
        if (res.status === 304 || !res.ok) return null;
        var et = res.headers.get("ETag");
        return res.json().then(function (data) {
          if (data && data.provider && data.provider !== PROVIDER) return; // never mix providers
          FULL = S = normalise(data);
          if (Array.isArray(S.pools)) POOLS = S.pools.filter(function (p) { return p && p.id; });
          loadError = false;
          etag = et || etagOf(S);
          var all = uniqEmails();
          if (filterMode === "all") sel = new Set(all);
          else {
            sel = new Set(Array.from(sel).filter(function (x) { return all.indexOf(x) >= 0; }));
            if (!sel.size) { sel = new Set(all); filterMode = "all"; }
          }
          renderAll();
        });
      })
      .catch(function () {})
      .then(function () {
        inflight = false;
        if (icon) setTimeout(function () { icon.classList.remove("spin"); }, 300);
        renderFreshness();
      });
  }
  setInterval(function () { poll(false); }, 120000);
  document.addEventListener("visibilitychange", function () { if (document.visibilityState === "visible") poll(false); });
  setInterval(function () { renderFreshness(); renderAll(); }, 60000);

  // ---------- boot ----------
  // ?provider= overrides and is remembered; without it, reopen the remembered provider
  var knownProv = function (id) { return PROVIDERS.some(function (p) { return p.id === id; }); };
  if (URL_PROV && knownProv(URL_PROV)) sset(PROV_STORE, URL_PROV);
  else if (!URL_PROV) {
    var savedProv = sget(PROV_STORE);
    if (savedProv && savedProv !== PROVIDER && knownProv(savedProv) && Array.isArray(S.providers)) {
      window.location.replace(provHref(savedProv));
      return;
    }
  }
  updateProvidersFromSettings();
  renderProvBar();
  loadFilter();
  rebuildIdentity();
  var histFold = document.getElementById("histFold");
  histFold.open = histOpen;
  histFold.addEventListener("toggle", function () { if (histFold.open !== histOpen) setHistOpen(histFold.open); });

  var langSelectEl = document.getElementById("langSelect");
  if (langSelectEl) {
    langSelectEl.value = currentLang;
    langSelectEl.addEventListener("change", function () {
      var nextLang = langSelectEl.value;
      if (nextLang && I18N[nextLang]) {
        currentLang = nextLang;
        sset(LANG_STORE, nextLang);
        document.documentElement.lang = nextLang;
        updateStaticTexts();
        renderAll();
      }
    });
  }
  document.documentElement.lang = currentLang;
  updateStaticTexts();
  renderAll();
}

/**
 * Dashboard page. `snapshotJson` is the stored snapshot JSON text (same bytes as /status).
 */
export function renderDashboardPage(snapshotJson, key) {
  const dataJson = escapeScript(snapshotJson == null || snapshotJson === "" ? "{}" : snapshotJson);
  const keyJson = escapeScript(JSON.stringify(String(key == null ? "" : key)));
  const i18nJson = escapeScript(JSON.stringify(TRANSLATIONS));
  // static shell text is rendered in the default language; the client re-applies the chosen language on load
  const LT = (k) => i18nT(k, {}, DEFAULT_LANG).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");
  const appSrc = clientApp.toString().replace(/<\/(script)/gi, "<\\/$1").replace(/<!--/g, "<\\!--");
  const formatTemplateSrc = formatTemplate.toString().replace(/<\/(script)/gi, "<\\/$1").replace(/<!--/g, "<\\!--");
  return `<!DOCTYPE html>
<html lang="vi" class="dark">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta name="robots" content="noindex">
  <title>Team AI Quota</title>
  ${FONT_LINKS}
  <style>${PAGE_CSS}</style>
</head>
<body>
  <svg width="0" height="0" style="position:absolute" aria-hidden="true" focusable="false">
    <defs>
      <pattern id="p-unknown" width="7" height="7" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
        <rect width="7" height="7" fill="var(--unknown-soft)"></rect><rect width="3" height="7" fill="var(--unknown)"></rect>
      </pattern>
      <pattern id="p-danger" width="7" height="7" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
        <rect width="7" height="7" fill="var(--danger-soft)"></rect><rect width="3" height="7" fill="var(--danger)" fill-opacity="0.75"></rect>
      </pattern>
      <pattern id="p-riskq" width="7" height="7" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
        <rect width="7" height="7" fill="var(--risk-soft)" fill-opacity="0.35"/>
        <rect width="2.5" height="7" fill="var(--risk)" fill-opacity="0.6"/>
      </pattern>
      <pattern id="p-ghost" width="7" height="7" patternUnits="userSpaceOnUse" patternTransform="rotate(135)">
        <rect width="7" height="7" fill="var(--used-ghost)" fill-opacity="0.55"></rect><rect width="4" height="7" fill="var(--used-ghost)"></rect>
      </pattern>
    </defs>
  </svg>
  <header class="top">
    <div class="wrap">
      <div class="top-row">
        <a class="brand" href="https://github.com/braitoli/team-ai-quota" target="_blank" rel="noopener">${LOGO_SVG}<span class="brand-name">Team AI Quota</span></a>
        <span class="brand-sub" id="brandSub">Claude Quota</span>
        <nav class="prov" id="provBar" aria-label="${LT("select_provider")}" hidden></nav>
        <span id="fresh" class="chip-fresh"></span>
        <span class="spacer"></span>
        <div class="filter" id="filter">
          <button type="button" class="btn" id="filterBtn" aria-haspopup="true" aria-expanded="false" aria-controls="filterPop">
            <span class="lbl" id="filterLbl">${LT("account")}</span>
            <svg class="caret" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true"><path d="M5.5 7.5L10 12l4.5-4.5" stroke="currentColor" stroke-width="1.8" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>
          </button>
          <div class="pop" id="filterPop" role="group" aria-label="${LT("filter_accounts")}" hidden></div>
        </div>
        <div class="lang-wrap">
          <select id="langSelect" class="btn btn-select" aria-label="${LT("select_lang")}">
            ${SUPPORTED_LANGUAGES.map(l => `<option value="${l.code}">${l.name}</option>`).join("")}
          </select>
        </div>
        <button type="button" class="btn btn-icon" id="settingsBtn" title="${LT("settings_btn")}" aria-label="${LT("settings_btn")}" aria-haspopup="dialog" aria-expanded="false" aria-controls="settingsModal">${ICONS.settings}</button>
        <button type="button" class="btn btn-icon" id="refreshBtn" title="${LT("refresh_data")}" aria-label="${LT("refresh_data")}">
          <svg id="refreshIcon" class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"/></svg>
        </button>
        <button type="button" class="btn btn-icon" id="themeBtn" title="${LT("toggle_theme")}" aria-label="${LT("toggle_theme")}">${SUN_ICON}${MOON_ICON}</button>
      </div>
      <nav class="prov pool-tabs" id="poolBar" aria-label="${LT("select_model_group")}" hidden></nav>
    </div>
  </header>

  <main class="wrap">
    <div id="loadErr" class="err" role="alert" hidden>${LT("load_err")}</div>

    <section id="panel-now">
      <div id="quotaPanelsNow">
        <div class="section">
          <div class="section-h"><h2 data-i18n="sec_accounts">${LT("sec_accounts")}</h2><span class="cap" data-i18n="sec_accounts_cap">${LT("sec_accounts_cap")}</span></div>
          <div class="cards" id="cards"></div>
        </div>
        <div class="section">
          <div class="section-h"><h2 data-i18n="sec_hero">${LT("sec_hero")}</h2><span class="cap" id="nowCap" data-i18n="sec_hero_cap">${LT("sec_hero_cap")}</span></div>
          <div class="panel hero" id="hero"></div>
        </div>
        <div class="section"><div class="kpis" id="nowKpis"></div></div>
        <div class="section">
          <div class="section-h"><div><h2 data-i18n="sec_timeline">${LT("sec_timeline")}</h2><div class="cap" data-i18n="sec_timeline_cap">${LT("sec_timeline_cap")}</div></div>
            <div class="legend">
              <span><span class="sw" style="background:var(--free)"></span><span data-i18n="tl_reopen">${LT("tl_reopen")}</span></span>
              <span><span class="sw seg-risk"></span><span data-i18n="tl_reset_loss">${LT("tl_reset_loss")}</span></span>
              <span><span class="sw seg-danger"></span><span data-i18n="tl_exhaust">${LT("tl_exhaust")}</span></span>
            </div>
          </div>
          <div class="panel"><div class="chart" id="timeline" style="min-height:80px"></div></div>
        </div>
        <details class="section fold">
          <summary><h2 data-i18n="sec_mach">${LT("sec_mach")}</h2><span class="cap" data-i18n="sec_mach_cap">${LT("sec_mach_cap")}</span></summary>
          <div class="panel" id="mach"></div>
        </details>
      </div>
      <details class="section fold" id="machStatsSec">
        <summary><h2 data-i18n="sec_mach_stats">${LT("sec_mach_stats")}</h2><span class="cap" data-i18n="sec_mach_stats_cap">${LT("sec_mach_stats_cap")}</span></summary>
        <div class="panel" id="machStatsNow"></div>
      </details>
    </section>

    <details class="section fold" id="histFold"><summary><h2 data-i18n="sec_hist">${LT("sec_hist")}</h2><span class="cap" data-i18n="sec_hist_cap">${LT("sec_hist_cap")}</span></summary>
    <section id="panel-hist">
      <div id="quotaPanelsHist">
        <div class="kpis" id="histKpis"></div>
        <div class="section">
          <div class="section-h"><h2 data-i18n="sec_week_hist">${LT("sec_week_hist")}</h2><span class="cap" data-i18n="sec_week_hist_cap">${LT("sec_week_hist_cap")}</span></div>
          <div class="panel" id="weekHist"></div>
        </div>
        <div class="section grid-2">
          <div>
            <div id="weekWasteSec">
              <div class="section-h"><h2 data-i18n="sec_week_waste">${LT("sec_week_waste")}</h2><span class="cap" data-i18n="sec_week_waste_cap">${LT("sec_week_waste_cap")}</span></div>
              <div class="panel"><div class="chart" id="weekWaste" style="min-height:120px"></div><div class="legend" id="weekWasteLegend" style="margin-top:8px"></div></div>
            </div>
            <div id="dailySec">
              <div class="section-h"><h2 data-i18n="sec_daily_waste">${LT("sec_daily_waste")}</h2><span class="cap" data-i18n="sec_daily_waste_cap">${LT("sec_daily_waste_cap")}</span></div>
              <div class="panel"><div class="chart" id="daily" style="min-height:120px"></div><div class="legend" id="dailyLegend" style="margin-top:8px"></div></div>
            </div>
          </div>
          <div>
            <div class="section-h"><h2 data-i18n="sec_account_eff">${LT("sec_account_eff")}</h2>
              <div class="legend"><span><span class="sw seg-used"></span><span data-i18n="seg_used">${LT("seg_used")}</span></span><span><span class="sw seg-risk"></span><span data-i18n="seg_risk">${LT("seg_risk")}</span></span><span><span class="sw seg-idle"></span><span data-i18n="seg_idle">${LT("seg_idle")}</span></span></div>
            </div>
            <div class="panel" id="eff"></div>
          </div>
        </div>
        <div class="section">
          <div class="section-h"><h2 data-i18n="sec_idle_hours">${LT("sec_idle_hours")}</h2><span class="cap"><span class="hm-scale"></span> <span data-i18n="sec_idle_hours_cap">${LT("sec_idle_hours_cap")}</span></span></div>
          <div class="panel"><div class="chart" id="heatmap" style="min-height:120px"></div><div class="cap" id="golden" style="margin-top:8px"></div></div>
        </div>
        <div class="section">
          <div class="section-h"><h2 data-i18n="sec_wlog">${LT("sec_wlog")}</h2><span class="cap" data-i18n="sec_wlog_cap">${LT("sec_wlog_cap")}</span></div>
          <div class="panel" id="wlog"></div>
        </div>
      </div>
      <div class="section" id="machHistSec">
        <div class="section-h"><h2 data-i18n="sec_mach_hist">${LT("sec_mach_hist")}</h2><span class="cap" data-i18n="sec_mach_hist_cap">${LT("sec_mach_hist_cap")}</span></div>
        <div class="panel" id="machStatsHist"></div>
      </div>
    </section>
    </details>
  </main>

  <div id="scrim" class="scrim" hidden></div>
  <aside id="drawer" class="drawer" role="dialog" aria-modal="true" aria-label="${LT("drawer_title")}" hidden><div id="drawerBody"></div></aside>
  <div id="settingsScrim" class="settings-scrim" hidden></div>
  <div id="settingsModal" class="settings-modal" role="dialog" aria-modal="true" aria-label="${LT("settings_btn")}" hidden>
    <div class="settings-h">
      <h2 id="settingsModalTitle">${ICONS.settings} ${LT("settings_title")}</h2>
      <button type="button" class="btn btn-icon" id="settingsCloseBtn" aria-label="${LT("drawer_close")}">✕</button>
    </div>
    <div id="settingsBody"></div>
    <div class="settings-foot">
      <span id="settingsStatus" class="muted" style="font-size:12px;margin-right:auto"></span>
      <button type="button" class="btn btn-ghost" id="settingsCancelBtn">${LT("settings_cancel")}</button>
      <button type="button" class="btn btn-primary" id="settingsSaveBtn">${LT("settings_save")}</button>
    </div>
  </div>
  <div id="tip" role="tooltip" hidden></div>

  <script type="application/json" id="snap-data">${dataJson}</script>
  <script type="application/json" id="i18n-data">${i18nJson}</script>
  <script>
    var __name = function (f) { return f; };
    var formatTemplate = (${formatTemplateSrc});
    window.__QUOTA_KEY = ${keyJson};
    window.__I18N = JSON.parse(document.getElementById("i18n-data").textContent);
    (${appSrc})();
  </script>
</body>
</html>`;
}
