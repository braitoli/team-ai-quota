#!/usr/bin/env node
// Builds docs/demo/index.html: the real dashboard rendered from synthetic sample data (no server, no key).
// Usage: node scripts/build-demo.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "../src/standalone-server.js";
import { renderDashboardPage } from "../src/dashboard.js";

const KEY = "demo-key";
const H = { "x-api-key": KEY, "content-type": "application/json" };
const HOUR = 3600e3;
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const MACHINES = [
  { id: "a1b2c3", name: "Alice-MBP", os: "darwin" },
  { id: "d4e5f6", name: "Bob-Linux", os: "linux" },
  { id: "0a9b8c", name: "Carol-Win", os: "win32" },
  { id: "7c6d5e", name: "CI-Runner", os: "linux" },
];
// account -> machines using it (and relative weight of use)
const ACCOUNTS = [
  { email: "alice@acme.dev", uses: { "a1b2c3": 3, "7c6d5e": 1 }, rate: 0.55 },
  { email: "bob@acme.dev", uses: { "d4e5f6": 3 }, rate: 0.4 },
  { email: "carol@acme.dev", uses: { "0a9b8c": 2, "a1b2c3": 1 }, rate: 0.7 },
  { email: "team-shared@acme.dev", uses: { "7c6d5e": 3, "d4e5f6": 1, "0a9b8c": 1 }, rate: 0.3 },
  { email: "dave@acme.dev", uses: { "d4e5f6": 1 }, rate: 0.15 },
];

// deterministic pseudo-random so the page is reproducible
let seed = 42;
const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cqm-demo-"));
const app = createServer({ port: 0, host: "127.0.0.1", dataDir: dir, secretKey: KEY, machineLabels: "" });
await new Promise((r) => app.listen(r));
const base = `http://127.0.0.1:${app.server.address().port}`;

try {
  const now = Date.now();
  const start = now - 6 * 24 * HOUR;
  const weeklyReset = new Date(now + 1 * 24 * HOUR).toISOString();
  const lastTs = new Map(); // email|machine -> last report time (ms)
  for (let t = start; t <= now; t += 3 * HOUR) {
    for (const acc of ACCOUNTS) {
      const hourOfDay = new Date(t).getUTCHours();
      const active = hourOfDay >= 2 && hourOfDay <= 11; // working hours (UTC)
      const elapsed = (t - start) / (6 * 24 * HOUR);
      // 5h usage: a sawtooth that resets every 5h window
      const windowPos = ((t - start) / HOUR) % 5;
      const used5h = Math.min(100, Math.max(0, (active ? 12 + windowPos * 14 * acc.rate * 2 : 3) + rnd() * 6));
      const weekly = Math.min(100, 4 + elapsed * 100 * acc.rate * 0.85 + rnd() * 2);
      const resets5h = new Date(t + (5 - windowPos) * HOUR).toISOString();
      const pick = Object.entries(acc.uses);
      const total = pick.reduce((s, [, w]) => s + w, 0);
      let r = rnd() * total;
      const [mid] = pick.find(([, w]) => (r -= w) < 0) || pick[0];
      const m = MACHINES.find((x) => x.id === mid);
      const key = `${acc.email}|${mid}`;
      const since = lastTs.get(key) ?? null;
      lastTs.set(key, t);
      const body = {
        email: acc.email,
        used_percent: Math.round(used5h * 10) / 10,
        resets_at: resets5h,
        limits: [{ kind: "weekly", group: "weekly", percent: Math.round(weekly * 10) / 10, resets_at: weeklyReset, is_active: true }],
        fetched_at: t,
        machine_id: m.id.padEnd(32, "0"),
        machine_name: m.name,
        os: m.os,
        client_version: "3.12",
        token_state: "ok",
      };
      if (since && active) {
        const msgs = Math.round(20 + rnd() * 120 * acc.rate);
        body.token_delta = { since, until: t, input: msgs * 4200, output: msgs * 650, msgs };
      }
      const res = await fetch(`${base}/update`, { method: "POST", headers: H, body: JSON.stringify(body) });
      if (!res.ok) throw new Error(`report failed: ${res.status} ${await res.text()}`);
    }
  }
  const snap = await (await fetch(`${base}/status`, { headers: H })).text();
  let html = renderDashboardPage(snap, "");
  html = html
    .replace("<title>Team AI Quota</title>", "<title>Team AI Quota — live demo (sample data)</title>")
    .replace('<meta name="robots" content="noindex">', '<meta name="robots" content="index,follow">')
    .replace(
      "<body",
      '<body data-demo="1"'
    )
    .replace(
      /(<body[^>]*>)/,
      '$1<div style="position:sticky;top:0;z-index:9999;background:#4f46e5;color:#fff;text-align:center;padding:6px 12px;font:600 13px system-ui">' +
        'Demo with synthetic sample data. Nothing here is real. ' +
        '<a style="color:#fff;text-decoration:underline" href="https://github.com/braitoli/team-ai-quota">Get Team AI Quota on GitHub</a></div>'
    );
  const out = path.join(ROOT, "docs", "demo", "index.html");
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, html);
  console.log(`wrote ${path.relative(ROOT, out)} (${(html.length / 1024).toFixed(0)} KB)`);
} finally {
  app.server.closeAllConnections();
  await app.close();
  fs.rmSync(dir, { recursive: true, force: true });
}
