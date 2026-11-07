import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { main, parseArgs } from "../src/cli.mjs";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { baseUrl, resolveConfig, parseDashboardLink, saveConfig, configPath } from "../src/config.mjs";
import { table } from "../src/format.mjs";

const SNAP = {
  provider: "claude",
  accounts: [
    { email: "a@x.io", state_code: "ACTIVE", used_percent: 40, weekly_used: 20, resets_at: "2026-11-07T12:00:00Z", weekly_resets_at: "2026-11-10T12:00:00Z", status: "online", at_risk_waste: 30 },
    { email: "b@x.io", state_code: "COOLDOWN", used_percent: 100, weekly_used: 96, status: "online", at_risk_waste: 0 },
  ],
  machine_stats: [{ name: "alice-mac", os: "darwin", connectivity: "online", active_email: "a@x.io", active_used_percent: 40, last_seen: "2026-11-07T01:00:00Z", client_version: "3.13" }],
  history_weekly: { weeks: [
    { account_key: "a@x.io", start_at: "2026-10-27T00:00:00Z", end_at: "2026-11-03T00:00:00Z", final_used: 70, waste: 30 },
    { account_key: "a@x.io", start_at: "2026-10-20T00:00:00Z", end_at: "2026-10-27T00:00:00Z", final_used: 50, waste: 50 },
  ] },
};
const ROUTE = { provider: "claude", recommended: { email: "a@x.io", used_percent: 40, weekly_used: 20, free_now: 60, state_code: "ACTIVE" }, alternatives: [{ email: "c@x.io", used_percent: 50, weekly_used: 30 }], total_eligible: 2 };

function server(handler) {
  return new Promise((resolve) => {
    const calls = [];
    const s = http.createServer((req, res) => {
      calls.push({ url: req.url, key: req.headers["x-api-key"] });
      if (req.headers["x-api-key"] !== "secret") { res.writeHead(401); return res.end("{}"); }
      const [code, body] = handler(req.url);
      res.writeHead(code, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    }).listen(0, "127.0.0.1", () => resolve({ s, calls, url: `http://127.0.0.1:${s.address().port}` }));
  });
}
const sink = () => { let t = ""; return { write: (x) => { t += x; }, get text() { return t; } }; };
const run = async (argv, env = {}) => { const o = sink(), e = sink(); const code = await main(argv, env, o, e); return { code, out: o.text, err: e.text }; };

test("baseUrl strips the reporter endpoint and trailing slashes", () => {
  assert.equal(baseUrl("https://w.example.workers.dev/update"), "https://w.example.workers.dev");
  assert.equal(baseUrl("https://w.example.workers.dev/"), "https://w.example.workers.dev");
});

test("config precedence: flags, then env, then reporter env", () => {
  assert.deepEqual(resolveConfig({ url: "http://f", key: "k1" }, { TAQ_URL: "http://e", TAQ_KEY: "k2" }, "/nonexistent"), { url: "http://f", key: "k1" });
  assert.deepEqual(resolveConfig({}, { TAQ_URL: "http://e/update", TAQ_KEY: "k2" }, "/nonexistent"), { url: "http://e", key: "k2" });
  assert.deepEqual(resolveConfig({}, { CLAUDE_QUOTA_WORKER_URL: "http://r/update", CLAUDE_QUOTA_SECRET_KEY: "k3" }, "/nonexistent"), { url: "http://r", key: "k3" });
});

test("parseArgs handles --flag value, --flag=value and booleans", () => {
  const p = parseArgs(["best", "--provider", "codex", "--priority-mode=5h_first", "--json"]);
  assert.equal(p.cmd, "best");
  assert.deepEqual(p.flags, { provider: "codex", "priority-mode": "5h_first", json: true });
  assert.throws(() => parseArgs(["best", "--provider"]), /needs a value/);
});

test("table pads columns", () => {
  assert.equal(table(["A", "BB"], [["xxx", "1"]]), "A    BB\nxxx  1");
});

test("best prints the recommendation and sends provider + key", async () => {
  const { s, calls, url } = await server(() => [200, ROUTE]);
  const r = await run(["best", "--provider", "codex", "--priority-mode", "5h_first"], { TAQ_URL: url, TAQ_KEY: "secret" });
  s.close();
  assert.equal(r.code, 0);
  assert.match(r.out, /Use: a@x\.io/);
  assert.match(r.out, /Next: c@x\.io/);
  assert.ok(calls[0].url.startsWith("/route?") && calls[0].url.includes("provider=codex") && calls[0].url.includes("priority_mode=5h_first"));
});

test("best --email prints only the address; exit 3 when nothing is eligible", async () => {
  let body = ROUTE;
  const { s, url } = await server(() => [200, body]);
  const env = { TAQ_URL: url, TAQ_KEY: "secret" };
  assert.equal((await run(["best", "--email"], env)).out, "a@x.io\n");
  body = { provider: "claude", recommended: null, alternatives: [], total_eligible: 0 };
  const none = await run(["best", "--email"], env);
  s.close();
  assert.equal(none.code, 3);
  assert.equal(none.out, "");
});

test("status, machines and waste render from the snapshot", async () => {
  const { s, url } = await server(() => [200, SNAP]);
  const env = { TAQ_URL: url, TAQ_KEY: "secret" };
  const st = await run(["status"], env);
  assert.match(st.out, /a@x\.io\s+ACTIVE\s+40%\s+20%/);
  assert.match(st.out, /~30% unused at reset/);
  assert.match((await run(["machines"], env)).out, /alice-mac\s+darwin\s+online\s+a@x\.io\s+40%/);
  const w = await run(["waste"], env);
  assert.match(w.out, /a@x\.io\s+2\s+60%\s+40%/);
  assert.equal(JSON.parse((await run(["status", "--json"], env)).out).provider, "claude");
  s.close();
});

test("a wrong key is reported clearly", async () => {
  const { s, url } = await server(() => [200, SNAP]);
  const r = await run(["status"], { TAQ_URL: url, TAQ_KEY: "wrong" });
  s.close();
  assert.equal(r.code, 1);
  assert.match(r.err, /rejected the access key/);
});

test("unknown command and no command", async () => {
  assert.equal((await run(["bogus"], { TAQ_URL: "http://127.0.0.1:1", TAQ_KEY: "k" })).code, 2);
  assert.equal((await run([])).code, 2);
  assert.equal((await run(["--help"])).code, 0);
});

test("dashboard link -> url + key, saved with 0600 and read back", () => {
  assert.deepEqual(parseDashboardLink("https://w.example.workers.dev/?key=abc123&provider=claude"), { url: "https://w.example.workers.dev", key: "abc123" });
  assert.equal(parseDashboardLink("https://w.example.workers.dev/"), null);
  assert.equal(parseDashboardLink("not a url"), null);
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "taq-home-"));
  const file = saveConfig({ url: "https://w.example.workers.dev/update", key: " abc123 " }, home);
  assert.equal(file, configPath(home));
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.deepEqual(resolveConfig({}, {}, home), { url: "https://w.example.workers.dev", key: "abc123" });
  saveConfig({ key: "zzz" }, home);
  assert.deepEqual(resolveConfig({}, {}, home), { url: "https://w.example.workers.dev", key: "zzz" });
});

test("login rejects a link without a key and never prints the key", async () => {
  const bad = await run(["login", "https://w.example.workers.dev/"]);
  assert.equal(bad.code, 2);
  const cfg = await run(["config"], { TAQ_URL: "http://x", TAQ_KEY: "supersecretvalue" });
  assert.ok(!cfg.out.includes("supersecretvalue"));
});
