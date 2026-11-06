import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createServer } from "../src/standalone-server.js";

const TEST_KEY = "enterprise-secret-key-999";

test("Enterprise & Team Scenarios - Standalone SQLite Engine", async (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cqm-team-test-"));

  const app = createServer({
    port: 0,
    host: "127.0.0.1",
    dataDir: tempDir,
    secretKey: TEST_KEY,
  });

  await new Promise((resolve) => app.listen(resolve));
  const port = app.server.address().port;
  const baseUrl = `http://127.0.0.1:${port}`;
  const now = Date.now();

  try {
    await t.test("1. Multi-member load balancing & quota distribution", async () => {
      // Dev 1 reports for dev1-seat
      const res1 = await fetch(`${baseUrl}/api/update?key=${TEST_KEY}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          provider: "claude",
          email: "dev1-seat@example.com",
          used_percent: 25,
          resets_at: new Date(now + 3 * 3600 * 1000).toISOString(),
          machine_id: "mac-m3-alice",
          machine_name: "Alice MacBook Pro",
          limits: [{ group: "weekly", percent: 20, resets_at: new Date(now + 4 * 86400 * 1000).toISOString() }],
        }),
      });
      assert.equal(res1.status, 200);

      // Dev 2 reports for dev2-seat
      const res2 = await fetch(`${baseUrl}/api/update?key=${TEST_KEY}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          provider: "claude",
          email: "dev2-seat@example.com",
          used_percent: 60,
          resets_at: new Date(now + 2 * 3600 * 1000).toISOString(),
          machine_id: "linux-workstation-bob",
          machine_name: "Bob Dell Workstation",
          limits: [{ group: "weekly", percent: 75, resets_at: new Date(now + 3 * 86400 * 1000).toISOString() }],
        }),
      });
      assert.equal(res2.status, 200);

      const statusRes = await fetch(`${baseUrl}/api/status?key=${TEST_KEY}&provider=claude`);
      assert.equal(statusRes.status, 200);
      const snap = await statusRes.json();
      assert.equal(snap.total_accounts, 2);
      assert.equal(snap.total_machines, 2);
    });

    await t.test("2. Seat collision detection when multiple workstations share one account", async () => {
      // Machine 1 reports for shared-pool@example.com
      await fetch(`${baseUrl}/api/update?key=${TEST_KEY}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          provider: "claude",
          email: "shared-pool@example.com",
          used_percent: 30,
          resets_at: new Date(now + 3 * 3600 * 1000).toISOString(),
          machine_id: "workstation-alpha",
          machine_name: "Alpha Machine",
        }),
      });

      // Machine 2 reports for the SAME shared-pool@example.com concurrently
      await fetch(`${baseUrl}/api/update?key=${TEST_KEY}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          provider: "claude",
          email: "shared-pool@example.com",
          used_percent: 55,
          resets_at: new Date(now + 3 * 3600 * 1000).toISOString(),
          machine_id: "workstation-beta",
          machine_name: "Beta Machine",
        }),
      });

      const statusRes = await fetch(`${baseUrl}/api/status?key=${TEST_KEY}&provider=claude`);
      const snap = await statusRes.json();
      const shared = Object.values(snap.accounts).find((a) => a.email === "shared-pool@example.com");

      assert.ok(shared, "shared-pool account must exist");
      assert.equal(shared.collision, true, "collision must be flagged true");
      assert.equal(shared.seat_collision, true, "seat_collision must be true");
      assert.equal(shared.active_machines.length, 2, "must have 2 active machines concurrently");
      const machineIds = shared.active_machines.map((m) => m.machine_id);
      assert.ok(machineIds.includes("workstation-alpha"));
      assert.ok(machineIds.includes("workstation-beta"));
    });

    await t.test("3. Workstation handoff tracking (machine migration between accounts)", async () => {
      // Machine workstation-beta now switches from shared-pool to dedicated@example.com
      await fetch(`${baseUrl}/api/update?key=${TEST_KEY}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          provider: "claude",
          email: "dedicated@example.com",
          used_percent: 15,
          resets_at: new Date(now + 4 * 3600 * 1000).toISOString(),
          machine_id: "workstation-beta",
          machine_name: "Beta Machine",
        }),
      });

      const statusRes = await fetch(`${baseUrl}/api/status?key=${TEST_KEY}&provider=claude`);
      const snap = await statusRes.json();

      // Check dedicated account has workstation-beta as active
      const dedicated = Object.values(snap.accounts).find((a) => a.email === "dedicated@example.com");
      assert.ok(dedicated);
      assert.equal(dedicated.active_machines.length, 1);
      assert.equal(dedicated.active_machines[0].machine_id, "workstation-beta");

      // Check shared-pool account has workstation-beta in detached_machines with moved_to
      const shared = Object.values(snap.accounts).find((a) => a.email === "shared-pool@example.com");
      assert.ok(shared);
      assert.equal(shared.collision, false, "collision must clear once machine moves away");
      assert.equal(shared.active_machines.length, 1);
      assert.equal(shared.active_machines[0].machine_id, "workstation-alpha");

      const detached = shared.detached_machines.find((m) => m.machine_id === "workstation-beta");
      assert.ok(detached, "workstation-beta must be in detached_machines list");
      assert.equal(detached.moved_to, "dedicated@example.com");
    });

    await t.test("4. Burn-rate velocity, surplus/deficit and projected exhaustion calculation", async () => {
      const burnEmail = "heavy-user@example.com";
      const winReset = new Date(now + 2 * 3600 * 1000).toISOString();

      // High velocity user burning 75% with 2 hours remaining (raw_projection = 125%)
      await fetch(`${baseUrl}/api/update?key=${TEST_KEY}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          provider: "claude",
          email: burnEmail,
          used_percent: 75,
          resets_at: winReset,
          machine_id: "heavy-box",
        }),
      });

      const statusRes = await fetch(`${baseUrl}/api/status?key=${TEST_KEY}&provider=claude`);
      const snap = await statusRes.json();
      const heavy = Object.values(snap.accounts).find((a) => a.email === burnEmail);

      assert.ok(heavy);
      assert.equal(heavy.state_code, "ACTIVE");
      assert.ok(heavy.burn_rate_1h > 0, "burn_rate_1h must be calculated");
      assert.ok(heavy.velocity > 0, "velocity must match rate");
      assert.ok(heavy.projected_exhaustion !== null, "projected_exhaustion date must be present");
      assert.equal(heavy.pacing_status, "danger", "rapid consumption must trigger danger pacing");
    });

    await t.test("5. Automatic weekly reset recovery for offline accounts (weekly_reset_ready === true)", async () => {
      const resetEmail = "weekly-capped-dev@example.com";
      // An account was capped at 99%, but weekly_resets_at was 2 hours ago
      await fetch(`${baseUrl}/api/update?key=${TEST_KEY}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          provider: "claude",
          email: resetEmail,
          used_percent: 0,
          resets_at: null,
          machine_id: "idle-mac",
          limits: [
            { group: "weekly", percent: 99, resets_at: new Date(now - 2 * 3600 * 1000).toISOString() },
          ],
        }),
      });

      const statusRes = await fetch(`${baseUrl}/api/status?key=${TEST_KEY}&provider=claude`);
      const snap = await statusRes.json();
      const recovered = Object.values(snap.accounts).find((a) => a.email === resetEmail);

      assert.ok(recovered);
      assert.equal(recovered.weekly_reset_ready, true, "weekly_reset_ready must be true");
      assert.equal(recovered.weekly_capped, false, "weekly_capped must be cleared");
      assert.equal(recovered.state_code, "FRESH", "state_code must recover to FRESH");
      assert.equal(recovered.free_now, 100, "free_now must be 100%");
    });

    await t.test("6. Smart routing: weighted load balancing (7d headroom > 5h headroom)", async () => {
      const routeRes = await fetch(`${baseUrl}/api/route?key=${TEST_KEY}&provider=claude`);
      assert.equal(routeRes.status, 200);
      const route = await routeRes.json();

      assert.equal(route.provider, "claude");
      assert.ok(route.recommended, "must recommend an account");
      // The recovered FRESH account with 100% weekly headroom should be recommended first!
      assert.equal(route.recommended.email, "weekly-capped-dev@example.com");
      assert.equal(route.recommended.routing_score, 0);
      assert.ok(route.alternatives.length >= 2, "must list alternative eligible seats");
    });

    await t.test("7. Labels and Settings API synchronization & governance", async () => {
      // Configure human-readable labels
      const labelRes = await fetch(`${baseUrl}/api/labels?key=${TEST_KEY}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          machine_labels: {
            "mac-m3-alice": "Alice-Laptop",
            "heavy-box": "High-Velocity-Test-Box",
          },
          account_labels: {
            "dev1-seat@example.com": "Frontend Squad Lead Seat",
            "shared-pool@example.com": "Automated CI/CD Worker Pool",
          },
        }),
      });
      assert.equal(labelRes.status, 200);
      const labelData = await labelRes.json();
      assert.equal(labelData.settings.machine_labels["mac-m3-alice"], "Alice-Laptop");
      assert.equal(labelData.settings.account_labels["dev1-seat@example.com"], "Frontend Squad Lead Seat");

      // Verify dashboard SSR embeds the labels
      const dashRes = await fetch(`${baseUrl}/?key=${TEST_KEY}`);
      assert.equal(dashRes.status, 200);
      const dashHtml = await dashRes.text();
      assert.match(dashHtml, /Frontend Squad Lead Seat/);
      assert.match(dashHtml, /Alice-Laptop/);
      assert.match(dashHtml, /id="settingsModal"/);
      assert.match(dashHtml, /window\.__I18N/);

      // Verify toggle provider via POST /api/settings
      const settRes = await fetch(`${baseUrl}/api/settings?key=${TEST_KEY}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          providers: {
            copilot: { enabled: true, weight_7d: 0.5, weight_5h: 0.3 },
          },
          priority_mode: "7d_first",
        }),
      });
      assert.equal(settRes.status, 200);
      const settData = await settRes.json();
      assert.equal(settData.settings.providers.copilot.enabled, true);
      assert.equal(settData.settings.providers.copilot.weight_7d, 0.5);
    });

    await t.test("8. Multi-provider enterprise isolation (Codex & Copilot 30d)", async () => {
      // Report Codex
      await fetch(`${baseUrl}/api/update?key=${TEST_KEY}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          provider: "codex",
          email: "codex-dev@example.com",
          used_percent: 18,
          resets_at: new Date(now + 4 * 3600 * 1000).toISOString(),
          machine_id: "dev-codex-box",
        }),
      });

      // Report Copilot with monthly quota
      await fetch(`${baseUrl}/api/update?key=${TEST_KEY}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          provider: "copilot",
          email: "copilot-enterprise@example.com",
          used_percent: 0,
          resets_at: null,
          monthly_used_percent: 42,
          monthly_resets_at: new Date(now + 20 * 86400 * 1000).toISOString(),
          monthly_quota_limit: 5000,
          monthly_quota_used: 2100,
          machine_id: "copilot-dev-mac",
        }),
      });

      const codexRes = await fetch(`${baseUrl}/api/status?key=${TEST_KEY}&provider=codex`);
      const codexSnap = await codexRes.json();
      assert.equal(codexSnap.provider, "codex");
      assert.equal(codexSnap.total_accounts, 1);

      const copilotRes = await fetch(`${baseUrl}/api/status?key=${TEST_KEY}&provider=copilot`);
      const copilotSnap = await copilotRes.json();
      assert.equal(copilotSnap.provider, "copilot");
      const copilotAcc = Object.values(copilotSnap.accounts)[0];
      assert.equal(copilotAcc.monthly_used_percent, 42);
      assert.equal(copilotAcc.monthly_free_now, 58);
      assert.equal(copilotAcc.monthly_quota_limit, 5000);
      assert.equal(copilotAcc.monthly_quota_used, 2100);
    });

    await app.close();

    // 9. Persistence across server restart
    await t.test("9. SQLite persistence: restart server and verify state", async () => {
      const appRestarted = createServer({
        port: 0,
        host: "127.0.0.1",
        dataDir: tempDir,
        secretKey: TEST_KEY,
      });

      await new Promise((resolve) => appRestarted.listen(resolve));
      const newPort = appRestarted.server.address().port;
      const newBaseUrl = `http://127.0.0.1:${newPort}`;

      const resStatus = await fetch(`${newBaseUrl}/api/status?key=${TEST_KEY}&provider=claude`);
      assert.equal(resStatus.status, 200);
      const snap = await resStatus.json();
      assert.ok(snap.total_accounts >= 4, "all accounts must persist after restart");

      const resSettings = await fetch(`${newBaseUrl}/api/settings?key=${TEST_KEY}`);
      assert.equal(resSettings.status, 200);
      const sett = await resSettings.json();
      assert.equal(sett.settings.machine_labels["mac-m3-alice"], "Alice-Laptop");
      assert.equal(sett.settings.account_labels["dev1-seat@example.com"], "Frontend Squad Lead Seat");
      assert.equal(sett.settings.providers.copilot.weight_7d, 0.5);

      await appRestarted.close();
    });
  } finally {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {}
  }
});
