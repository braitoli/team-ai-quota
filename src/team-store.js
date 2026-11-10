/**
 * TeamStore: one SQLite-backed Durable Object per provider (claude: idFromName("team"), others: idFromName(provider)).
 * The provider is read from ctx.id.name; only the claude object imports legacy KV.
 * Holds per-account state, samples, closed windows, idle gaps and the
 * pre-computed team snapshot. All math lives in analytics.js; this class only
 * reads rows, calls the pure functions and writes the result atomically.
 */
import { DurableObject } from "cloudflare:workers";
import {
  processReport,
  expandReport,
  isProvider,
  DEFAULT_PROVIDER,
  rebuildSnapshot,
  importLegacyRecords,
  emptySnapshot,
  rankAccountsForRouting,
  SAMPLE_RETENTION_MS,
  WINDOW_RETENTION_MS,
  WEEK_RETENTION_MS,
  HEATMAP_SPAN_MS,
  DAY_MS,
} from "./analytics.js";
import {
  buildDefaultSettings,
  mergeSettings,
  parseLabelEnv,
  validateSettingsPatch,
} from "./config.js";

const KV_IMPORT_RETRY_MS = 6 * 3600 * 1000;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS accounts (email TEXT PRIMARY KEY, state_json TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS samples (email TEXT NOT NULL, ts INTEGER NOT NULL, used REAL NOT NULL, resets_at INTEGER);
CREATE INDEX IF NOT EXISTS idx_samples_ts ON samples(ts);
CREATE TABLE IF NOT EXISTS windows (
  email TEXT NOT NULL, start_ts INTEGER NOT NULL, end_ts INTEGER NOT NULL, final_used REAL NOT NULL,
  last_sample_ts INTEGER NOT NULL, waste REAL NOT NULL, uncertainty_min INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (email, start_ts)
);
CREATE INDEX IF NOT EXISTS idx_windows_end ON windows(end_ts);
CREATE TABLE IF NOT EXISTS week_windows (
  email TEXT NOT NULL, start_ts INTEGER NOT NULL, end_ts INTEGER NOT NULL, final_used REAL NOT NULL, waste REAL NOT NULL,
  PRIMARY KEY (email, start_ts)
);
CREATE INDEX IF NOT EXISTS idx_week_windows_end ON week_windows(end_ts);
CREATE TABLE IF NOT EXISTS gaps (email TEXT NOT NULL, start_ts INTEGER NOT NULL, end_ts INTEGER NOT NULL, PRIMARY KEY (email, start_ts));
CREATE INDEX IF NOT EXISTS idx_gaps_end ON gaps(end_ts);
CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS machines (
  email TEXT NOT NULL, machine_id TEXT NOT NULL, machine_name TEXT, os TEXT,
  first_seen_ts INTEGER NOT NULL, last_seen_ts INTEGER NOT NULL, last_valid_ts INTEGER,
  reports_ok INTEGER NOT NULL DEFAULT 0, reports_err INTEGER NOT NULL DEFAULT 0,
  last_error_kind TEXT, last_error_ts INTEGER, client_version TEXT, last_ip TEXT, country TEXT,
  last_used_percent REAL,
  PRIMARY KEY (email, machine_id)
);
`;

export class TeamStore extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    const name = ctx.id && ctx.id.name;
    // "team" (or an unnamed id, the pre-provider behaviour) is the claude object.
    this.provider = isProvider(name) ? name : DEFAULT_PROVIDER;
    ctx.blockConcurrencyWhile(async () => {
      this.sql.exec(SCHEMA);
      this.migrateColumns();
      if (this.provider === DEFAULT_PROVIDER) await this.importKvOnce(); // never throws
    });
  }

  getMeta(k) {
    const rows = this.sql.exec("SELECT v FROM meta WHERE k = ?", k).toArray();
    return rows.length ? rows[0].v : null;
  }

  setMeta(k, v) {
    this.sql.exec("INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v", k, String(v));
  }

  currentVersion() {
    return Number(this.getMeta("snapshot_version") || 0);
  }

  getSettings() {
    let text = null;
    try {
      const rows = this.sql.exec("SELECT v FROM kv WHERE k = 'settings'").toArray();
      if (rows.length) text = rows[0].v;
    } catch {}
    if (!text) {
      text = this.getMeta("settings");
    }
    if (text) {
      try {
        const stored = JSON.parse(text);
        // Deployment config (MACHINE_LABELS) is the base under labels already saved in Settings, so an
        // existing install picks up configured names without a manual migration; saved labels win.
        stored.machine_labels = { ...parseLabelEnv(this.env && this.env.MACHINE_LABELS), ...(stored.machine_labels || {}) };
        return stored;
      } catch {}
    }
    return buildDefaultSettings(this.env);
  }

  saveSettings(settings) {
    const text = JSON.stringify(settings);
    try {
      this.sql.exec("INSERT INTO kv (k, v) VALUES ('settings', ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v", text);
    } catch {}
    this.setMeta("settings", text);
  }

  updateSettings(patch) {
    const current = this.getSettings();
    const next = mergeSettings(current, patch);
    this.saveSettings(next);
    // Rebuild snapshot with updated settings
    const now = Date.now();
    const store = this.loadStore(now);
    const version = this.currentVersion() + 1;
    const res = rebuildSnapshot(store, now, "settings-update", version, this.provider, next);
    this.applyWrites(res.writes);
    this.saveSnapshot(res.snapshot);
    return next;
  }

  /**
   * One-time lazy import of legacy KV records (account:<email>). Never writes KV.
   * Never throws: a failure is recorded in meta `kv_import_failed_at` and retried at most once per 6 h,
   * so a broken import can neither reset the object nor turn every request into a 500.
   */
  async importKvOnce() {
    try {
      if (this.getMeta("imported_kv")) return;
      const now = Date.now();
      const failedAt = Number(this.getMeta("kv_import_failed_at") || 0);
      if (failedAt && now - failedAt < KV_IMPORT_RETRY_MS) return;
      const kv = this.env.CLAUDE_QUOTA_KV;
      if (!kv) {
        this.setMeta("imported_kv", "no-binding");
        return;
      }
      const records = [];
      let cursor;
      do {
        const page = await kv.list({ prefix: "account:", cursor });
        const got = await Promise.all(page.keys.map(async (k) => {
          try {
            const text = await kv.get(k.name);
            return text ? JSON.parse(text) : null;
          } catch {
            return null; // malformed record: skip it
          }
        }));
        records.push(...got.filter((r) => r && typeof r === "object"));
        cursor = page.list_complete ? undefined : page.cursor;
      } while (cursor);
      const imported = importLegacyRecords(records);
      this.ctx.storage.transactionSync(() => {
        this.writeAll(imported);
        if (Object.keys(imported.states).length > 0) {
          const store = this.loadStore(now);
          const version = this.currentVersion() + 1;
          const res = rebuildSnapshot(store, now, "kv-import", version);
          this.applyWrites(res.writes);
          this.saveSnapshot(res.snapshot);
        }
        this.setMeta("imported_kv", `${new Date(now).toISOString()} (${records.length} records)`);
      });
    } catch (err) {
      console.error("KV import failed, retry in >= 6h:", err && err.message);
      try {
        this.setMeta("kv_import_failed_at", Date.now());
      } catch {
        // storage itself failing: nothing more we can do here
      }
    }
  }

  writeAll(data) {
    for (const st of Object.values(data.states)) this.putState(st);
    this.applyWrites({ states: [], samples: data.samples, windows: data.windows, weeks: data.weeks, gaps: data.gaps, machines: data.machines });
  }

  putState(st) {
    this.sql.exec(
      "INSERT INTO accounts (email, state_json) VALUES (?, ?) ON CONFLICT(email) DO UPDATE SET state_json = excluded.state_json",
      st.email,
      JSON.stringify(st)
    );
  }

  applyWrites(w) {
    for (const st of w.states || []) this.putState(st);
    for (const p of w.samples || []) {
      this.sql.exec("INSERT INTO samples (email, ts, used, resets_at) VALUES (?, ?, ?, ?)", p.email, p.ts, p.used, p.resets_at);
    }
    for (const x of w.windows || []) {
      this.sql.exec(
        "INSERT OR REPLACE INTO windows (email, start_ts, end_ts, final_used, last_sample_ts, waste, uncertainty_min) VALUES (?, ?, ?, ?, ?, ?, ?)",
        x.email, x.start_ts, x.end_ts, x.final_used, x.last_sample_ts, x.waste, x.uncertainty_min || 0
      );
    }
    for (const x of w.weeks || []) {
      this.sql.exec(
        "INSERT OR REPLACE INTO week_windows (email, start_ts, end_ts, final_used, waste) VALUES (?, ?, ?, ?, ?)",
        x.email, x.start_ts, x.end_ts, x.final_used, x.waste
      );
    }
    for (const g of w.gaps || []) {
      this.sql.exec("INSERT OR IGNORE INTO gaps (email, start_ts, end_ts) VALUES (?, ?, ?)", g.email, g.start_ts, g.end_ts);
    }
    for (const m of w.machines || []) {
      this.sql.exec(
        `INSERT OR REPLACE INTO machines (email, machine_id, machine_name, os, first_seen_ts, last_seen_ts, last_valid_ts,
          reports_ok, reports_err, last_error_kind, last_error_ts, client_version, last_ip, country, last_used_percent,
          update_status, update_checked_ts, telemetry_json, acct_tokens_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        m.email, m.machine_id, m.machine_name ?? null, m.os ?? null, m.first_seen_ts, m.last_seen_ts, m.last_valid_ts ?? null,
        m.reports_ok, m.reports_err, m.last_error_kind ?? null, m.last_error_ts ?? null, m.client_version ?? null,
        m.last_ip ?? null, m.country ?? null, m.last_used_percent ?? null,
        m.update_status ?? null, m.update_checked_ts ?? null,
        m.telemetry ? JSON.stringify(m.telemetry) : null, m.acct_tokens ? JSON.stringify(m.acct_tokens) : null
      );
    }
  }

  /** Columns added after the first release: ALTER ... ADD COLUMN throws "duplicate column" when already present. */
  migrateColumns() {
    for (const stmt of [
      "ALTER TABLE machines ADD COLUMN update_status TEXT",
      "ALTER TABLE machines ADD COLUMN update_checked_ts INTEGER",
      "ALTER TABLE machines ADD COLUMN telemetry_json TEXT",
      "ALTER TABLE machines ADD COLUMN acct_tokens_json TEXT",
    ]) {
      try {
        this.sql.exec(stmt);
      } catch (e) {
        if (!/duplicate column/i.test(String(e && e.message))) throw e;
      }
    }
  }

  loadStore(now) {
    const states = {};
    for (const r of this.sql.exec("SELECT state_json FROM accounts").toArray()) {
      const st = JSON.parse(r.state_json);
      states[st.email] = st;
    }
    const samples = this.sql
      .exec("SELECT email, ts, used, resets_at FROM samples WHERE ts >= ?", now - DAY_MS)
      .toArray();
    const windows = this.sql
      .exec("SELECT email, start_ts, end_ts, final_used, last_sample_ts, waste, uncertainty_min FROM windows WHERE end_ts >= ?", now - HEATMAP_SPAN_MS)
      .toArray();
    const weeks = this.sql
      .exec("SELECT email, start_ts, end_ts, final_used, waste FROM week_windows WHERE end_ts >= ?", now - WEEK_RETENTION_MS)
      .toArray();
    const gaps = this.sql
      .exec("SELECT email, start_ts, end_ts FROM gaps WHERE end_ts >= ?", now - HEATMAP_SPAN_MS)
      .toArray();
    const machines = this.sql.exec("SELECT * FROM machines").toArray().map((r) => {
      const { telemetry_json, acct_tokens_json, ...m } = r;
      const parse = (j) => { try { return j ? JSON.parse(j) : null; } catch { return null; } };
      const telemetry = parse(telemetry_json);
      const acct = parse(acct_tokens_json);
      if (telemetry) m.telemetry = telemetry;
      if (acct) m.acct_tokens = acct;
      return m;
    });
    return { states, samples, windows, weeks, gaps, machines };
  }

  saveSnapshot(snapshot) {
    this.setMeta("snapshot", JSON.stringify(snapshot));
    this.setMeta("snapshot_version", snapshot.version);
    this.setMeta("rebuilt_vel7d_v1", "1");
  }

  prune(now) {
    this.sql.exec("DELETE FROM samples WHERE ts < ?", now - SAMPLE_RETENTION_MS);
    this.sql.exec("DELETE FROM windows WHERE end_ts < ?", now - WINDOW_RETENTION_MS);
    this.sql.exec("DELETE FROM gaps WHERE end_ts < ?", now - WINDOW_RETENTION_MS);
    this.sql.exec("DELETE FROM week_windows WHERE end_ts < ?", now - WEEK_RETENTION_MS);
  }

  /**
   * Apply one validated report; recompute and store the team snapshot atomically.
   * A pooled auth report without pool is applied to every pool (one version each, in one transaction).
   */
  async report(report) {
    const now = Date.now();
    return this.ctx.storage.transactionSync(() => {
      let version;
      let res;
      let sampleAdded = false;
      let applied;
      for (const one of expandReport({ ...report, provider: this.provider })) {
        const store = this.loadStore(now);
        version = this.currentVersion() + 1;
        const settings = this.getSettings();
        res = processReport(store, one, now, version, settings);
        this.applyWrites(res.writes);
        this.saveSnapshot(res.snapshot);
        sampleAdded = sampleAdded || res.writes.samples.length > 0;
        applied = one;
      }
      this.prune(now);
      const row = res.state.row;
      return {
        version,
        computed_at: res.snapshot.computed_at,
        sample_added: sampleAdded,
        record: {
          email: report.email,
          account_key: applied.account_key || applied.email,
          provider: this.provider,
          pool: applied.pool || null,
          state_code: row.state_code,
          used_percent: row.used_percent,
          resets_at: row.resets_at,
          auth_state: row.auth_state,
          updated_at: new Date(now).toISOString(),
        },
      };
    });
  }

  /** Returns { version, body } (body null when the caller's ETag version is current). */
  async getSnapshot(ifNoneMatchVersion) {
    if (!this.getMeta("rebuilt_vel7d_v1") && this.getMeta("snapshot")) {
      const now = Date.now();
      const store = this.loadStore(now);
      const settings = this.getSettings();
      const nextVer = this.currentVersion() + 1;
      const res = rebuildSnapshot(store, now, "vel7d-upgrade", nextVer, this.provider, settings);
      this.applyWrites(res.writes);
      this.saveSnapshot(res.snapshot);
    }
    const version = this.currentVersion();
    if (ifNoneMatchVersion !== null && ifNoneMatchVersion !== undefined && String(ifNoneMatchVersion) === String(version)) {
      return { version, body: null };
    }
    const settings = this.getSettings();
    let body = this.getMeta("snapshot");
    if (!body) {
      body = JSON.stringify(emptySnapshot(this.provider, settings));
    } else {
      try {
        const snap = JSON.parse(body);
        if (!snap.settings) {
          snap.settings = settings;
          body = JSON.stringify(snap);
        }
      } catch {}
    }
    return { version, body };
  }

  /**
   * HTTP interface for direct invocation of DO via worker fetch.
   */
  async fetch(request) {
    const url = new URL(request.url);
    const path = url.pathname;
    if (request.method === "GET" && (path === "/api/settings" || path === "/settings")) {
      const settings = this.getSettings();
      return new Response(JSON.stringify({ success: true, settings }), {
        status: 200,
        headers: { "Content-Type": "application/json; charset=utf-8" },
      });
    }
    if ((request.method === "POST" || request.method === "PUT") && (path === "/api/settings" || path === "/settings")) {
      let body;
      try {
        body = await request.json();
      } catch {
        return new Response(JSON.stringify({ error: "Invalid JSON body" }), {
          status: 400,
          headers: { "Content-Type": "application/json; charset=utf-8" },
        });
      }
      const v = validateSettingsPatch(body);
      if (!v.ok) {
        return new Response(JSON.stringify({ error: v.error }), {
          status: 400,
          headers: { "Content-Type": "application/json; charset=utf-8" },
        });
      }
      const settings = this.updateSettings(v.patch);
      return new Response(JSON.stringify({ success: true, settings }), {
        status: 200,
        headers: { "Content-Type": "application/json; charset=utf-8" },
      });
    }
    if (request.method === "POST" && (path === "/api/labels" || path === "/labels")) {
      let body;
      try {
        body = await request.json();
      } catch {
        return new Response(JSON.stringify({ error: "Invalid JSON body" }), {
          status: 400,
          headers: { "Content-Type": "application/json; charset=utf-8" },
        });
      }
      const v = validateSettingsPatch(body);
      if (!v.ok) {
        return new Response(JSON.stringify({ error: v.error }), {
          status: 400,
          headers: { "Content-Type": "application/json; charset=utf-8" },
        });
      }
      const patch = {};
      if (body.machine_labels) patch.machine_labels = body.machine_labels;
      if (body.account_labels) patch.account_labels = body.account_labels;
      const settings = this.updateSettings(patch);
      return new Response(JSON.stringify({ success: true, settings }), {
        status: 200,
        headers: { "Content-Type": "application/json; charset=utf-8" },
      });
    }
    if (request.method === "GET" && (path === "/api/route" || path === "/route" || path === "/api/best-account")) {
      const snap = await this.getSnapshot(null);
      const snapshot = typeof snap.body === "string" ? JSON.parse(snap.body) : snap.body;
      const res = rankAccountsForRouting(snapshot, { provider: this.provider, settings: this.getSettings() });
      return new Response(JSON.stringify(res), {
        status: 200,
        headers: { "Content-Type": "application/json; charset=utf-8" },
      });
    }
    return new Response(JSON.stringify({ error: "Not Found" }), {
      status: 404,
      headers: { "Content-Type": "application/json; charset=utf-8" },
    });
  }

  /**
   * LOCAL DEV ONLY (route gated by env.DEV_SEED === "1"): replace all data with a
   * pre-built fake store + snapshot (generated by test/tools/seed-fake.mjs).
   */
  async devReplace(data) {
    return this.ctx.storage.transactionSync(() => {
      this.sql.exec("DELETE FROM accounts; DELETE FROM samples; DELETE FROM windows; DELETE FROM week_windows; DELETE FROM gaps; DELETE FROM machines;");
      this.writeAll(data);
      const version = this.currentVersion() + 1;
      this.saveSnapshot({ ...data.snapshot, version });
      return { version };
    });
  }
}
