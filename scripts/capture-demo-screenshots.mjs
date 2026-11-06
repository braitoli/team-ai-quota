import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { createServer } from "../src/standalone-server.js";

const PORT = 18799;
const DATA_DIR = "/tmp/cqm-demo";
const DB_PATH = "/tmp/cqm-demo-screenshots.sqlite";

// Clean old files
if (fs.existsSync(DB_PATH)) fs.rmSync(DB_PATH, { force: true });
if (fs.existsSync(DATA_DIR)) fs.rmSync(DATA_DIR, { recursive: true, force: true });
fs.mkdirSync(DATA_DIR, { recursive: true });

console.log("[1/5] Starting local server on PORT=" + PORT + "...");
const app = createServer({
  port: PORT,
  host: "127.0.0.1",
  dataDir: DATA_DIR,
});

await new Promise((resolve) => app.listen(resolve));
console.log(`Server listening at http://127.0.0.1:${PORT}`);

const BASE = `http://127.0.0.1:${PORT}`;
const now = Date.now();
const H = 3600 * 1000;
const D = 24 * H;
const M = 60 * 1000;

async function postReport(body) {
  const res = await fetch(`${BASE}/api/report`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) console.error("Report failed:", data);
  return data;
}

async function postSettings(provider, patch) {
  const res = await fetch(`${BASE}/api/settings?provider=${provider}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(patch),
  });
  return await res.json();
}

console.log("[2/5] Seeding settings and accounts...");

const settingsPatch = {
  providers: {
    claude:  { enabled: true, windows: { "7d": true, "5h": true, "30d": false }, weight_7d: 0.45, weight_5h: 0.35 },
    codex:   { enabled: true, windows: { "7d": true, "5h": true, "30d": false }, weight_7d: 0.45, weight_5h: 0.35 },
    agy:     { enabled: true, windows: { "7d": true, "5h": true, "30d": false }, weight_7d: 0.45, weight_5h: 0.35 },
    gemini:  { enabled: true, windows: { "7d": true, "5h": true, "30d": false }, weight_7d: 0.45, weight_5h: 0.35 },
    copilot: { enabled: true, windows: { "7d": true, "5h": true, "30d": true  }, weight_7d: 0.45, weight_5h: 0.35, monthly_reset_day: 1 },
    cursor:  { enabled: true, windows: { "7d": true, "5h": true, "30d": true  }, weight_7d: 0.45, weight_5h: 0.35, monthly_reset_day: 1 },
  },
  priority_mode: "7d_first",
  machine_labels: {
    "Alice-MBP-M3": "Alice · MacBook Pro M3",
    "Bob-Linux-WS": "Bob · Ubuntu Workstation",
    "Carol-MacStudio": "Carol · Mac Studio",
    "Dave-DevBox": "Dave · DevBox",
    "Eve-ThinkPad": "Eve · ThinkPad X1",
  },
  account_labels: {
    "eng-pool-01@example.com": "Pool #1 · Backend Squad",
    "eng-pool-02@example.com": "Pool #2 · Core Infra",
    "eng-pool-03@example.com": "Pool #3 · AI Research",
    "eng-pool-04@example.com": "Pool #4 · Mobile Squad",
    "codex-team@example.com": "Codex · Platform Team",
    "copilot-ent@example.com": "Copilot · Enterprise Seat",
  },
};

await postSettings("claude", settingsPatch);

// 4. eng-pool-04@example.com: Weekly reset ready (capped 18h ago, reset passed 2h ago)
await postReport({
  provider: "claude",
  email: "eng-pool-04@example.com",
  used_percent: 100,
  resets_at: new Date(now - 2 * H).toISOString(),
  fetched_at: now - 18 * H,
  five_hour_disabled: true,
  machine_id: "Frank-Linux-Dev",
  machine_name: "Frank Linux Workstation",
  os: "linux",
  client_version: "3.11",
  limits: [
    { kind: "seven_day", group: "weekly", percent: 100, resets_at: new Date(now - 2 * H).toISOString() },
  ],
});

// 1. eng-pool-01@example.com: Idle, 0 machines, 84% 7d free, 92% 5h free -> Ranked #1 Hero recommendation
await postReport({
  provider: "claude",
  email: "eng-pool-01@example.com",
  used_percent: 8,
  resets_at: new Date(now + 3.8 * H).toISOString(),
  fetched_at: now - 50 * M,
  machine_id: "Alice-MBP-M3",
  machine_name: "Alice MacBook Pro M3",
  os: "mac",
  client_version: "3.11",
  limits: [
    { kind: "seven_day", group: "weekly", percent: 16, resets_at: new Date(now + 5.1 * D).toISOString() },
  ],
});

// 2. eng-pool-02@example.com: 1 active machine (Alice-MBP-M3), 7d 62% free, 5h 74% free, burn 0.4%/h
await postReport({
  provider: "claude",
  email: "eng-pool-02@example.com",
  used_percent: 25.6,
  resets_at: new Date(now + 3.2 * H).toISOString(),
  fetched_at: now - 35 * M,
  machine_id: "Alice-MBP-M3",
  machine_name: "Alice MacBook Pro M3",
  os: "mac",
  client_version: "3.11",
  limits: [
    { kind: "seven_day", group: "weekly", percent: 38, resets_at: new Date(now + 4.5 * D).toISOString() },
  ],
});

await postReport({
  provider: "claude",
  email: "eng-pool-02@example.com",
  used_percent: 26.0,
  resets_at: new Date(now + 3.2 * H).toISOString(),
  fetched_at: now - 2 * M,
  machine_id: "Alice-MBP-M3",
  machine_name: "Alice MacBook Pro M3",
  os: "mac",
  client_version: "3.11",
  limits: [
    { kind: "seven_day", group: "weekly", percent: 38, resets_at: new Date(now + 4.5 * D).toISOString() },
  ],
});

// 3. eng-pool-03@example.com: Collision: 2 machines Bob-Linux-WS + Carol-MacStudio, 7d 18% free, burn 2.8%/h
const weeklyReset3 = new Date(now + 138.72 * H).toISOString();
await postReport({
  provider: "claude",
  email: "eng-pool-03@example.com",
  used_percent: 64,
  resets_at: new Date(now + 1.8 * H).toISOString(),
  fetched_at: now - 5 * M,
  machine_id: "Bob-Linux-WS",
  machine_name: "Bob Ubuntu Workstation",
  os: "linux",
  client_version: "3.11",
  limits: [
    { kind: "seven_day", group: "weekly", percent: 82, resets_at: weeklyReset3 },
  ],
});

await postReport({
  provider: "claude",
  email: "eng-pool-03@example.com",
  used_percent: 65,
  resets_at: new Date(now + 1 * M).toISOString(),
  fetched_at: now - 1 * M,
  machine_id: "Carol-MacStudio",
  machine_name: "Carol Mac Studio",
  os: "mac",
  client_version: "3.11",
  limits: [
    { kind: "seven_day", group: "weekly", percent: 82, resets_at: weeklyReset3 },
  ],
});

// 5. codex-team@example.com: codex Pro, 1 active Dave-DevBox, 7d 71% free, 5h 80% free
await postReport({
  provider: "codex",
  email: "codex-team@example.com",
  used_percent: 20,
  resets_at: new Date(now + 4 * H).toISOString(),
  fetched_at: now - 3 * M,
  machine_id: "Dave-DevBox",
  machine_name: "Dave DevBox",
  os: "linux",
  client_version: "1.5",
  limits: [
    { kind: "seven_day", group: "weekly", percent: 29, resets_at: new Date(now + 5.2 * D).toISOString() },
  ],
});

// 6. copilot-ent@example.com: copilot Enterprise, 1 active Eve-ThinkPad, 30d 68% free, 5h 90% free
await postReport({
  provider: "copilot",
  email: "copilot-ent@example.com",
  used_percent: 10,
  resets_at: new Date(now + 4.5 * H).toISOString(),
  fetched_at: now - 4 * M,
  machine_id: "Eve-ThinkPad",
  machine_name: "Eve ThinkPad X1",
  os: "windows",
  client_version: "2.1",
  monthly_used_percent: 32,
  monthly_quota_limit: 300,
  monthly_quota_used: 96,
  monthly_resets_at: new Date(now + 24 * D).toISOString(),
  limits: [
    { kind: "seven_day", group: "weekly", percent: 25, resets_at: new Date(now + 6 * D).toISOString() },
  ],
});

console.log("[3/5] Launching Headless Chrome via CDP...");
const chromeProc = spawn("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", [
  "--headless=new",
  "--remote-debugging-port=9222",
  "--disable-gpu",
  "--no-sandbox",
  "--window-size=1440,950",
  "--force-device-scale-factor=2",
  "about:blank",
]);

await new Promise((r) => setTimeout(r, 1200));

const targetRes = await fetch("http://127.0.0.1:9222/json/new?about:blank", { method: "PUT" });
const targetData = await targetRes.json();
const ws = new WebSocket(targetData.webSocketDebuggerUrl);

await new Promise((resolve) => {
  ws.onopen = resolve;
});

let msgId = 1;
const pending = new Map();
ws.onmessage = (event) => {
  const msg = JSON.parse(event.data);
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    if (msg.error) reject(msg.error);
    else resolve(msg.result);
  }
};

function send(method, params = {}) {
  const curId = msgId++;
  return new Promise((resolve, reject) => {
    pending.set(curId, { resolve, reject });
    ws.send(JSON.stringify({ id: curId, method, params }));
  });
}

await send("Page.enable");
await send("Runtime.enable");
await send("DOM.enable");
await send("Emulation.setDeviceMetricsOverride", {
  width: 1440,
  height: 950,
  deviceScaleFactor: 2,
  mobile: false,
});

async function capture(filePath, clip = null) {
  const params = { format: "png" };
  if (clip) params.clip = clip;
  const shot = await send("Page.captureScreenshot", params);
  const buf = Buffer.from(shot.data, "base64");
  fs.writeFileSync(filePath, buf);
  const kb = Math.round(buf.length / 1024);
  console.log(`  -> Saved ${filePath} (${kb} KB)`);
  return kb;
}

const outDir = path.resolve("docs/assets");
fs.mkdirSync(outDir, { recursive: true });

console.log("[4/5] Capturing screenshots...");

// One set of screenshots per UI language, so each README only shows its own language.
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
for (const lang of ["en", "vi"]) {
  console.log(`Language: ${lang}`);
  await send("Page.navigate", { url: `http://127.0.0.1:${PORT}` });
  await wait(1000);
  await send("Runtime.evaluate", { expression: `localStorage.setItem('cqm_lang', '${lang}'); window.location.reload();` });
  await wait(2200);
  await capture(path.join(outDir, `dashboard-overview-${lang}.png`));

  await send("Runtime.evaluate", { expression: `document.getElementById('settingsBtn').click();` });
  await wait(1200);
  await capture(path.join(outDir, `settings-modal-${lang}.png`));
  await send("Runtime.evaluate", { expression: `document.getElementById('settingsCloseBtn').click();` });
  await wait(600);

  await send("Runtime.evaluate", {
    expression: `const el = document.querySelector('[data-open="eng-pool-03@example.com"]'); if (el) el.click();`,
  });
  await wait(1200);
  await capture(path.join(outDir, `machine-drawer-${lang}.png`));
  await send("Runtime.evaluate", { expression: `document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));` });
  await wait(400);
}

console.log("[5/5] Cleaning up processes...");
ws.close();
chromeProc.kill();
await app.close();

console.log("Done! All screenshots captured and saved to docs/assets/");
