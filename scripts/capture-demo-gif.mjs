#!/usr/bin/env node
// Records docs/assets/demo.gif: a scroll tour of docs/demo/index.html (sample data) in English, then Vietnamese.
// Needs Google Chrome (macOS path below, override with CHROME_BIN) and ffmpeg. Run `npm run build:demo` first.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CHROME = process.env.CHROME_BIN || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PORT = 9333;
const W = 1280, H = 800;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cqm-gif-"));
const chrome = spawn(CHROME, ["--headless=new", `--remote-debugging-port=${PORT}`, "--disable-gpu", "--no-sandbox",
  `--window-size=${W},${H}`, `--user-data-dir=${path.join(tmp, "profile")}`, "about:blank"], { stdio: "ignore" });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
try {
  await sleep(1500);
  const target = await (await fetch(`http://127.0.0.1:${PORT}/json/new?about:blank`, { method: "PUT" })).json();
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r) => (ws.onopen = r));
  let id = 1; const pending = new Map();
  ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id); } };
  const send = (method, params = {}) => new Promise((r) => { const i = id++; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
  const evaluate = async (expression) => (await send("Runtime.evaluate", { expression, returnByValue: true })).result?.value;
  await send("Page.enable");
  await send("Emulation.setDeviceMetricsOverride", { width: W, height: H, deviceScaleFactor: 1, mobile: false });
  let n = 0;
  const shot = async () => { const s = await send("Page.captureScreenshot", { format: "png" }); fs.writeFileSync(path.join(tmp, `f${String(n++).padStart(3, "0")}.png`), Buffer.from(s.data, "base64")); };
  const load = async (lang) => {
    await send("Page.navigate", { url: "file://" + path.join(ROOT, "docs/demo/index.html") });
    await sleep(1200);
    await evaluate(`try{localStorage.setItem('cqm_lang','${lang}')}catch(e){}; location.reload()`);
    await sleep(2200);
  };
  for (const lang of ["en", "vi"]) {
    await load(lang);
    const total = await evaluate("document.documentElement.scrollHeight");
    const steps = lang === "en" ? 9 : 4;
    const stride = Math.max(1, (total - H) / (steps - 1));
    for (let i = 0; i < steps; i++) {
      await evaluate(`window.scrollTo(0, ${Math.round(i * stride)})`);
      await sleep(500);
      await shot();
    }
  }
  ws.close();
  const out = path.join(ROOT, "docs/assets/demo.gif");
  const r = spawnSync("ffmpeg", ["-y", "-loglevel", "error", "-framerate", "1.2", "-i", path.join(tmp, "f%03d.png"),
    "-vf", "scale=960:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=96[p];[b][p]paletteuse=dither=bayer:bayer_scale=4", "-loop", "0", out], { stdio: "inherit" });
  if (r.status !== 0) throw new Error("ffmpeg failed");
  console.log(`wrote docs/assets/demo.gif (${Math.round(fs.statSync(out).size / 1024)} KB, ${n} frames)`);
} finally {
  chrome.kill();
  await sleep(800);
  fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
}
