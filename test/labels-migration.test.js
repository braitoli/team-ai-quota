import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createServer } from "../src/standalone-server.js";

const KEY = "labels-migration-key";
const H = { "x-api-key": KEY, "content-type": "application/json" };

const running = new Set();
async function start(dir, machineLabels) {
  const app = createServer({ port: 0, host: "127.0.0.1", dataDir: dir, secretKey: KEY, machineLabels });
  await new Promise((r) => app.listen(r));
  running.add(app);
  return { app, base: `http://127.0.0.1:${app.server.address().port}` };
}
const stop = async (app) => { app.server.closeAllConnections(); await app.close(); running.delete(app); };
const names = async (base) => {
  const s = await (await fetch(`${base}/status`, { headers: H })).json();
  return (s.machine_stats || []).map((m) => m.name).sort();
};
const report = (base, email, mid) =>
  fetch(`${base}/update`, {
    method: "POST",
    headers: H,
    body: JSON.stringify({
      email, used_percent: 10, resets_at: new Date(Date.now() + 3 * 3600e3).toISOString(), limits: [],
      fetched_at: Date.now(), machine_id: mid, machine_name: "Mac.local", client_version: "3.12", token_state: "ok",
    }),
  });

test("machine names: none built in; MACHINE_LABELS fills in under saved Settings labels on an existing install", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cqm-labels-"));
  try {
    // 1. no config at all: raw machine names only
    let { app, base } = await start(dir, "");
    await report(base, "a@x.io", "a1b2c3aaaaaaaaaaaaaaaaaaaaaaaaaa");
    await report(base, "b@x.io", "d4e5f6bbbbbbbbbbbbbbbbbbbbbbbbbb");
    assert.deepEqual(await names(base), ["Mac", "Mac"]);
    // 2. a saved label (stored Settings now exist)
    await fetch(`${base}/api/settings`, { method: "POST", headers: H, body: JSON.stringify({ machine_labels: { "d4e5f6": "Saved" } }) });
    await stop(app);
    // 3. restart with deployment config: fills the missing label, never overrides the saved one
    ({ app, base } = await start(dir, JSON.stringify({ "a1b2c3": "FromEnv", "d4e5f6": "EnvLoses" })));
    // the snapshot is rebuilt by the next report (clients report every few minutes)
    await report(base, "a@x.io", "a1b2c3aaaaaaaaaaaaaaaaaaaaaaaaaa");
    assert.deepEqual(await names(base), ["FromEnv", "Saved"]);
    await stop(app);
    // 4. restart without config: names persisted
    ({ app, base } = await start(dir, ""));
    assert.deepEqual(await names(base), ["FromEnv", "Saved"]);
    await stop(app);
  } finally {
    for (const a of running) { try { a.server.closeAllConnections(); await a.close(); } catch {} }
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
