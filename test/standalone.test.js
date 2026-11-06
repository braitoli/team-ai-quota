import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createServer } from "../src/standalone-server.js";

const TEST_SECRET = "test-secret-key-12345";

test("Standalone SQLite Server - Full Lifecycle & Persistence", async (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "quota-test-"));

  try {
    // 1. Initialize Server 1
    const app1 = createServer({
      port: 0,
      host: "127.0.0.1",
      dataDir: tempDir,
      secretKey: TEST_SECRET,
    });

    await new Promise((resolve) => app1.listen(resolve));
    const port1 = app1.server.address().port;
    const baseUrl1 = `http://127.0.0.1:${port1}`;

    await t.test("Health endpoints (/health and /api/health)", async () => {
      const res1 = await fetch(`${baseUrl1}/health`);
      assert.equal(res1.status, 200);
      const json1 = await res1.json();
      assert.equal(json1.status, "ok");
      assert.equal(json1.service, "team-ai-quota");

      const res2 = await fetch(`${baseUrl1}/api/health`);
      assert.equal(res2.status, 200);
      const json2 = await res2.json();
      assert.equal(json2.status, "ok");
    });

    await t.test("Authentication enforcement", async () => {
      const resStatus = await fetch(`${baseUrl1}/api/status`);
      assert.equal(resStatus.status, 401);

      const resUpdate = await fetch(`${baseUrl1}/api/update`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: "user@example.com" }),
      });
      assert.equal(resUpdate.status, 401);

      const resDash = await fetch(`${baseUrl1}/`);
      assert.equal(resDash.status, 200);
      const html = await resDash.text();
      assert.match(html, /Claude Quota/i);
      assert.match(html, /cqm_claude_quota_key/);
    });

    await t.test("POST /api/update with quota report", async () => {
      const report = {
        provider: "claude",
        email: "alice@example.com",
        used_percent: 64.5,
        resets_at: new Date(Date.now() + 2 * 3600 * 1000).toISOString(),
        machine_id: "mac-studio-01",
        machine_name: "Mac Studio M2",
        os: "darwin",
        client_version: "3.2.0",
      };

      const res = await fetch(`${baseUrl1}/api/update?key=${TEST_SECRET}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(report),
      });

      assert.equal(res.status, 200);
      const data = await res.json();
      assert.equal(data.success, true);
      assert.equal(data.version, 1);
      assert.equal(data.record.email, "alice@example.com");
      assert.equal(data.record.used_percent, 64.5);
    });

    await t.test("GET /api/status and /api/quota alias", async () => {
      const resStatus = await fetch(`${baseUrl1}/api/status?key=${TEST_SECRET}`);
      assert.equal(resStatus.status, 200);
      const etag = resStatus.headers.get("etag");
      assert.ok(etag, "ETag header must be present");
      const snapStatus = await resStatus.json();
      assert.equal(snapStatus.version, 1);
      assert.ok(snapStatus.accounts["0"], "Account key '0' should exist");
      assert.equal(snapStatus.accounts["0"].email, "alice@example.com");

      // Verify /api/quota alias returns exact same response
      const resQuota = await fetch(`${baseUrl1}/api/quota?key=${TEST_SECRET}`);
      assert.equal(resQuota.status, 200);
      const snapQuota = await resQuota.json();
      assert.equal(snapQuota.version, 1);
      assert.equal(snapQuota.accounts["0"].email, "alice@example.com");

      // Test 304 Not Modified with If-None-Match
      const resCached = await fetch(`${baseUrl1}/api/status?key=${TEST_SECRET}`, {
        headers: { "If-None-Match": etag },
      });
      assert.equal(resCached.status, 304);
    });

    await t.test("GET / dashboard rendering", async () => {
      const resDash = await fetch(`${baseUrl1}/?key=${TEST_SECRET}`);
      assert.equal(resDash.status, 200);
      const html = await resDash.text();
      assert.match(html, /alice@example\.com/);
      assert.match(html, /Claude Quota/);
    });

    await t.test("Multi-provider isolation (codex vs claude)", async () => {
      const codexReport = {
        provider: "codex",
        email: "bob@example.com",
        used_percent: 30,
        resets_at: new Date(Date.now() + 4 * 3600 * 1000).toISOString(),
        machine_id: "linux-box-01",
        os: "linux",
        client_version: "3.2.0",
      };

      const res = await fetch(`${baseUrl1}/api/update?key=${TEST_SECRET}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(codexReport),
      });
      assert.equal(res.status, 200);

      const resCodex = await fetch(`${baseUrl1}/api/status?key=${TEST_SECRET}&provider=codex`);
      assert.equal(resCodex.status, 200);
      const snapCodex = await resCodex.json();
      assert.equal(snapCodex.provider, "codex");
      assert.equal(snapCodex.accounts["0"].email, "bob@example.com");

      // Check SQLite files on disk
      const files = fs.readdirSync(tempDir);
      assert.ok(files.some((f) => f.startsWith("quota-team.sqlite")), "quota-team.sqlite must exist");
      assert.ok(files.some((f) => f.startsWith("quota-codex.sqlite")), "quota-codex.sqlite must exist");
    });

    // Close Server 1
    await app1.close();

    // 2. Restart Server 2 on the SAME data directory
    await t.test("Persistence across restart", async () => {
      const app2 = createServer({
        port: 0,
        host: "127.0.0.1",
        dataDir: tempDir,
        secretKey: TEST_SECRET,
      });

      await new Promise((resolve) => app2.listen(resolve));
      const port2 = app2.server.address().port;
      const baseUrl2 = `http://127.0.0.1:${port2}`;

      try {
        // Query claude status from Server 2
        const res1 = await fetch(`${baseUrl2}/api/status?key=${TEST_SECRET}`);
        assert.equal(res1.status, 200);
        const snap1 = await res1.json();
        assert.equal(snap1.version, 1);
        assert.equal(snap1.accounts["0"].email, "alice@example.com");
        assert.equal(snap1.accounts["0"].used_percent, 64.5);

        // Query codex status from Server 2
        const res2 = await fetch(`${baseUrl2}/api/status?key=${TEST_SECRET}&provider=codex`);
        assert.equal(res2.status, 200);
        const snap2 = await res2.json();
        assert.equal(snap2.accounts["0"].email, "bob@example.com");
      } finally {
        await app2.close();
      }
    });
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
