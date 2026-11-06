// Guard for a private/production deployment: its code must not carry the public placeholders.
// Opt-in (skipped in forks and the public repo): set repo variable PROD_DEFAULTS_EXPECTED=1, and optionally
// EXPECTED_STORAGE_PREFIX (e.g. "braitoli_") for the dashboard's localStorage keys. See docs/CI_CD.md.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const on = process.env.PROD_DEFAULTS_EXPECTED === "1";
const read = (p) => fs.readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
const PLACEHOLDER = /your-worker|your-org|example\.com|yourteam/i;

test("production defaults: client worker URL and update repo are not placeholders", { skip: !on && "PROD_DEFAULTS_EXPECTED not set" }, () => {
  const py = read("client/report_quota.py");
  for (const name of ["DEFAULT_WORKER_URL", "UPDATE_REPO"]) {
    const m = py.match(new RegExp(`^${name}\\s*=\\s*"([^"]*)"`, "m"));
    assert.ok(m, `${name} not found`);
    assert.doesNotMatch(m[1], PLACEHOLDER, `${name} is a public placeholder: ${m[1]}`);
  }
});

test("production defaults: dashboard localStorage keys keep the deployment prefix", { skip: (!on || !process.env.EXPECTED_STORAGE_PREFIX) && "EXPECTED_STORAGE_PREFIX not set" }, () => {
  const prefix = process.env.EXPECTED_STORAGE_PREFIX;
  const js = read("src/dashboard.js");
  for (const name of ["KEY_STORE", "FILTER_STORE", "HIST_STORE", "PROV_STORE", "POOL_STORE"]) {
    const m = js.match(new RegExp(`var ${name} = "([^"]*)"`));
    assert.ok(m, `${name} not found`);
    assert.ok(m[1].startsWith(prefix), `${name} = ${m[1]} must start with ${prefix}`);
  }
});

test("production defaults: macOS LaunchAgent labels keep the deployment prefix", { skip: (!on || !process.env.EXPECTED_LAUNCHD_PREFIX) && "EXPECTED_LAUNCHD_PREFIX not set" }, () => {
  const prefix = process.env.EXPECTED_LAUNCHD_PREFIX;
  const sh = read("scripts/setup-mac.sh");
  const labels = [...sh.matchAll(/<string>(com\.[a-z0-9.-]+quota-monitor)<\/string>/g)].map((m) => m[1]);
  assert.ok(labels.length >= 3, "expected 3 LaunchAgent labels");
  for (const l of labels) assert.ok(l.startsWith(prefix), `label ${l} must start with ${prefix}`);
});
