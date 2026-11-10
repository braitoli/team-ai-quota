/**
 * Pure analytics for the Claude quota "opportunity engine".
 * No I/O: every function receives plain data and an explicit `now` (epoch ms).
 *
 * Recompute policy: the snapshot is rebuilt only when a client POSTs a report.
 * - the reporting account's row is fully recomputed at `now`;
 * - other accounts keep the row computed at their own last report, except the
 *   deterministic hard transitions (window ended -> FRESH, staleness flag).
 */

export const WINDOW_H = 5;
export const HOUR_MS = 3600 * 1000;
export const MINUTE_MS = 60 * 1000;
export const DAY_MS = 24 * HOUR_MS;
export const WINDOW_MS = WINDOW_H * HOUR_MS;
export const SAME_WINDOW_TOLERANCE_MS = 10 * MINUTE_MS;
/**
 * Providers occasionally reset usage by hand (Anthropic: "reset 5-hour and weekly limits for everyone";
 * OpenAI Codex: free resets for paid plans and a purchasable instant reset). Used % then drops while the
 * window is still running. A drop this large cannot come from out-of-order reports (usage only grows inside
 * a window), so it is read as a provider reset, not as waste and not as a stale report.
 */
export const RESET_DROP_5H = 25;
export const RESET_DROP_WEEKLY = 15;
/** An early window end more than this before its scheduled reset is a provider reset, not a normal expiry. */
const EARLY_END_MS = 10 * MINUTE_MS;
export const STALE_MS = 75 * MINUTE_MS;
// Per-machine lateness: clients report every 15 min, old clients every ~30 min; a few minutes of grace on top.
export const LATE_LATEST_MS = 20 * MINUTE_MS;
export const LATE_OLD_MS = 40 * MINUTE_MS;
export const RECENT_SPAN_MS = 90 * MINUTE_MS;
export const RECENT_MIN_SPAN_MS = 15 * MINUTE_MS;
export const DEDUPE_MS = 10 * MINUTE_MS;
const RATE_BUCKET_MS = 5 * MINUTE_MS;
const FETCH_PAST_MS = 15 * MINUTE_MS;
const FETCH_FUTURE_MS = 2 * MINUTE_MS;
const WARNING_TTL_MS = 24 * 60 * MINUTE_MS;
export const FRESH_TAIL_MS = 30 * MINUTE_MS;
export const SAMPLE_RETENTION_MS = 14 * DAY_MS;
export const WINDOW_RETENTION_MS = 30 * DAY_MS;
export const HEATMAP_SPAN_MS = 14 * DAY_MS;
/** Closed weekly quota periods are kept this long (history of the weekly quota). */
export const WEEK_RETENTION_MS = 35 * DAY_MS;
export const HISTORY_SPAN_MS = DAY_MS;
export const TIMELINE_SPAN_MS = 12 * HOUR_MS;
export const MAX_LIMITS = 12;
export const GMT7_OFFSET_MS = 7 * HOUR_MS;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
import { DEFAULT_MACHINE_LABELS, buildDefaultSettings, resolveMachineLabel, resolveAccountLabel } from "./config.js";
import { renderKey } from "./i18n.js";

const TOKEN_STATES = new Set(["ok", "expired_idle", "auth_required"]);

/**
 * Providers: each has its own Durable Object and snapshot. A provider with pools keeps one row per
 * (email, pool); pools never substitute for each other. Internally the `email` field of states, samples,
 * windows, gaps and machines holds the row's account_key (= email for claude, `email#pool` for pooled providers).
 */
export const DEFAULT_PROVIDER = "claude";
export const PROVIDERS = {
  claude: { label: "Claude", pools: [] },
  agy: { label: "Agy", pools: [{ id: "gemini", label: "Gemini (Flash/Pro)" }, { id: "claude", label: "Claude & GPT-OSS" }] },
  codex: { label: "Codex", pools: [] },
  gemini: { label: "Gemini", pools: [] },
  copilot: { label: "Copilot", pools: [], has_monthly: true },
  cursor: { label: "Cursor", pools: [], has_monthly: true },
};

export function isProvider(p) {
  return typeof p === "string" && Object.prototype.hasOwnProperty.call(PROVIDERS, p);
}

export function accountKey(email, pool) {
  return pool ? `${email}#${pool}` : email;
}

/** Internal row identity: account_key when present, else the (claude) email. */
const keyOf = (x) => x.account_key || x.email;

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

export function r1(x) {
  return Math.round(x * 10) / 10;
}

function clamp(x, lo, hi) {
  return Math.min(hi, Math.max(lo, x));
}

export function parseTs(value) {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value !== "string") return undefined;
  const t = Date.parse(value);
  return Number.isFinite(t) ? t : undefined;
}

export function sameWindow(a, b) {
  if (a === null || a === undefined || b === null || b === undefined) return false;
  return Math.abs(a - b) <= SAME_WINDOW_TOLERANCE_MS;
}

function sameWindowNullable(a, b) {
  if ((a === null || a === undefined) && (b === null || b === undefined)) return true;
  return sameWindow(a, b);
}

function toIso(ts) {
  return ts === null || ts === undefined ? null : new Date(ts).toISOString();
}

function gmt7Parts(ts) {
  const d = new Date(ts + GMT7_OFFSET_MS);
  return {
    YYYY: d.getUTCFullYear(),
    MM: String(d.getUTCMonth() + 1).padStart(2, "0"),
    DD: String(d.getUTCDate()).padStart(2, "0"),
    HH: String(d.getUTCHours()).padStart(2, "0"),
    mm: String(d.getUTCMinutes()).padStart(2, "0"),
    ss: String(d.getUTCSeconds()).padStart(2, "0"),
    hour: d.getUTCHours(),
  };
}

/** "YYYY-MM-DD HH:mm:ss GMT+7" */
export function formatGmt7(ts) {
  if (ts === null || ts === undefined || !Number.isFinite(ts)) return "N/A";
  const p = gmt7Parts(ts);
  return `${p.YYYY}-${p.MM}-${p.DD} ${p.HH}:${p.mm}:${p.ss} GMT+7`;
}

/** "HH:mm" GMT+7 */
export function formatHM(ts) {
  if (ts === null || ts === undefined || !Number.isFinite(ts)) return "--:--";
  const p = gmt7Parts(ts);
  return `${p.HH}:${p.mm}`;
}

/** "HH:mm DD/MM" GMT+7 */
export function formatHMDM(ts) {
  if (ts === null || ts === undefined || !Number.isFinite(ts)) return "N/A";
  const p = gmt7Parts(ts);
  return `${p.HH}:${p.mm} ${p.DD}/${p.MM}`;
}

/** Duration "1h 10m" / "45m" (rounded down to the minute). */
export function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return "0m";
  const totalMins = Math.floor(ms / MINUTE_MS);
  const h = Math.floor(totalMins / 60);
  const m = totalMins % 60;
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

const SRV_FMT = { time: formatHM, datetime: formatHMDM, dur: formatDuration };

/**
 * A user-facing text of the snapshot: `field` holds the English default and the client re-renders it in its
 * language from `field_key` + `field_params` (raw values: numbers, epoch ms, durations in ms; see docs/api.md).
 * The templates live in i18n.js (srv_* keys); spread the result into the object that owns the field.
 */
function txt(field, key, params = {}) {
  return { [field]: renderKey(key, params, "en", SRV_FMT), [`${field}_key`]: key, [`${field}_params`]: params };
}

/** Clears the `field_key`/`field_params` pair when a plain value replaces a keyed text (e.g. in an overlay). */
const noKey = (field) => ({ [`${field}_key`]: undefined, [`${field}_params`]: undefined });

export function gmt7Hour(ts) {
  return gmt7Parts(ts).hour;
}

// ---------------------------------------------------------------------------
// Validation of POST /update payloads (old and new clients)
// ---------------------------------------------------------------------------

function optString(value, max, field) {
  if (value === undefined || value === null) return { ok: true, value: null };
  if (typeof value !== "string") return { ok: false, error: `${field} must be a string` };
  return { ok: true, value: value.trim().slice(0, max) || null };
}

function validateLimits(raw) {
  if (raw === undefined || raw === null) return { ok: true, value: null };
  if (!Array.isArray(raw)) return { ok: false, error: "limits must be an array" };
  if (raw.length > MAX_LIMITS) return { ok: false, error: `limits must have at most ${MAX_LIMITS} items` };
  const out = [];
  for (const item of raw) {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      return { ok: false, error: "limits items must be objects" };
    }
    const kind = optString(item.kind, 40, "limits.kind");
    const group = optString(item.group, 40, "limits.group");
    const scope = optString(item.scope_name, 60, "limits.scope_name");
    for (const r of [kind, group, scope]) if (!r.ok) return r;
    let percent = null;
    if (item.percent !== undefined && item.percent !== null) {
      if (typeof item.percent !== "number" || !Number.isFinite(item.percent)) {
        return { ok: false, error: "limits.percent must be a finite number or null" };
      }
      percent = r1(clamp(item.percent, 0, 100));
    }
    const resets = parseTs(item.resets_at);
    if (resets === undefined) return { ok: false, error: "limits.resets_at must be an ISO date or null" };
    if (item.is_active !== undefined && item.is_active !== null && typeof item.is_active !== "boolean") {
      return { ok: false, error: "limits.is_active must be a boolean or null" };
    }
    out.push({
      kind: kind.value,
      group: group.value,
      percent,
      resets_at: resets,
      is_active: item.is_active === true,
      scope_name: scope.value,
    });
  }
  return { ok: true, value: out };
}

/**
 * Validate a POST body. Returns { ok: true, report } or { ok: false, error }.
 * report.kind is "quota" (valid quota numbers) or "auth" (auth/error report).
 */
/** update_checked_at: epoch ms (number) or null; anything else is ignored. */
function parseUpdateChecked(v) {
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.round(v) : null;
}

export function validateReport(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, error: "Body must be a JSON object" };
  }
  const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
  if (!email || email === "unknown@user" || email.length > 254 || !EMAIL_RE.test(email)) {
    return { ok: false, error: "Invalid or missing email" };
  }

  if (body.token_state !== undefined && body.token_state !== null && !TOKEN_STATES.has(body.token_state)) {
    return { ok: false, error: "token_state must be one of ok, expired_idle, auth_required" };
  }
  const clientVersion = optString(body.client_version, 40, "client_version");
  if (!clientVersion.ok) return clientVersion;
  const errorKind = optString(body.error_kind, 40, "error_kind");
  if (!errorKind.ok) return errorKind;
  const machineId = optString(body.machine_id, 64, "machine_id");
  if (!machineId.ok) return machineId;
  const machineName = optString(body.machine_name, 64, "machine_name");
  if (!machineName.ok) return machineName;
  const osName = optString(body.os, 32, "os");
  if (!osName.ok) return osName;
  const updateStatus = optString(body.update_status, 80, "update_status");
  if (!updateStatus.ok) return updateStatus;
  const updateCheckedAt = parseUpdateChecked(body.update_checked_at);
  const machineLabelRaw = body.machine_label !== undefined ? body.machine_label : body.friendly_label;
  const machineLabel = optString(machineLabelRaw, 64, "machine_label");
  if (!machineLabel.ok) return machineLabel;
  const accountLabel = optString(body.account_label, 64, "account_label");
  if (!accountLabel.ok) return accountLabel;

  let monthlyUsedPercent = null;
  if (body.monthly_used_percent !== undefined && body.monthly_used_percent !== null) {
    if (typeof body.monthly_used_percent !== "number" || !Number.isFinite(body.monthly_used_percent)) {
      return { ok: false, error: "monthly_used_percent must be a number" };
    }
    monthlyUsedPercent = r1(clamp(body.monthly_used_percent, 0, 100));
  }

  let monthlyResetsAt = null;
  if (body.monthly_resets_at !== undefined && body.monthly_resets_at !== null) {
    monthlyResetsAt = parseTs(body.monthly_resets_at);
    if (monthlyResetsAt === undefined) {
      return { ok: false, error: "monthly_resets_at must be an ISO date string or null" };
    }
  }

  let monthlyQuotaLimit = null;
  if (body.monthly_quota_limit !== undefined && body.monthly_quota_limit !== null) {
    if (typeof body.monthly_quota_limit !== "number" || !Number.isFinite(body.monthly_quota_limit) || body.monthly_quota_limit < 0) {
      return { ok: false, error: "monthly_quota_limit must be a non-negative number" };
    }
    monthlyQuotaLimit = body.monthly_quota_limit;
  }

  let monthlyQuotaUsed = null;
  if (body.monthly_quota_used !== undefined && body.monthly_quota_used !== null) {
    if (typeof body.monthly_quota_used !== "number" || !Number.isFinite(body.monthly_quota_used) || body.monthly_quota_used < 0) {
      return { ok: false, error: "monthly_quota_used must be a non-negative number" };
    }
    monthlyQuotaUsed = body.monthly_quota_used;
  }

  const limits = validateLimits(body.limits);
  if (!limits.ok) return limits;
  const provider = body.provider === undefined || body.provider === null ? DEFAULT_PROVIDER : body.provider;
  if (!isProvider(provider)) return { ok: false, error: `provider must be one of ${Object.keys(PROVIDERS).join(", ")}` };
  const pools = PROVIDERS[provider].pools;
  const pool = body.pool === undefined || body.pool === null ? null : body.pool;
  if (pool !== null && !pools.some((p) => p.id === pool)) {
    return { ok: false, error: pools.length ? `pool must be one of ${pools.map((p) => p.id).join(", ")}` : `provider ${provider} has no pools` };
  }
  if (body.five_hour_disabled !== undefined && body.five_hour_disabled !== null && typeof body.five_hour_disabled !== "boolean") {
    return { ok: false, error: "five_hour_disabled must be a boolean" };
  }
  const fiveHourDisabled = body.five_hour_disabled === true;
  let telemetry = null;
  if (body.telemetry && typeof body.telemetry === "object" && !Array.isArray(body.telemetry)) {
    telemetry = {};
    for (const [k, v] of Object.entries(body.telemetry)) {
      if (typeof v === "number" && Number.isFinite(v)) telemetry[k] = v;
      else if (typeof v === "string" && v.length <= 100) telemetry[k] = v;
    }
    if (Object.keys(telemetry).length === 0) telemetry = null;
  }
  // Tokens this machine used since its previous report, attributed by the client to the account it held.
  let tokDelta = null;
  const td = body.token_delta;
  if (td && typeof td === "object" && !Array.isArray(td)) {
    const n = (v) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.round(v) : null);
    const d = { since: n(td.since), until: n(td.until), input: n(td.input), output: n(td.output), msgs: n(td.msgs) };
    if (Object.values(d).every((v) => v !== null) && d.until >= d.since) tokDelta = d;
  }
  // Identity fields shared by quota and auth reports. A pooled auth report without pool is fanned out
  // to every pool of the account by expandReport().
  const ident = { provider, pool, account_key: pool !== null || pools.length === 0 ? accountKey(email, pool) : null };
  let fetchedAt = null;
  if (body.fetched_at !== undefined && body.fetched_at !== null) {
    fetchedAt = typeof body.fetched_at === "number" && Number.isFinite(body.fetched_at)
      ? body.fetched_at
      : parseTs(body.fetched_at);
    if (typeof fetchedAt !== "number" || !Number.isFinite(fetchedAt)) {
      return { ok: false, error: "fetched_at must be an ISO date string or epoch milliseconds" };
    }
  }

  const tokenState = body.token_state || null;
  const isAuth = body.status === "auth_required"
    || body.auth_error === true
    || (tokenState !== null && tokenState !== "ok")
    || errorKind.value !== null;

  if (isAuth) {
    let authState = "error";
    if (tokenState && tokenState !== "ok") authState = tokenState;
    else if (body.status === "auth_required" || body.auth_error === true) authState = "auth_required";
    const err = typeof body.error === "string" ? body.error.slice(0, 300) : null;
    return {
      ok: true,
      report: {
        kind: "auth",
        email,
        ...ident,
        auth_state: authState,
        error_kind: errorKind.value,
        error: err,
        machine_id: machineId.value,
        machine_name: machineName.value,
        os: osName.value,
        client_version: clientVersion.value,
        update_status: updateStatus.value,
        update_checked_at: updateCheckedAt,
        telemetry,
        token_delta: tokDelta,
        monthly_used_percent: monthlyUsedPercent,
        monthly_resets_at: monthlyResetsAt,
        monthly_quota_limit: monthlyQuotaLimit,
        monthly_quota_used: monthlyQuotaUsed,
        machine_label: machineLabel.value,
        account_label: accountLabel.value,
      },
    };
  }

  if (pools.length > 0 && pool === null) {
    return { ok: false, error: `pool is required for provider ${provider}` };
  }
  // 5h bucket disabled (weekly cap hit): used_percent / resets_at of the report are ignored.
  const usedRaw = fiveHourDisabled ? 100 : body.used_percent !== undefined ? body.used_percent : body.utilization;
  if (typeof usedRaw !== "number" || !Number.isFinite(usedRaw)) {
    return { ok: false, error: "used_percent must be a finite number" };
  }
  const resetsAt = fiveHourDisabled ? null : parseTs(body.resets_at);
  if (resetsAt === undefined) {
    return { ok: false, error: "resets_at must be an ISO date string or null" };
  }
  if (resetsAt !== null && resetsAt > (fetchedAt ?? Date.now()) + 24 * HOUR_MS) {
    return { ok: false, error: "resets_at cannot be more than 24 hours in the future" };
  }
  return {
    ok: true,
    report: {
      kind: "quota",
      email,
      ...ident,
      ...(fiveHourDisabled ? { five_hour_disabled: true } : {}),
      used: r1(clamp(usedRaw, 0, 100)),
      resets_at: resetsAt,
      limits: limits.value,
      fetched_at: fetchedAt,
      machine_id: machineId.value,
      machine_name: machineName.value,
      os: osName.value,
      client_version: clientVersion.value,
      update_status: updateStatus.value,
      update_checked_at: updateCheckedAt,
      telemetry,
      token_delta: tokDelta,
      monthly_used_percent: monthlyUsedPercent,
      monthly_resets_at: monthlyResetsAt,
      monthly_quota_limit: monthlyQuotaLimit,
      monthly_quota_used: monthlyQuotaUsed,
      machine_label: machineLabel.value,
      account_label: accountLabel.value,
    },
  };
}

/**
 * One validated report -> the reports to apply. Only a pooled-provider auth/error report without a pool
 * (the token is per account, not per pool) expands into one report per pool; everything else is unchanged.
 */
export function expandReport(report) {
  if (report.account_key || !report.provider || !isProvider(report.provider)) return [report];
  return PROVIDERS[report.provider].pools.map((p) => ({ ...report, pool: p.id, account_key: accountKey(report.email, p.id) }));
}

// ---------------------------------------------------------------------------
// Per-account state machine
// ---------------------------------------------------------------------------

export function newState(email, now) {
  return {
    email,
    first_seen: now,
    used: null,
    resets_at: null,
    win: null,
    last_closed_end: null,
    idle_from: null,
    last_report_at: null,
    last_valid_at: null,
    last_sample: null,
    auth_state: null,
    auth_at: null,
    auth_error: null,
    error_kind: null,
    auth_warning: null,
    auth_warnings: {},
    limits: null,
    limits_at: null,
    client_version: null,
    row: null,
    reset_5h_ts: null,
    reset_weekly_ts: null,
    week: null,
  };
}

function cloneState(s) {
  return JSON.parse(JSON.stringify(s));
}

/** Close the open window of `s` (mutates s), pushing a window row to out.windows. */
function closeWindow(s, out, endTs) {
  const w = s.win;
  const end = endTs !== undefined ? endTs : w.resets_at;
  const finalUsed = w.last_used;
  const lastTs = Math.min(w.last_sample_ts, end);
  out.windows.push({
    email: s.email,
    start_ts: w.resets_at - WINDOW_MS,
    end_ts: end,
    final_used: finalUsed,
    last_sample_ts: lastTs,
    waste: r1(Math.max(0, 100 - finalUsed)),
    uncertainty_min: Math.round(Math.max(0, end - lastTs) / MINUTE_MS),
  });
  s.last_closed_end = w.resets_at;
  s.idle_from = end;
  s.win = null;
}

/** Close the tracked weekly period of `s` (mutates s), pushing a week row to out.weeks. */
function closeWeek(s, out) {
  const w = s.week;
  out.weeks.push({
    email: s.email,
    start_ts: w.resets_at - WEEK_MS,
    end_ts: w.resets_at,
    final_used: w.last_used,
    waste: r1(Math.max(0, 100 - w.last_used)),
  });
  s.week = null;
}

/**
 * Track the weekly quota period (what a week ended with). A period interrupted by a provider reset, or whose
 * reset time moved before it ended, is dropped: its unused part was refunded, not wasted.
 */
function trackWeek(s, out, report, now, justReset) {
  if (s.week && now >= s.week.resets_at) closeWeek(s, out);
  const wk = computeWeekly(report.limits, now);
  if (wk.weekly_used == null || wk.weekly_resets_at == null) return;
  if (s.week && (justReset || !sameWindow(s.week.resets_at, wk.weekly_resets_at))) s.week = null;
  if (!s.week) s.week = { resets_at: wk.weekly_resets_at, last_used: wk.weekly_used };
  else s.week.last_used = Math.max(s.week.last_used, wk.weekly_used);
}

function closeGapAt(s, out, startOfNext) {
  if (s.idle_from !== null && s.idle_from !== undefined) {
    if (startOfNext > s.idle_from) {
      out.gaps.push({ email: s.email, start_ts: s.idle_from, end_ts: startOfNext });
    }
    s.idle_from = null;
  }
}

function latestWarning(warnings) {
  let best = null;
  for (const w of Object.values(warnings || {})) {
    if (!best || w.at > best.at) best = w;
  }
  return best;
}

function pruneWarnings(warnings, now) {
  const out = {};
  for (const [k, w] of Object.entries(warnings || {})) {
    if (now - w.at <= WARNING_TTL_MS) out[k] = w;
  }
  return out;
}

/** Client fetch time bounded to [now - 15 min, now + 2 min] so a skewed clock cannot order reports. */
function measuredAtOf(report, now) {
  if (typeof report.fetched_at !== "number") return now;
  return clamp(report.fetched_at, now - FETCH_PAST_MS, now + FETCH_FUTURE_MS);
}

/** A valid quota report clears auth state and this machine's warning, and records limits (mutates s). */
function markValid(s, report, now) {
  s.auth_state = null;
  s.auth_at = null;
  s.auth_error = null;
  s.error_kind = null;
  const warnings = pruneWarnings(s.auth_warnings, now);
  delete warnings[report.machine_id || "_"];
  s.auth_warnings = warnings;
  s.auth_warning = latestWarning(warnings);
  s.last_valid_at = now;
  s.last_valid_machine = report.machine_id || null;
  if (Array.isArray(report.limits)) {
    const prevWk = computeWeekly(s.limits, s.limits_at ?? now);
    const curWk = computeWeekly(report.limits, now);
    const isDowngrade = prevWk.weekly_used != null && curWk.weekly_used != null &&
      curWk.weekly_used < prevWk.weekly_used && s.reset_weekly_ts !== now;
    if (!isDowngrade) {
      s.limits = report.limits;
      s.limits_at = now;
    }
  }
}

/**
 * Apply one validated report to an account state.
 * Returns { state, sample (or null), windows: [], gaps: [] }.
 */
export function ingestReport(prevState, report, now, recentSamples = []) {
  const s = prevState ? cloneState(prevState) : newState(keyOf(report), now);
  const out = { windows: [], gaps: [], weeks: [] };
  if (s.last_closed_end !== null && s.last_closed_end > now + 6 * HOUR_MS) {
    s.last_closed_end = null;
  }
  if (s.win && s.win.resets_at > now + 6 * HOUR_MS) {
    s.win = null;
  }
  if (s.resets_at !== null && s.resets_at > now + 6 * HOUR_MS) {
    s.resets_at = null;
  }
  if (report.pool) {
    s.account_email = report.email;
    s.pool = report.pool;
  }
  s.last_report_at = now;
  if (report.client_version) s.client_version = report.client_version;
  if (report.monthly_used_percent !== null && report.monthly_used_percent !== undefined) {
    s.monthly_used_percent = report.monthly_used_percent;
  }
  if (report.monthly_resets_at !== undefined) {
    s.monthly_resets_at = report.monthly_resets_at;
  }
  if (report.monthly_quota_limit !== null && report.monthly_quota_limit !== undefined) {
    s.monthly_quota_limit = report.monthly_quota_limit;
  }
  if (report.monthly_quota_used !== null && report.monthly_quota_used !== undefined) {
    s.monthly_quota_used = report.monthly_quota_used;
  }
  if (report.account_label) {
    s.account_label = report.account_label;
  }
  if (report.machine_label) {
    s.machine_label = report.machine_label;
  }

  if (report.kind === "auth") {
    // Never touch used/resets and never add a sample: the quota is unknown.
    // Several machines can share one account: an idle machine with an expired token must not flip an
    // account that another machine reported validly within STALE_MS. Record a warning instead.
    const recentValid = s.last_valid_at !== null && s.last_valid_at !== undefined && now - s.last_valid_at <= STALE_MS;
    // Warnings are tracked per machine so two machines cannot make the warning flap; auth reports never
    // count as measurements.
    if (recentValid && !s.auth_state) {
      const warnings = pruneWarnings(s.auth_warnings, now);
      warnings[report.machine_id || "_"] = {
        state: report.auth_state,
        at: now,
        error: report.error || null,
        error_kind: report.error_kind || null,
        machine_id: report.machine_id || null,
      };
      s.auth_warnings = warnings;
      s.auth_warning = latestWarning(warnings);
      return { state: s, sample: null, ...out };
    }
    s.auth_warnings = {};
    s.auth_warning = null;
    s.auth_state = report.auth_state;
    s.auth_at = now;
    s.auth_error = report.error || null;
    s.error_kind = report.error_kind || null;
    return { state: s, sample: null, ...out };
  }

  const U = report.used;
  const R = report.resets_at;

  // Provider reset of the weekly quota: weekly used drops while the old week is still running.
  // Remember when, so the weekly pace is measured from the reset and not from the old week start.
  {
    const prevWk = computeWeekly(s.limits, s.limits_at ?? now);
    const curWk = computeWeekly(report.limits, now);
    if (prevWk.weekly_used != null && curWk.weekly_used != null && prevWk.weekly_resets_at != null &&
        prevWk.weekly_resets_at > now + EARLY_END_MS && prevWk.weekly_used - curWk.weekly_used >= RESET_DROP_WEEKLY) {
      s.reset_weekly_ts = now;
    }
  }
  trackWeek(s, out, report, now, s.reset_weekly_ts === now);
  // Provider reset of the 5h quota inside the same window: used falls by a lot while the window runs.
  // Its unused part was refunded, not wasted: drop the window row and keep tracking from the new level.
  if (s.win && R !== null && sameWindow(s.win.resets_at, R) && s.win.last_used - U >= RESET_DROP_5H && now < s.win.resets_at - EARLY_END_MS) {
    closeWindow(s, out, now);
    out.windows.pop();
    s.idle_from = null;
    s.reset_5h_ts = now;
  }

  // Several machines can report one account, so reports may arrive out of order. Order by window first
  // (canonical resets_at), then by non-decreasing used inside a window; client clocks only break the
  // "no active window" tie. A report that fails these checks is history only: it changes no state.
  const ref = s.win ? s.win.resets_at : s.last_closed_end;
  const hasValidLimits = Array.isArray(report.limits) && report.limits.length > 0;
  if (R !== null && ref !== null && ref !== undefined && R < ref && !sameWindow(R, ref)) {
    if (hasValidLimits) markValid(s, report, now);
    return { state: s, sample: null, ...out };
  }
  if (s.win && R !== null && sameWindow(s.win.resets_at, R) && U < s.win.last_used) {
    if (hasValidLimits) markValid(s, report, now);
    return { state: s, sample: null, ...out };
  }
  if (s.win && R === null && measuredAtOf(report, now) <= s.win.last_sample_ts) {
    if (hasValidLimits) markValid(s, report, now);
    return { state: s, sample: null, ...out };
  }

  if (report.five_hour_disabled) {
    // Weekly cap hit, the 5h limit does not apply: no 5h window, no sample, and the capped time is not
    // idle 5h capacity (an open idle stretch is closed, capped like the open FRESH tail).
    if (s.win) closeWindow(s, out, Math.min(s.win.resets_at, now));
    const cap = s.last_valid_at ? Math.min(now, s.last_valid_at + FRESH_TAIL_MS) : now;
    closeGapAt(s, out, cap);
    s.used = 100;
    s.resets_at = null;
    s.five_hour_disabled = true;
    // Until the weekly reset; a report without a weekly limit keeps a previous future reset (else unknown).
    const weeklyReset = computeWeekly(report.limits, now).weekly_resets_at;
    s.disabled_until = weeklyReset ?? (s.disabled_until > now ? s.disabled_until : null);
    markValid(s, report, now);
    return { state: s, sample: null, ...out };
  }
  if (s.five_hour_disabled) {
    s.five_hour_disabled = false;
    s.disabled_until = null;
  }

  // 1. Close the tracked window when it is over or a different window shows up.
  if (s.win) {
    if (now >= s.win.resets_at) {
      closeWindow(s, out);
    } else if (R !== null && !sameWindow(s.win.resets_at, R)) {
      // A different window while the old one still had time left: the provider reset the quota early.
      const earlyEnd = now < s.win.resets_at - EARLY_END_MS;
      closeWindow(s, out, Math.min(s.win.resets_at, now));
      if (earlyEnd) {
        out.windows.pop();
        s.reset_5h_ts = now;
      }
    } else if (R === null) {
      // The API says no active window although we tracked one: it ended early.
      closeWindow(s, out, now);
    }
  }

  // A window we closed EARLY (API briefly said "no window") that is reported active again is reopened.
  // A window closed because its reset passed is never reopened (resets_at jitter at the boundary).
  const reopen = R !== null && R > now && sameWindow(R, s.last_closed_end) && s.last_closed_end > now;
  const activeReported = R !== null && R > now && (!sameWindow(R, s.last_closed_end) || reopen);
  let effUsed = U;
  let sampleResets = null;
  if (activeReported) {
    if (!s.win && reopen) {
      s.win = { resets_at: s.last_closed_end, last_used: U, last_sample_ts: now };
      s.idle_from = null; // the "idle" since the early close was not real
    } else if (!s.win) {
      closeGapAt(s, out, R - WINDOW_MS);
      s.win = { resets_at: R, last_used: U, last_sample_ts: now };
    } else {
      s.win.last_used = U;
      s.win.last_sample_ts = now;
    }
    s.used = U;
    s.resets_at = s.win.resets_at; // canonical (first-seen) value, jitter ignored
    sampleResets = s.win.resets_at;
  } else if (R !== null) {
    // Window already over at report time (or jitter of the one we just closed).
    effUsed = 0;
    s.used = U;
    // keep a past timestamp so the row is FRESH even when R jitters just past `now`
    s.resets_at = sameWindow(R, s.last_closed_end) ? Math.min(s.last_closed_end, now) : R;
    if (!sameWindow(R, s.last_closed_end)) {
      // A window we never tracked: its utilization reported after the fact is final.
      closeGapAt(s, out, R - WINDOW_MS);
      s.win = { resets_at: R, last_used: U, last_sample_ts: R };
      closeWindow(s, out, R);
    }
  } else {
    effUsed = 0;
    s.used = U;
    s.resets_at = null;
    if (s.idle_from === null && !s.win) s.idle_from = now;
  }

  markValid(s, report, now);

  // Dedupe: several machines on the same account report the same numbers. Compare against every recent
  // sample (resets_at with the usual jitter tolerance), not only the last one.
  const last = s.last_sample;
  let sample = null;
  const isDup = (last ? recentSamples.concat([last]) : recentSamples).some((p) =>
    sameWindowNullable(p.resets_at, sampleResets) && p.used === effUsed && Math.abs(now - p.ts) < DEDUPE_MS);
  if (!isDup) {
    sample = { email: s.email, ts: now, used: effUsed, resets_at: sampleResets };
    s.last_sample = { ts: now, used: effUsed, resets_at: sampleResets };
  }
  return { state: s, sample, ...out };
}

/**
 * Deterministic transitions applied to a non-reporting account at `now`.
 * Never re-extrapolates projections. Returns { state, windows, changed }.
 */
export function applyHardTransitions(prevState, now) {
  const s = cloneState(prevState);
  const out = { windows: [], gaps: [], weeks: [] };
  let changed = false;
  if (s.last_closed_end !== null && s.last_closed_end > now + 6 * HOUR_MS) {
    s.last_closed_end = null;
    changed = true;
  }
  if (s.win && s.win.resets_at > now + 6 * HOUR_MS) {
    s.win = null;
    changed = true;
  }
  if (s.resets_at !== null && s.resets_at > now + 6 * HOUR_MS) {
    s.resets_at = null;
    changed = true;
  }
  if (s.win && now >= s.win.resets_at) {
    closeWindow(s, out);
    changed = true;
  }
  if (s.week && now >= s.week.resets_at) {
    closeWeek(s, out);
    changed = true;
  }
  if (s.five_hour_disabled && typeof s.disabled_until === "number" && now >= s.disabled_until) {
    // Weekly reset passed: the 5h limit applies again -> FRESH.
    s.five_hour_disabled = false;
    s.disabled_until = null;
    changed = true;
  }

  const prevRow = s.row;
  const weeklyResetTs = prevRow && prevRow.weekly_resets_at ? tsOf(prevRow.weekly_resets_at) : null;
  const fiveHourResetTs = (s.win && s.win.resets_at) || (prevRow && prevRow.resets_at ? tsOf(prevRow.resets_at) : null);

  // Weekly reset passed: clear weekly_capped & five_hour_disabled, transition to FRESH
  if (weeklyResetTs !== null && now >= weeklyResetTs) {
    if (s.five_hour_disabled) {
      s.five_hour_disabled = false;
      s.disabled_until = null;
    }
    if (prevRow && (prevRow.weekly_capped || prevRow.weekly_used !== null || prevRow.state_code === "COOLDOWN")) {
      changed = true;
    }
  }

  // 5h cooldown window passed: transition to FRESH
  if (prevRow && prevRow.state_code === "COOLDOWN" && fiveHourResetTs !== null && now >= fiveHourResetTs) {
    changed = true;
  }

  if (changed || !prevRow) {
    // Window over -> FRESH (or AUTH stays AUTH). No projection involved.
    s.row = computeRow(s, [], now);
  } else {
    const row = { ...prevRow };
    const stale = isStale(s, now);
    if (stale !== Boolean(row.stale)) changed = true;
    row.stale = stale;
    row.status = stale ? "offline" : "online";
    if (stale && row.state_code === "ACTIVE") row.confidence = "low";
    s.row = row;
  }
  return { state: s, windows: out.windows, weeks: out.weeks, changed };
}

/** Stale = no VALID quota report for > 75 min (auth/error reports carry no quota data). */
export function isStale(s, now) {
  const ref = Math.max(s.last_valid_at || 0, s.last_report_at || 0);
  return now - ref > STALE_MS;
}

// ---------------------------------------------------------------------------
// Row analytics
// ---------------------------------------------------------------------------

export function computeWeekly(limits, now) {
  if (!Array.isArray(limits)) return { weekly_used: null, weekly_capped: false, weekly_warning: false, weekly_resets_at: null, weekly_reset_ready: false };
  let found = false; // at least one current weekly limit with a numeric percent
  let best = null;
  let bestReset = null;
  let hasExpiredWeekly = false;
  for (const l of limits) {
    if (!l || typeof l !== "object") continue;
    const isWeekly = l.group === "weekly" || (l.kind && (l.kind.startsWith("seven_day") || l.kind.startsWith("weekly")));
    if (!isWeekly) continue;
    if (l.resets_at !== null && l.resets_at !== undefined && l.resets_at <= now) {
      if (now - l.resets_at <= 2 * HOUR_MS + 10 * MINUTE_MS) {
        hasExpiredWeekly = true;
      }
      continue;
    }
    if (typeof l.percent !== "number" || !Number.isFinite(l.percent)) continue;
    found = true;
    if (!(l.is_active || l.percent > 0)) continue;
    if (best === null || l.percent > best) {
      best = l.percent;
      bestReset = l.resets_at;
    }
  }
  if (!found) {
    return {
      weekly_used: null,
      weekly_capped: false,
      weekly_warning: false,
      weekly_resets_at: null,
      weekly_reset_ready: hasExpiredWeekly,
    };
  }
  const used = best === null ? 0 : best;
  return {
    weekly_used: used,
    weekly_capped: used >= 95,
    weekly_warning: used >= 80 && used < 95,
    weekly_resets_at: bestReset,
    weekly_reset_ready: Boolean(hasExpiredWeekly && (best === null || best === 0)),
  };
}

/** Least-squares slope (%/h) of same-window samples in the last 90 min, or null. */
export function recentRate(samples, resetsAt, now) {
  const pts = samples
    .filter((p) => sameWindow(p.resets_at, resetsAt) && p.ts <= now && p.ts >= now - RECENT_SPAN_MS)
    .sort((a, b) => a.ts - b.ts);
  if (pts.length < 2) return null;
  if (pts[pts.length - 1].ts - pts[0].ts < RECENT_MIN_SPAN_MS) return null;
  // Utilisation only grows inside a window: take the running max (drops late, lower readings), keep one
  // point (first timestamp, latest running max) per 5-minute bucket, then regress with time weights (trapezoid of the neighbour
  // gaps) so bursts of near-simultaneous samples from several machines count once.
  let runMax = -Infinity;
  const buckets = new Map();
  for (const p of pts) {
    runMax = Math.max(runMax, p.used);
    const key = Math.floor(p.ts / RATE_BUCKET_MS);
    if (buckets.has(key)) buckets.get(key).used = runMax;
    else buckets.set(key, { ts: p.ts, used: runMax });
  }
  const bp = [...buckets.values()];
  if (bp.length < 2) return null;
  const xs = bp.map((p) => (p.ts - bp[0].ts) / HOUR_MS);
  const ys = bp.map((p) => p.used);
  const ws = bp.map((p, i) => {
    const prev = i > 0 ? p.ts - bp[i - 1].ts : 0;
    const next = i < bp.length - 1 ? bp[i + 1].ts - p.ts : 0;
    return (prev + next) / 2;
  });
  const sw = ws.reduce((a, b) => a + b, 0);
  const mx = xs.reduce((a, x, i) => a + ws[i] * x, 0) / sw;
  const my = ys.reduce((a, y, i) => a + ws[i] * y, 0) / sw;
  let num = 0;
  let den = 0;
  for (let i = 0; i < xs.length; i++) {
    num += ws[i] * (xs[i] - mx) * (ys[i] - my);
    den += ws[i] * (xs[i] - mx) * (xs[i] - mx);
  }
  if (den === 0) return null;
  return Math.max(0, num / den);
}

const AUTH_LABEL_KEYS = {
  expired_idle: "srv_auth_expired_idle",
  auth_required: "srv_auth_required",
  error: "srv_auth_error",
};

export function authLabelKey(state) {
  return AUTH_LABEL_KEYS[state] || AUTH_LABEL_KEYS.error;
}

export function authLabel(state) {
  return renderKey(authLabelKey(state), {}, "en");
}

/**
 * Full recompute of one account row at `now`.
 * `samples` are this account's samples (any window; filtered here).
 */
export function computeRow(s, samples, now) {
  const weekly = computeWeekly(s.limits, now);
  const stale = isStale(s, now);
  const base = {
    email: s.email,
    computed_at: toIso(now),
    computed_at_gmt7: formatGmt7(now),
    last_report_at: toIso(s.last_report_at),
    last_valid_at: toIso(s.last_valid_at),
    last_updated_gmt7: formatGmt7(s.last_report_at),
    last_updated_ago: s.last_report_at ? `${formatDuration(now - s.last_report_at)} ago` : "unknown",
    stale,
    status: stale ? "offline" : "online",
    client_version: s.client_version || null,
    ...weekly,
    weekly_resets_at: toIso(weekly.weekly_resets_at),
    weekly_reset_ready: Boolean(weekly.weekly_reset_ready),
    collision: false,
    seat_collision: false,
    // provider reset of the weekly quota inside the current week (null when none)
    reset_weekly_at: s.reset_weekly_ts && weekly.weekly_resets_at && s.reset_weekly_ts > weekly.weekly_resets_at - WEEK_MS ? toIso(s.reset_weekly_ts) : null,
    auth_state: s.auth_state || null,
    ...(s.auth_state ? txt("auth_label", authLabelKey(s.auth_state)) : { auth_label: null }),
    auth_at: toIso(s.auth_at),
    auth_error: s.auth_error || null,
    error_kind: s.error_kind || null,
    auth_warning: s.auth_warning
      ? {
        state: s.auth_warning.state,
        ...txt("label", authLabelKey(s.auth_warning.state)),
        at: toIso(s.auth_warning.at),
        error: s.auth_warning.error || null,
        error_kind: s.auth_warning.error_kind || null,
        // true only when the last valid measurement really came from a different machine
        from_other_machine: Boolean(s.last_valid_machine && s.auth_warning.machine_id
          && s.auth_warning.machine_id !== s.last_valid_machine),
        last_valid_at: toIso(s.last_valid_at),
      }
      : null,
    idle_since: s.win ? null : toIso(s.idle_from),
    five_hour_disabled: false,
    monthly_used_percent: s.monthly_used_percent ?? null,
    monthly_free_now: s.monthly_used_percent !== undefined && s.monthly_used_percent !== null ? r1(Math.max(0, 100 - s.monthly_used_percent)) : null,
    monthly_resets_at: toIso(s.monthly_resets_at),
    monthly_quota_limit: s.monthly_quota_limit ?? null,
    monthly_quota_used: s.monthly_quota_used ?? null,
    account_label: s.account_label || null,
    reset_passed_unverified: Boolean(
      (s.limits && s.limits.some((l) => l.resets_at && l.resets_at <= now && s.last_valid_at && s.last_valid_at < l.resets_at)) ||
      (s.resets_at && now >= s.resets_at && s.last_valid_at && s.last_valid_at < s.resets_at)
    ),
  };
  const resetsAt = s.resets_at;
  const nullMetrics = {
    rate_window: null,
    rate_recent: null,
    velocity: null,
    burn_rate_1h: null,
    confidence: null,
    raw_projection: null,
    projected_percent: null,
    projected_exhaustion: null,
    at_risk_waste: null,
    exhaust_at: null,
    exhaust_at_gmt7: null,
    burn_needed_per_h: null,
    surplus_deficit_text: null,
  };

  if (s.auth_state) {
    const activeKnown = resetsAt !== null && now < resetsAt;
    return {
      ...base,
      ...nullMetrics,
      state_code: "AUTH",
      used_percent: s.used,
      remaining_percent: null,
      free_now: null,
      resets_at: activeKnown ? toIso(resetsAt) : null,
      resets_at_gmt7: activeKnown ? formatGmt7(resetsAt) : "N/A",
      resets_in: activeKnown ? formatDuration(resetsAt - now) : "N/A",
      remaining_hours: activeKnown ? r1((resetsAt - now) / HOUR_MS) : null,
      window_start: activeKnown ? toIso(resetsAt - WINDOW_MS) : null,
      pacing_status: "moderate",
      ...txt("pacing_badge_text", s.auth_state === "expired_idle" ? "srv_badge_token_expired" : "srv_badge_login"),
      ...(s.used === null
        ? txt("prediction_text", "srv_pred_auth_none", { label: authLabelKey(s.auth_state) })
        : txt("prediction_text", "srv_pred_auth", { label: authLabelKey(s.auth_state), used: s.used })),
    };
  }

  const until = typeof s.disabled_until === "number" ? s.disabled_until : null;
  if (s.five_hour_disabled && (until === null || now < until)) {
    // 5h bucket disabled because the weekly limit is hit: COOLDOWN until the weekly reset, weekly-capped.
    return {
      ...base,
      ...nullMetrics,
      weekly_used: weekly.weekly_used === null ? 100 : weekly.weekly_used,
      weekly_capped: true,
      weekly_warning: false,
      weekly_resets_at: toIso(weekly.weekly_resets_at ?? until),
      five_hour_disabled: true,
      velocity: 0,
      raw_projection: 100,
      projected_percent: 100,
      at_risk_waste: 0,
      state_code: "COOLDOWN",
      used_percent: 100,
      remaining_percent: 0,
      free_now: 0,
      resets_at: toIso(until),
      resets_at_gmt7: until === null ? "N/A" : formatGmt7(until),
      resets_in: until === null ? "N/A" : formatDuration(until - now),
      remaining_hours: until === null ? null : r1((until - now) / HOUR_MS),
      window_start: null,
      pacing_status: "danger",
      ...txt("pacing_badge_text", "srv_badge_weekly_cap"),
      ...(until === null
        ? txt("prediction_text", "srv_pred_cap_5h_locked")
        : txt("prediction_text", "srv_pred_cap_5h_until", { until, left: until - now })),
      surplus_deficit_text: "0%",
    };
  }

  if (resetsAt === null || now >= resetsAt) {
    const free = weekly.weekly_capped ? 0 : 100;
    return {
      ...base,
      ...nullMetrics,
      velocity: 0,
      raw_projection: 0,
      projected_percent: 0,
      at_risk_waste: 0,
      state_code: "FRESH",
      used_percent: 0,
      remaining_percent: 100,
      free_now: free,
      resets_at: null,
      resets_at_gmt7: "N/A",
      ...txt("resets_in", "srv_ready"),
      remaining_hours: 0,
      window_start: null,
      pacing_status: "safe",
      ...txt("pacing_badge_text", "srv_badge_ready"),
      ...txt("prediction_text", "srv_pred_ready_5h"),
      surplus_deficit_text: "+100%",
    };
  }

  const used = s.used === null ? 0 : s.used;
  const remainingH = Math.max(0, (resetsAt - now) / HOUR_MS);
  const windowFields = {
    used_percent: used,
    remaining_percent: r1(Math.max(0, 100 - used)),
    resets_at: toIso(resetsAt),
    resets_at_gmt7: formatGmt7(resetsAt),
    resets_in: formatDuration(resetsAt - now),
    remaining_hours: r1(remainingH),
    window_start: toIso(resetsAt - WINDOW_MS),
    // provider reset of the 5h quota inside this window: pace is measured from then
    reset_5h_at: s.reset_5h_ts && s.reset_5h_ts > resetsAt - WINDOW_MS ? toIso(s.reset_5h_ts) : null,
  };
  const rst5 = windowFields.reset_5h_at ? s.reset_5h_ts : null;

  if (used >= 100) {
    return {
      ...base,
      ...nullMetrics,
      ...windowFields,
      velocity: 0,
      raw_projection: 100,
      projected_percent: 100,
      at_risk_waste: 0,
      state_code: "COOLDOWN",
      free_now: 0,
      pacing_status: "danger",
      ...txt("pacing_badge_text", "srv_badge_cap"),
      ...txt("prediction_text", "srv_pred_cap", { at: resetsAt, left: resetsAt - now }),
      surplus_deficit_text: "0%",
    };
  }

  const elapsedH = clamp((now - Math.max(resetsAt - WINDOW_MS, rst5 || 0)) / HOUR_MS, 0, WINDOW_H);
  // Floor at 1h: a burst in the first minutes must not be extrapolated over the whole window.
  const rWindow = used / Math.max(elapsedH, 1);
  const rRecent = recentRate(rst5 ? samples.filter((p) => p.ts >= rst5) : samples, resetsAt, now);
  let rate = rRecent === null ? rWindow : 0.6 * rRecent + 0.4 * rWindow;
  let confidence = rRecent === null ? "medium" : "high";
  // Under 1h into a window, a few minutes of burst dominate the extrapolation.
  if (elapsedH < 1) confidence = "low";
  if (stale) {
    rate = 0;
    confidence = "low";
  }
  const rawProjection = used + rate * remainingH;
  const atRisk = Math.max(0, 100 - rawProjection);
  const rawExhaustAt = rawProjection >= 100 && rate > 0 ? now + ((100 - used) / rate) * HOUR_MS : null;
  const exhaustAt = rawExhaustAt !== null && rawExhaustAt > now ? rawExhaustAt : null;
  const burnNeeded = (100 - used) / Math.max(remainingH, 0.1);
  const projected = Math.min(rawProjection, 100);

  // Thin data (first hour of a window, or no recent report): the floored rate is only an upper
  // bound on waste. The pace actually seen so far (>= 10 min of elapsed time) gives the lower bound.
  const uncertain = confidence === "low";
  const uncertainReason = !uncertain ? null : stale ? "stale" : "early_window";
  const rBurst = Math.max(rRecent === null ? 0 : rRecent, used / Math.max(elapsedH, 1 / 6));
  const wasteMax = atRisk;
  const wasteMin = uncertain ? Math.min(atRisk, Math.max(0, 100 - used - rBurst * remainingH)) : atRisk;

  let pacing = "safe";
  if (rawProjection >= 100) pacing = "danger";
  else if (projected >= 85 || used >= 75) pacing = "moderate";

  let prediction;
  if (stale) {
    prediction = txt("prediction_text", "srv_pred_stale", { waste: r1(atRisk), at: resetsAt });
  } else if (exhaustAt !== null) {
    prediction = txt("prediction_text", "srv_pred_exhaust", { at: exhaustAt, gap: resetsAt - exhaustAt });
  } else {
    prediction = txt("prediction_text", "srv_pred_projected", { proj: r1(projected), at: resetsAt, waste: r1(atRisk) });
  }

  return {
    ...base,
    ...windowFields,
    state_code: "ACTIVE",
    free_now: weekly.weekly_capped ? 0 : r1(Math.max(0, 100 - used)),
    rate_window: r1(rWindow),
    rate_recent: rRecent === null ? null : r1(rRecent),
    velocity: r1(rate),
    burn_rate_1h: r1(rate),
    confidence,
    raw_projection: r1(rawProjection),
    projected_percent: r1(projected),
    projected_exhaustion: exhaustAt !== null ? toIso(exhaustAt) : null,
    at_risk_waste: r1(atRisk),
    at_risk_waste_min: r1(wasteMin),
    at_risk_waste_max: r1(wasteMax),
    uncertain,
    uncertain_reason: uncertainReason,
    exhaust_at: toIso(exhaustAt),
    exhaust_at_gmt7: exhaustAt === null ? null : formatGmt7(exhaustAt),
    burn_needed_per_h: r1(burnNeeded),
    elapsed_hours: r1(elapsedH),
    pacing_status: pacing,
    ...txt("pacing_badge_text", pacing === "danger" ? "srv_badge_danger" : pacing === "moderate" ? "srv_badge_moderate" : "srv_badge_ok"),
    ...prediction,
    surplus_deficit_text: rawProjection >= 100 ? `-${r1(rawProjection - 100)}%` : `+${r1(atRisk)}%`,
  };
}

// ---------------------------------------------------------------------------
// Weekly (7d) view of a row: the same analysis as computeRow, over the 7-day window.
// Returns only the fields that differ from the 5h row, so callers do `{ ...row, ...computeWeeklyRow(row, now) }`.
// ---------------------------------------------------------------------------

export const WEEK_H = 168;
export const WEEK_MS = WEEK_H * HOUR_MS;
/** Under this much elapsed time in the week, the extrapolation is only a rough guess (5h view: 1h of 5h). */
export const WEEK_ROUGH_H = 24;
/** Floor on elapsed time for the weekly rate (5h view: 1h), so a first-hours burst is not extrapolated over the week. */
const WEEK_RATE_FLOOR_H = 6;

export function computeWeeklyRow(r, now) {
  if (r.state_code === "AUTH") return {};
  const nullMetrics = {
    rate_window: null, rate_recent: null, velocity: null, confidence: null, raw_projection: null,
    projected_percent: null, at_risk_waste: 0, at_risk_waste_min: 0, at_risk_waste_max: 0, uncertain: false,
    uncertain_reason: null, exhaust_at: null, exhaust_at_gmt7: null, burn_needed_per_h: null, surplus_deficit_text: null,
    elapsed_hours: null,
  };
  const hasWeekly = r.weekly_used !== null && r.weekly_used !== undefined;
  const resetsAt = tsOf(r.weekly_resets_at);
  const common = { five_hour_disabled: false };

  if (!hasWeekly) {
    // The client has not reported a weekly figure yet: show the 5h numbers, clearly labelled, with no forecast.
    return {
      ...common, ...nullMetrics,
      pacing_status: "moderate",
      ...txt("pacing_badge_text", "srv_badge_no_weekly"),
      ...txt("prediction_text", "srv_pred_no_weekly"),
    };
  }

  const used = r.weekly_used;
  if (resetsAt !== null && now >= resetsAt) {
    return {
      ...common, ...nullMetrics,
      velocity: 0, raw_projection: 0, projected_percent: 0,
      state_code: "FRESH",
      used_percent: 0, remaining_percent: 100, free_now: 100,
      resets_at: null, resets_at_gmt7: "N/A", ...txt("resets_in", "srv_ready"), remaining_hours: null, window_start: null,
      weekly_capped: false,
      weekly_used: 0,
      weekly_resets_at: null,
      pacing_status: "safe",
      ...txt("pacing_badge_text", "srv_badge_ready"),
      ...txt("prediction_text", "srv_pred_ready_week"),
      surplus_deficit_text: "+100%",
      reset_passed_unverified: Boolean(r.last_valid_at && tsOf(r.last_valid_at) < resetsAt),
    };
  }

  if (resetsAt === null) {
    // Nothing used in the current week yet (no active weekly limit): like a 5h account without an open window.
    const capped = used >= 95;
    return {
      ...common, ...nullMetrics,
      velocity: 0, raw_projection: used, projected_percent: used,
      state_code: used > 0 ? (capped ? "COOLDOWN" : "ACTIVE") : "FRESH",
      used_percent: used, remaining_percent: r1(Math.max(0, 100 - used)), free_now: capped ? 0 : r1(Math.max(0, 100 - used)),
      resets_at: null, resets_at_gmt7: "N/A", ...txt("resets_in", "srv_ready"), remaining_hours: null, window_start: null,
      weekly_capped: capped,
      pacing_status: capped ? "danger" : "safe",
      ...txt("pacing_badge_text", capped ? "srv_badge_weekly_cap" : "srv_badge_ready"),
      ...txt("prediction_text", capped ? "srv_badge_weekly_cap" : "srv_pred_ready_week"),
      surplus_deficit_text: capped ? "0%" : "+100%",
    };
  }

  const remainingH = Math.max(0, (resetsAt - now) / HOUR_MS);
  const windowFields = {
    used_percent: used,
    remaining_percent: r1(Math.max(0, 100 - used)),
    resets_at: toIso(resetsAt),
    resets_at_gmt7: formatGmt7(resetsAt),
    resets_in: formatDuration(resetsAt - now),
    ...noKey("resets_in"), // the 5h row may carry a "Ready" key
    remaining_hours: r1(remainingH),
    window_start: toIso(resetsAt - WEEK_MS),
  };

  if (used >= 95) {
    return {
      ...common, ...nullMetrics, ...windowFields,
      velocity: 0, raw_projection: 100, projected_percent: 100,
      state_code: "COOLDOWN", free_now: 0, weekly_capped: true,
      pacing_status: "danger", ...txt("pacing_badge_text", "srv_badge_weekly_cap"),
      ...txt("prediction_text", "srv_pred_week_capped", { used: r1(used), at: resetsAt, left: resetsAt - now }),
      surplus_deficit_text: "0%",
    };
  }

  // after a provider reset of the weekly quota, the pace is measured from the reset
  const wkStart = Math.max(resetsAt - WEEK_MS, tsOf(r.reset_weekly_at) || 0);
  const elapsedH = clamp((now - wkStart) / HOUR_MS, 0, WEEK_H);
  const rWindow = used / Math.max(elapsedH, WEEK_RATE_FLOOR_H);
  let rate = rWindow;
  let confidence = "medium";
  if (elapsedH < WEEK_ROUGH_H) confidence = "low";
  if (r.stale) {
    rate = 0;
    confidence = "low";
  }
  const rawProjection = used + rate * remainingH;
  const atRisk = Math.max(0, 100 - rawProjection);
  const rawExhaustAt = rawProjection >= 100 && rate > 0 ? now + ((100 - used) / rate) * HOUR_MS : null;
  const exhaustAt = rawExhaustAt !== null && rawExhaustAt > now ? rawExhaustAt : null;
  const burnNeeded = (100 - used) / Math.max(remainingH, 0.1);
  const projected = Math.min(rawProjection, 100);

  const uncertain = confidence === "low";
  const uncertainReason = !uncertain ? null : r.stale ? "stale" : "early_window";
  const rBurst = used / Math.max(elapsedH, 1);
  const wasteMin = uncertain ? Math.min(atRisk, Math.max(0, 100 - used - rBurst * remainingH)) : atRisk;

  let pacing = "safe";
  if (rawProjection >= 100) pacing = "danger";
  else if (projected >= 85 || used >= 75) pacing = "moderate";

  let prediction;
  if (r.stale) {
    prediction = txt("prediction_text", "srv_pred_stale_dt", { waste: r1(atRisk), at: resetsAt });
  } else if (exhaustAt !== null) {
    prediction = txt("prediction_text", "srv_pred_exhaust_dt", { at: exhaustAt, gap: resetsAt - exhaustAt });
  } else {
    prediction = txt("prediction_text", "srv_pred_projected_dt", { proj: r1(projected), at: resetsAt, waste: r1(atRisk) });
  }

  return {
    ...common, ...windowFields,
    state_code: "ACTIVE",
    weekly_capped: false,
    free_now: r1(Math.max(0, 100 - used)),
    rate_window: r1(rWindow),
    rate_recent: null,
    velocity: r1(rate),
    confidence,
    raw_projection: r1(rawProjection),
    projected_percent: r1(projected),
    at_risk_waste: r1(atRisk),
    at_risk_waste_min: r1(wasteMin),
    at_risk_waste_max: r1(atRisk),
    uncertain,
    uncertain_reason: uncertainReason,
    exhaust_at: toIso(exhaustAt),
    exhaust_at_gmt7: exhaustAt === null ? null : formatGmt7(exhaustAt),
    burn_needed_per_h: r1(burnNeeded),
    elapsed_hours: r1(elapsedH),
    pacing_status: pacing,
    ...txt("pacing_badge_text", pacing === "danger" ? "srv_badge_danger" : pacing === "moderate" ? "srv_badge_moderate" : "srv_badge_ok"),
    ...prediction,
    surplus_deficit_text: rawProjection >= 100 ? `-${r1(rawProjection - 100)}%` : `+${r1(atRisk)}%`,
  };
}

// ---------------------------------------------------------------------------
// Heatmap: unused capacity per GMT+7 hour-of-day (units: % of a 5h window)
// ---------------------------------------------------------------------------

/** Spread `perHour * hours` of an interval into 24 GMT+7 hour buckets by minute fraction. */
export function addInterval(buckets, start, end, perHour) {
  if (!(end > start) || !(perHour > 0)) return;
  let t = start;
  while (t < end) {
    const local = t + GMT7_OFFSET_MS;
    const nextBoundary = Math.floor(local / HOUR_MS) * HOUR_MS + HOUR_MS - GMT7_OFFSET_MS;
    const segEnd = Math.min(end, nextBoundary);
    const hour = new Date(local).getUTCHours();
    buckets[hour] += ((segEnd - t) / HOUR_MS) * perHour;
    t = segEnd;
  }
}

function openGapEnd(s, now) {
  if (s.win || s.idle_from === null || s.idle_from === undefined) return null;
  const cap = s.last_valid_at ? s.last_valid_at + FRESH_TAIL_MS : null;
  if (cap === null) return null;
  const end = Math.min(now, cap);
  return end > s.idle_from ? end : null;
}

/** GMT+7 day index relative to the day of `now` (0 = today, -1 = yesterday...). */
function dayOffset(ts, now) {
  return Math.floor((ts + GMT7_OFFSET_MS) / DAY_MS) - Math.floor((now + GMT7_OFFSET_MS) / DAY_MS);
}

/** Spread `perHour * hours` of an interval into GMT+7 day buckets (last `n` days, last = today). */
export function addIntervalDays(buckets, start, end, perHour, now) {
  if (!(end > start) || !(perHour > 0)) return;
  const n = buckets.length;
  let t = start;
  while (t < end) {
    const local = t + GMT7_OFFSET_MS;
    const nextBoundary = Math.floor(local / DAY_MS) * DAY_MS + DAY_MS - GMT7_OFFSET_MS;
    const segEnd = Math.min(end, nextBoundary);
    const idx = n - 1 + dayOffset(t, now);
    if (idx >= 0 && idx < n) buckets[idx] += ((segEnd - t) / HOUR_MS) * perHour;
    t = segEnd;
  }
}

export const HISTORY_DAYS = 14;
/** A closed window whose last sample is older than this at its end has an unknown tail: its usage is only a lower bound. */
export const UNCERTAIN_WINDOW_MIN = 30;
/** Weekly limit share at which the weekly cap, not 5h idleness, is what bounds usage (pooled providers). */
export const WEEKLY_BINDING_PCT = 95;

export function computeHeatmap(states, windows, gaps, now) {
  const from = now - HEATMAP_SPAN_MS;
  const team = new Array(24).fill(0);
  const accounts = [];
  const stats = {};
  const daily = [];
  const log = [];
  for (const s of states) {
    const raw = new Array(24).fill(0);
    const dayWaste = new Array(HISTORY_DAYS).fill(0);
    const dayIdle = new Array(HISTORY_DAYS).fill(0);
    let windowsClosed = 0;
    let wasteSum = 0;
    let usedSum = 0;
    let idleMs = 0;
    let uncertainWindows = 0;
    let uncertainWasteSum = 0; // waste of windows with an unknown tail: only an upper bound
    let silentMin = 0;
    for (const w of windows) {
      if (w.email !== s.email || w.end_ts < from) continue;
      windowsClosed += 1;
      wasteSum += w.waste;
      usedSum += w.final_used;
      const uncMin = w.uncertainty_min === undefined || w.uncertainty_min === null
        ? Math.round(Math.max(0, w.end_ts - w.last_sample_ts) / MINUTE_MS)
        : w.uncertainty_min;
      silentMin += uncMin;
      if (uncMin > UNCERTAIN_WINDOW_MIN) {
        uncertainWindows += 1;
        uncertainWasteSum += w.waste;
      }
      addInterval(raw, Math.max(w.start_ts, from), Math.min(w.end_ts, now), w.waste / WINDOW_H);
      addIntervalDays(dayWaste, Math.max(w.start_ts, from), Math.min(w.end_ts, now), w.waste / WINDOW_H, now);
      log.push({
        email: s.account_email || s.email,
        account_key: s.email,
        start: w.start_ts,
        end: w.end_ts,
        used: w.final_used,
        waste: w.waste,
        unc: uncMin,
        uncertain: uncMin > UNCERTAIN_WINDOW_MIN,
      });
    }
    const idleIntervals = gaps
      .filter((g) => g.email === s.email && g.end_ts >= from)
      .map((g) => [g.start_ts, g.end_ts]);
    const openEnd = openGapEnd(s, now);
    if (openEnd !== null) idleIntervals.push([s.idle_from, openEnd]);
    // Pooled providers: once the weekly limit is what binds (>= 95% used), idle 5h time of the current weekly
    // period is not waste (the weekly quota was the real ceiling). Earlier weeks have no stored usage: unchanged.
    const wk = s.pool ? computeWeekly(s.limits, now) : null;
    const weeklyBinding = Boolean(wk && wk.weekly_used !== null && wk.weekly_used >= WEEKLY_BINDING_PCT && wk.weekly_resets_at);
    const weekStart = weeklyBinding ? wk.weekly_resets_at - 7 * DAY_MS : null;
    let idleExcludedMs = 0;
    for (const [a, b] of idleIntervals) {
      const st = Math.max(a, from);
      const en = Math.min(b, now);
      if (weekStart !== null && en > Math.max(st, weekStart)) {
        idleExcludedMs += en - Math.max(st, weekStart);
        if (st >= weekStart) continue;
        if (Math.min(en, weekStart) > st) {
          idleMs += Math.min(en, weekStart) - st;
          addInterval(raw, st, Math.min(en, weekStart), 100 / WINDOW_H);
          addIntervalDays(dayIdle, st, Math.min(en, weekStart), 1, now);
        }
        continue;
      }
      if (en > st) {
        idleMs += en - st;
        addInterval(raw, st, en, 100 / WINDOW_H);
        addIntervalDays(dayIdle, st, en, 1, now);
      }
    }
    const observedFrom = Math.max(from, s.first_seen || now);
    const observedDays = Math.max(1, (now - observedFrom) / DAY_MS);
    const values = raw.map((v) => r1(v / observedDays));
    values.forEach((v, i) => { team[i] += v; });
    accounts.push({ email: s.account_email || s.email, account_key: s.email, pool: s.pool || null, values, observed_days: r1(observedDays) });
    const idleH = idleMs / HOUR_MS;
    const usedW = usedSum / 100;
    const wastedW = wasteSum / 100;
    const idleW = idleH / WINDOW_H;
    const capacity = usedW + wastedW + idleW;
    // Upper bound: windows with an unknown tail may in fact have been used fully.
    const usedMaxW = usedW + uncertainWasteSum / 100;
    const wastedMinW = wastedW - uncertainWasteSum / 100;
    const capacityMax = usedMaxW + wastedMinW + idleW;
    stats[s.email] = {
      efficiency_max: capacityMax > 0 ? r1((usedMaxW / capacityMax) * 100) : null,
      uncertain_windows: uncertainWindows,
      silent_hours: r1(silentMin / 60),
      weekly_used: wk && wk.weekly_used !== null ? wk.weekly_used : null,
      weekly_binding: weeklyBinding,
      idle_excluded_hours: r1(idleExcludedMs / HOUR_MS),
      windows_closed: windowsClosed,
      avg_waste_per_window: windowsClosed > 0 ? r1(wasteSum / windowsClosed) : null,
      total_wasted: r1(wasteSum),
      idle_hours: r1(idleH),
      used_windows: Math.round(usedW * 100) / 100,
      wasted_windows: Math.round(wastedW * 100) / 100,
      idle_windows: Math.round(idleW * 100) / 100,
      efficiency: capacity > 0 ? r1((usedW / capacity) * 100) : null,
    };
    daily.push({
      email: s.account_email || s.email,
      account_key: s.email,
      waste_pct: dayWaste.map(r1),
      idle_h: dayIdle.map((v) => Math.round(v * 100) / 100),
    });
  }
  const dayLabels = [];
  for (let i = HISTORY_DAYS - 1; i >= 0; i--) {
    const p = gmt7Parts(now - i * DAY_MS);
    dayLabels.push(`${p.DD}/${p.MM}`);
  }
  log.sort((a, b) => b.end - a.end);
  const teamValues = team.map(r1);
  const golden = teamValues
    .map((value, hour) => ({ hour, value }))
    .filter((x) => x.value > 0)
    .sort((a, b) => b.value - a.value || a.hour - b.hour)
    .slice(0, 3)
    .map((x) => ({
      ...x,
      label: `${String(x.hour).padStart(2, "0")}:00–${String((x.hour + 1) % 24).padStart(2, "0")}:00`,
    }));
  return {
    heatmap: {
      ...txt("unit", "srv_heatmap_unit"),
      span_days: 14,
      accounts,
      team: teamValues,
    },
    golden_hours: golden,
    stats,
    history: {
      days: dayLabels,
      daily,
      // Compact closed-window log (epoch ms), newest first, capped for snapshot size.
      windows: log.slice(0, 400),
    },
  };
}

// ---------------------------------------------------------------------------
// Team snapshot: totals, recommendations, timeline
// ---------------------------------------------------------------------------

function isUsable(row) {
  return row.state_code !== "AUTH" && !row.weekly_capped;
}

function tsOf(iso) {
  return iso ? Date.parse(iso) : null;
}

// Lower bound of the at-risk waste (rows built by hand or by older snapshots only have at_risk_waste).
const wasteLo = (r) => (r.at_risk_waste_min === undefined || r.at_risk_waste_min === null ? r.at_risk_waste : r.at_risk_waste_min) || 0;

export function computeOpportunity(rows, states, now) {
  const stateBy = Object.fromEntries(states.map((s) => [s.email, s]));
  const ident = (r) => ({ email: r.email, account_key: keyOf(r), pool: r.pool || null });

  const useBeforeReset = rows
    .filter((r) => r.state_code === "ACTIVE" && !r.weekly_capped && r.at_risk_waste >= 10)
    .map((r) => {
      const resetTs = tsOf(r.resets_at);
      const remH = Math.max(0, (resetTs - now) / HOUR_MS);
      const burn = (100 - r.used_percent) / Math.max(remH, 0.1);
      return {
        ...ident(r),
        at_risk_waste: r.at_risk_waste,
        at_risk_waste_min: wasteLo(r),
        at_risk_waste_max: r.at_risk_waste,
        uncertain: Boolean(r.uncertain),
        free_now: r.free_now,
        resets_at: r.resets_at,
        resets_at_hm: formatHM(resetTs),
        remaining_hours: r1(remH),
        burn_needed_per_h: r1(burn),
        confidence: r.confidence,
        stale: r.stale,
        score: wasteLo(r) / Math.max(remH, 0.25),
        score_max: r.at_risk_waste / Math.max(remH, 0.25),
        ...(r.uncertain
          ? txt("text", "srv_opp_waste_maybe", { lo: wasteLo(r), hi: r.at_risk_waste, at: resetTs, left: resetTs - now })
          : txt("text", "srv_opp_waste", { waste: r.at_risk_waste, at: resetTs, left: resetTs - now, burn: r1(burn) })),
      };
    })
    .sort((a, b) => (b.score - a.score) || (b.score_max - a.score_max))
    .map((x) => ({ ...x, score: r1(x.score), score_max: r1(x.score_max) }));

  const freshNow = rows
    .filter((r) => r.state_code === "FRESH" && !r.weekly_capped)
    .map((r) => {
      const st = stateBy[keyOf(r)];
      const idleFrom = st && !st.win && st.idle_from !== null && st.idle_from !== undefined ? st.idle_from : null;
      const idleMs = idleFrom === null ? null : Math.max(0, now - idleFrom);
      return {
        ...ident(r),
        idle_since: toIso(idleFrom),
        idle_since_hm: idleFrom === null ? null : formatHMDM(idleFrom),
        idle_hours: idleMs === null ? null : r1(idleMs / HOUR_MS),
        stale: r.stale,
        ...(idleFrom === null
          ? txt("text", "srv_opp_ready_unknown")
          : txt("text", "srv_opp_ready_idle", { since: idleFrom, idle: idleMs })),
      };
    })
    .sort((a, b) => (b.idle_hours === null ? -1 : b.idle_hours) - (a.idle_hours === null ? -1 : a.idle_hours));

  const exhaustsBeforeReset = (r) => r.state_code === "ACTIVE" && Boolean(r.exhaust_at)
    && tsOf(r.exhaust_at) < tsOf(r.resets_at);

  // Alternatives: never AUTH, weekly-capped, stale (unknown current usage), or itself running out before reset.
  // Only rows of the same pool: pools never substitute for each other.
  const alternatives = (row) => {
    const ok = (r) => keyOf(r) !== keyOf(row) && (r.pool || null) === (row.pool || null)
      && isUsable(r) && !r.stale && !exhaustsBeforeReset(r);
    const freshRows = new Set(rows.filter((r) => r.state_code === "FRESH" && ok(r)).map(keyOf));
    const fresh = freshNow.find((f) => freshRows.has(f.account_key));
    if (fresh) return { ...ident(fresh), free_now: 100, state_code: "FRESH" };
    const best = rows
      .filter((r) => r.state_code === "ACTIVE" && ok(r) && r.free_now > 0)
      .sort((a, b) => b.free_now - a.free_now)[0];
    return best ? { ...ident(best), free_now: best.free_now, state_code: best.state_code } : null;
  };

  // Weekly-capped accounts are already reported as capped; listing them here would double-warn.
  const willExhaust = rows
    .filter((r) => exhaustsBeforeReset(r) && !r.weekly_capped)
    .map((r) => {
      const ex = tsOf(r.exhaust_at);
      const reset = tsOf(r.resets_at);
      const alt = alternatives(r);
      const past = ex <= now;
      const text = past
        ? (alt
          ? txt("text", "srv_opp_exhausted_maybe_alt", { at: ex, reset, email: alt.email, free: alt.free_now })
          : txt("text", "srv_opp_exhausted_maybe", { at: ex, reset }))
        : (alt
          ? txt("text", "srv_opp_exhaust_alt", { at: ex, gap: reset - ex, email: alt.email, free: alt.free_now })
          : txt("text", "srv_pred_exhaust", { at: ex, gap: reset - ex }));
      return {
        ...ident(r),
        exhaust_at: r.exhaust_at,
        exhaust_at_hm: formatHM(ex),
        resets_at: r.resets_at,
        resets_at_hm: formatHM(reset),
        hours_before_reset: r1((reset - ex) / HOUR_MS),
        confidence: r.confidence,
        alternative: alt,
        ...text,
      };
    })
    .sort((a, b) => tsOf(a.exhaust_at) - tsOf(b.exhaust_at));

  // Every account that is in none of the lists above (and is not an idle-expired token, which the dashboard
  // already lists on its own), so the ranked list can always show the whole team with a reason per row.
  const listed = new Set([...useBeforeReset, ...freshNow, ...willExhaust].map((x) => x.account_key));
  const others = rows
    .filter((r) => !listed.has(keyOf(r)) && !(r.state_code === "AUTH" && r.auth_state === "expired_idle"))
    .map((r) => {
      const reset = tsOf(r.resets_at);
      const at = reset;
      const left = reset === null ? null : reset - now;
      const sfx = r.stale && r.state_code !== "AUTH" ? "srv_sfx_signal_lost" : null;
      let kind;
      let text;
      if (r.state_code === "AUTH") {
        kind = "unreadable";
        // rows stored before the *_key fields existed have no badge key: every unreadable row listed here needs a login
        text = txt("text", "srv_other_unreadable", { reason: r.pacing_badge_text_key || "srv_att_login" });
      } else if (r.weekly_capped) {
        kind = "weekly_capped";
        text = reset === null ? txt("text", "srv_other_weekly_cap", { sfx }) : txt("text", "srv_other_weekly_cap_until", { at, left, sfx });
      } else if (r.state_code === "COOLDOWN") {
        kind = "cooldown";
        text = txt("text", "srv_other_cooldown", { at, left, sfx });
      } else if (r.state_code === "FRESH") {
        kind = "idle";
        text = txt("text", "srv_other_idle", { sfx });
      } else {
        kind = "no_action";
        text = txt("text", "srv_other_no_action", { free: r.free_now, at, left, sfx });
      }
      return {
        ...ident(r),
        kind,
        state_code: r.state_code,
        free_now: r.state_code === "AUTH" ? null : r.free_now,
        used_percent: r.used_percent,
        at_risk_waste: r.at_risk_waste,
        resets_at: r.resets_at,
        resets_at_hm: reset === null ? null : formatHM(reset),
        remaining_hours: reset === null ? null : r1(Math.max(0, (reset - now) / HOUR_MS)),
        stale: r.stale,
        ...text,
      };
    })
    .sort((a, b) => ((b.free_now ?? -1) - (a.free_now ?? -1)) || a.email.localeCompare(b.email));

  const horizon = now + TIMELINE_SPAN_MS;
  const timeline = rows
    .filter((r) => r.state_code !== "AUTH")
    .map((r) => {
      const events = [];
      const reset = tsOf(r.resets_at);
      const ex = tsOf(r.exhaust_at);
      if (ex !== null && ex > now && ex <= horizon && (reset === null || ex < reset)) {
        events.push({ type: "exhaust", at: r.exhaust_at, at_hm: formatHM(ex) });
      }
      if (reset !== null && reset > now && reset <= horizon) {
        events.push({
          type: "reset",
          at: r.resets_at,
          at_hm: formatHM(reset),
          fresh_percent: 100,
          expiring_percent: r.at_risk_waste,
          expiring_percent_min: wasteLo(r),
          uncertain: Boolean(r.uncertain),
        });
      }
      return {
        ...ident(r),
        state_code: r.state_code,
        used_percent: r.used_percent,
        free_now: r.free_now,
        at_risk_waste: r.at_risk_waste,
        at_risk_waste_min: wasteLo(r),
        uncertain: Boolean(r.uncertain),
        window_start: r.window_start,
        resets_at: r.resets_at,
        exhaust_at: r.exhaust_at,
        weekly_capped: r.weekly_capped,
        events,
      };
    });

  return {
    use_before_reset: useBeforeReset,
    fresh_now: freshNow,
    will_exhaust: willExhaust,
    others,
    timeline_12h: { from: toIso(now), to: toIso(horizon), lanes: timeline },
  };
}

export function computeTotals(rows, opportunity) {
  const usable = rows.filter(isUsable);
  const freeSum = usable.reduce((a, r) => a + (r.free_now || 0), 0);
  const activeUsable = usable.filter((r) => r.state_code === "ACTIVE");
  const riskSumMax = activeUsable.reduce((a, r) => a + (r.at_risk_waste || 0), 0);
  // Headline counts only what is certain to be lost (lower bound).
  const riskSum = activeUsable.reduce((a, r) => a + wasteLo(r), 0);
  const count = (code) => rows.filter((r) => r.state_code === code).length;
  const capped = rows.filter((r) => r.weekly_capped).length;
  const weeklyWarn = rows.filter((r) => r.weekly_warning).length;
  return {
    free_now_sum: r1(freeSum),
    free_now_windows: r1(freeSum / 100),
    at_risk_waste_sum: r1(riskSum),
    at_risk_waste_max_sum: r1(riskSumMax),
    uncertain_count: activeUsable.filter((r) => r.uncertain).length,
    fresh_count: rows.filter((r) => r.state_code === "FRESH" && !r.weekly_capped).length,
    active_count: count("ACTIVE"),
    cooldown_count: count("COOLDOWN"),
    auth_count: count("AUTH"),
    capped_count: capped,
    weekly_warning_count: weeklyWarn,
    exhaust_count: opportunity.will_exhaust.length,
    stale_count: rows.filter((r) => r.stale && r.state_code !== "AUTH").length,
    // distinct accounts needing attention (AUTH, weekly-capped or running out before reset)
    warning_count: new Set([
      ...rows.filter((r) => r.state_code === "AUTH" || r.weekly_capped).map(keyOf),
      ...opportunity.will_exhaust.map(keyOf),
    ]).size,
  };
}

const STATE_ORDER = { FRESH: 0, ACTIVE: 1, COOLDOWN: 2, AUTH: 3 };

/**
 * Build the stored snapshot from states (with rows), samples (≥ last 24h),
 * closed windows and gaps (≥ last 14 days).
 */
// ---------------------------------------------------------------------------
// Machines: which machines measured which account (quota is account-level, not per machine)
// ---------------------------------------------------------------------------

export const UNKNOWN_MACHINE = "unknown";
export const UNKNOWN_MACHINE_NAME = "unknown machine (old client)";
export const MACHINE_ONLINE_MS = 20 * MINUTE_MS;
export const MACHINE_IDLE_MS = 2 * HOUR_MS;
/** A machine is "high intensity" from this many tokens (input + output + cache creation) in the last hour. */
export const MACHINE_HIGH_TOKENS_1H = 3_000_000;

/** Known friendly machine label mappings requested by user (#hash -> Friendly Name). */
export const KNOWN_MACHINE_MAP = DEFAULT_MACHINE_LABELS;

/**
 * Match a machine object to a known friendly label.
 * Checks machine_id prefix, id_short (#hash or hash), or matching machine_name / label.
 */
export function matchKnownMachine(m, customMap = {}) {
  if (!m) return null;
  const merged = { ...DEFAULT_MACHINE_LABELS, ...(customMap || {}) };
  const mid = String(m.machine_id || "").trim().toLowerCase();
  const ids = String(m.id_short || "").trim().toLowerCase().replace(/^#/, "");
  const mName = String(m.machine_name || m.name || "").trim().toLowerCase();

  for (const [hash, label] of Object.entries(merged)) {
    const h = hash.toLowerCase();
    const l = label.toLowerCase();
    // 1. Direct machine_id prefix (e.g. a1b2c3739c07...)
    if (mid && (mid.startsWith(h) || mid === h)) return label;
    // 2. id_short match (e.g. a1b2c3 or #a1b2c3)
    if (ids && ids === h) return label;
    // 3. Name matches label or contains hash
    if (mName) {
      if (mName === l) return label;
      if (mName.includes("#" + h)) return label;
      const re = new RegExp("(?:^|[^a-z0-9])" + h + "(?:[^a-z0-9]|$)", "i");
      if (re.test(mName)) return label;
    }
  }
  return null;
}

/** Clean machine name: strip .local suffix and trim whitespace. */
export function cleanMachineName(name) {
  if (!name) return "";
  return String(name).trim().replace(/\.local$/i, "").trim();
}

/**
 * Display name of a machine that has no known label: the name the client sent, else a placeholder.
 * Placeholders carry an i18n key (`name_key`/`name_params`); client-sent names are never translated.
 */
function machineDisplayName(knownLabel, clientName, machineId) {
  if (knownLabel) return { name: knownLabel };
  if (machineId === UNKNOWN_MACHINE && (!clientName || clientName === UNKNOWN_MACHINE_NAME)) return txt("name", "srv_machine_unknown");
  if (clientName) return { name: clientName };
  return txt("name", "srv_machine_fallback", { id: String(machineId).slice(0, 6) });
}

/** Normalized identity key for a physical machine across reports and accounts. */
export function machineIdentityKey(m, labels = {}) {
  const known = matchKnownMachine(m, labels);
  if (known) {
    return `mapped:${known.toLowerCase()}`;
  }
  const mid = m && m.machine_id ? String(m.machine_id).trim() : "";
  if (mid && mid !== UNKNOWN_MACHINE) {
    return mid.toLowerCase();
  }
  const cName = cleanMachineName(m && (m.machine_name || m.name));
  if (cName) {
    return `name:${cName.toLowerCase()}`;
  }
  return `unknown:${(m && m.email) || ""}`;
}

/** Extract base account email without pool hash. */
export function accountEmail(k) {
  return String(k || "").split("#")[0].toLowerCase().trim();
}

/** Upsert one machine row for (email, machine_id) from a validated report. Pure; returns the new row. */
export function nextMachineRow(prev, report, now) {
  const id = report.machine_id ? String(report.machine_id).trim() : UNKNOWN_MACHINE;
  const row = prev
    ? { ...prev }
    : {
      email: keyOf(report),
      machine_id: id,
      machine_name: null,
      os: null,
      first_seen_ts: now,
      last_seen_ts: now,
      last_valid_ts: null,
      reports_ok: 0,
      reports_err: 0,
      last_error_kind: null,
      last_error_ts: null,
      client_version: null,
      last_ip: null,
      country: null,
      last_used_percent: null,
      update_status: null,
      update_checked_ts: null,
    };
  row.last_seen_ts = now;
  if (report.machine_name) row.machine_name = cleanMachineName(report.machine_name);
  // also rewrites a placeholder stored by an earlier version (it was a Vietnamese text)
  if (id === UNKNOWN_MACHINE && !report.machine_name) row.machine_name = UNKNOWN_MACHINE_NAME;
  if (report.os) row.os = report.os;
  if (report.client_version) row.client_version = report.client_version;
  if (report.update_status) row.update_status = String(report.update_status).slice(0, 80);
  if (report.update_checked_at) row.update_checked_ts = Math.min(report.update_checked_at, now);
  if (report.ip) row.last_ip = String(report.ip).slice(0, 64);
  if (report.country) row.country = String(report.country).slice(0, 8);
  if (report.telemetry) row.telemetry = report.telemetry;
  const td = report.token_delta;
  // `since` older than what this row already counted means a retry of a delta that was applied: skip it.
  if (td && report.kind !== "auth" && (!row.acct_tokens || td.since >= row.acct_tokens.until)) {
    const a = row.acct_tokens || { input: 0, output: 0, msgs: 0, since: td.since };
    row.acct_tokens = {
      input: a.input + td.input, output: a.output + td.output, msgs: a.msgs + td.msgs,
      since: a.since, until: td.until,
    };
  }
  if (report.kind === "auth") {
    row.reports_err += 1;
    row.last_error_kind = report.error_kind || report.auth_state || "error";
    row.last_error_ts = now;
  } else {
    row.reports_ok += 1;
    row.last_valid_ts = now;
    row.last_used_percent = report.used;
  }
  return row;
}

/** machines (all rows) -> per-email lists shaped for the snapshot, newest report first, capped at 20. */
export function parseClientVersion(v) {
  const parts = String(v || "").split(".");
  if (parts.length === 0 || parts.some((x) => !/^\d+$/.test(x))) return null;
  return parts.map(Number);
}

export function compareClientVersions(a, b) {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] || 0) - (b[i] || 0);
    if (d !== 0) return d;
  }
  return 0;
}

/** Highest client_version reported by a machine that has measured at least once (null when none parses).
 * A machine that never produced a valid number (e.g. a test box with no CLI) must not set the bar for the rest. */
export function latestClientVersion(machines) {
  let best = null;
  for (const m of machines || []) {
    if (!m.last_valid_ts) continue;
    const v = parseClientVersion(m.client_version);
    if (v && (!best || compareClientVersions(v, best.parts) > 0)) best = { parts: v, text: m.client_version };
  }
  return best ? best.text : null;
}

export function machinesForSnapshot(machines, now, labels = {}) {
  const activeBy = {};
  const detachedBy = {};
  const lastSeenBy = {};
  const latestClient = parseClientVersion(latestClientVersion(machines));

  // 1. Find the latest report for each unique physical machine across all accounts
  const latestByMachine = new Map();
  for (const m of machines || []) {
    const key = machineIdentityKey(m, labels);
    const seenTs = Number(m.last_seen_ts || 0);
    const existing = latestByMachine.get(key);
    if (!existing || seenTs > existing.seenTs) {
      latestByMachine.set(key, {
        emailKey: m.email,
        accountEmail: accountEmail(m.email),
        seenTs,
        machine: m,
      });
    }
  }

  // 2. Classify rows into active vs detached for each account
  for (const m of machines || []) {
    const key = machineIdentityKey(m, labels);
    const binding = latestByMachine.get(key) || { emailKey: m.email, accountEmail: accountEmail(m.email), seenTs: m.last_seen_ts };
    const mAcct = accountEmail(m.email);
    const isCurrent = (mAcct === binding.accountEmail);

    const mine = parseClientVersion(m.client_version);
    // a machine with no version at all is an old client; it is outdated once any machine reports a version
    const outdated = latestClient ? !mine || compareClientVersions(mine, latestClient) < 0 : false;
    const lateAfter = outdated ? LATE_OLD_MS : LATE_LATEST_MS;
    let status = "ok";
    if (m.last_error_ts && (!m.last_valid_ts || m.last_error_ts > m.last_valid_ts)) status = "error";
    else if (!m.last_valid_ts || now - m.last_valid_ts > lateAfter) status = "silent";

    const lastSeenTs = Number(m.last_seen_ts || 0);
    const diff = Math.max(0, now - lastSeenTs);
    let connectivity = "offline";
    if (status === "error") connectivity = "error";
    else if (diff <= MACHINE_ONLINE_MS) connectivity = "online";
    else if (diff <= MACHINE_IDLE_MS) connectivity = "idle";
    else connectivity = "offline";

    const knownLabel = matchKnownMachine(m, labels);
    const cName = cleanMachineName(m.machine_name);
    const shown = machineDisplayName(knownLabel, cName, m.machine_id);

    const obj = {
      machine_id: m.machine_id,
      id_short: knownLabel || (m.machine_id === UNKNOWN_MACHINE ? "—" : String(m.machine_id).slice(0, 6)),
      ...shown,
      raw_name: knownLabel ? null : (cName || null),
      known_label: knownLabel || null,
      os: m.os || null,
      first_seen: toIso(m.first_seen_ts),
      last_seen: toIso(m.last_seen_ts),
      last_valid: toIso(m.last_valid_ts),
      reports_ok: m.reports_ok,
      reports_err: m.reports_err,
      last_error_kind: m.last_error_kind || null,
      last_error_at: toIso(m.last_error_ts),
      client_version: m.client_version || null,
      outdated,
      late_after_min: lateAfter / MINUTE_MS,
      update_status: m.update_status || null,
      update_checked_at: toIso(m.update_checked_ts),
      ip: m.last_ip || null,
      country: m.country || null,
      last_used_percent: m.last_used_percent,
      status,
      connectivity,
      last_ping_ago_ms: diff,
      is_current: isCurrent,
      current_email: binding.accountEmail,
    };

    if (isCurrent) {
      (activeBy[m.email] = activeBy[m.email] || []).push(obj);
    } else {
      obj.moved_to = binding.accountEmail;
      obj.moved_at = toIso(binding.seenTs);
      obj.last_seen_here = toIso(m.last_seen_ts);
      (detachedBy[m.email] = detachedBy[m.email] || []).push(obj);
    }
  }

  // 3. Sort active and detached lists (newest first, capped at 20)
  for (const list of Object.values(activeBy)) {
    list.sort((a, b) => Date.parse(b.last_seen) - Date.parse(a.last_seen));
    list.length = Math.min(list.length, 20);
  }
  for (const list of Object.values(detachedBy)) {
    list.sort((a, b) => Date.parse(b.last_seen) - Date.parse(a.last_seen));
    list.length = Math.min(list.length, 20);
  }

  // 4. Last seen machine per email (for history / empty state)
  const allEmails = new Set([...Object.keys(activeBy), ...Object.keys(detachedBy)]);
  for (const email of allEmails) {
    const act = activeBy[email] || [];
    const det = detachedBy[email] || [];
    if (act.length) {
      lastSeenBy[email] = act[0];
    } else if (det.length) {
      lastSeenBy[email] = det[0];
    }
  }

  activeBy.active = activeBy;
  activeBy.detached = detachedBy;
  activeBy.lastSeen = lastSeenBy;
  return activeBy;
}

export function computeMachineStats(machines = [], rows = [], samples = [], now = Date.now(), labels = {}) {
  const groups = new Map();
  for (const m of machines || []) {
    const key = machineIdentityKey(m, labels);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(m);
  }

  const out = [];
  for (const [key, list] of groups.entries()) {
    list.sort((a, b) => Number(b.last_seen_ts || 0) - Number(a.last_seen_ts || 0));
    const latest = list[0];
    const diff = Math.max(0, now - Number(latest.last_seen_ts || 0));
    let status = "ok";
    if (latest.last_error_ts && (!latest.last_valid_ts || latest.last_error_ts > latest.last_valid_ts)) status = "error";
    let connectivity = "offline";
    if (status === "error") connectivity = "error";
    else if (diff <= MACHINE_ONLINE_MS) connectivity = "online";
    else if (diff <= MACHINE_IDLE_MS) connectivity = "idle";
    else connectivity = "offline";

    const knownName = matchKnownMachine(latest, labels);
    const clientName = cleanMachineName(latest.name || latest.machine_name);
    const shownName = !knownName && latest.machine_id === UNKNOWN_MACHINE && clientName === UNKNOWN_MACHINE_NAME
      ? txt("name", "srv_machine_unknown")
      : { name: knownName || clientName || latest.machine_id };

    const touchedMap = new Map();
    const tokensBy = new Map();
    let totalOk = 0;
    let totalErr = 0;
    let latestTelemetry = null;

    for (const m of list) {
      totalOk += Number(m.reports_ok || 0);
      totalErr += Number(m.reports_err || 0);
      if (m.telemetry && !latestTelemetry) latestTelemetry = m.telemetry;
      const rawEmail = accountEmail(m.email);
      if (!rawEmail) continue;
      const prevTouched = touchedMap.get(rawEmail);
      const mSeen = Number(m.last_seen_ts || 0);
      if (!prevTouched || mSeen > prevTouched.last_seen_ts) {
        touchedMap.set(rawEmail, {
          email: rawEmail,
          account_key: m.email,
          last_seen_ts: mSeen,
          last_seen: toIso(mSeen),
          last_used_percent: m.last_used_percent != null ? m.last_used_percent : null,
          reports_ok: Number(m.reports_ok || 0),
        });
      }
      if (m.acct_tokens) {
        const t = m.acct_tokens;
        const cur = tokensBy.get(rawEmail) || { input: 0, output: 0, msgs: 0, since: t.since };
        tokensBy.set(rawEmail, {
          input: cur.input + t.input, output: cur.output + t.output, msgs: cur.msgs + t.msgs,
          since: Math.min(cur.since, t.since),
        });
      }
    }

    const activeAccountEmail = accountEmail(latest.email);
    const activeRow = rows.find((r) => r.account_key === latest.email || r.email === activeAccountEmail) || null;

    const accountsTouched = Array.from(touchedMap.values()).map((item) => ({
      ...item,
      is_active: item.email === activeAccountEmail,
      tokens: tokensBy.get(item.email) || null,
    })).sort((a, b) => b.last_seen_ts - a.last_seen_ts);

    // Intensity is this machine's own work (tokens in the last hour, summed over every account used on it,
    // measured by the client), never the burn rate of the account it happens to hold: several machines can
    // share one account. Clients older than 3.9 do not send it -> "unknown" rather than a guess.
    const burnRate = (activeRow && activeRow.velocity != null) ? activeRow.velocity : (latestTelemetry && latestTelemetry.burn_rate != null ? latestTelemetry.burn_rate : 0);
    const tokens1h = latestTelemetry && Number.isFinite(latestTelemetry.tokens_1h) ? latestTelemetry.tokens_1h : null;
    const msgs1h = latestTelemetry && Number.isFinite(latestTelemetry.msgs_1h) ? latestTelemetry.msgs_1h : null;
    let intensity = "idle";
    let intensityKey = "srv_int_idle";
    if (connectivity === "online") {
      if (tokens1h === null) {
        intensity = "unknown";
        intensityKey = "srv_int_unknown";
      } else if (tokens1h >= MACHINE_HIGH_TOKENS_1H) {
        intensity = "high";
        intensityKey = "srv_int_high";
      } else if (tokens1h > 0) {
        intensity = "moderate";
        intensityKey = "srv_int_running";
      } else {
        intensity = "idle";
        intensityKey = "srv_int_waiting";
      }
    } else if (connectivity === "idle") {
      intensity = "idle";
      intensityKey = "srv_int_rest";
    } else {
      intensity = "offline";
      intensityKey = "srv_int_offline";
    }

    out.push({
      identity_key: key,
      machine_id: latest.machine_id,
      ...shownName,
      os: latest.os || "Unknown",
      connectivity,
      last_seen: toIso(latest.last_seen_ts),
      last_seen_ago_ms: diff,
      reports_ok: totalOk,
      reports_err: totalErr,
      client_version: latest.client_version || null,
      active_email: activeAccountEmail,
      active_used_percent: activeRow ? activeRow.used_percent : latest.last_used_percent,
      burn_rate: burnRate,
      usage_tokens_1h: tokens1h,
      usage_msgs_1h: msgs1h,
      intensity,
      ...txt("intensity_label", intensityKey),
      accounts_touched: accountsTouched,
      telemetry: latestTelemetry,
    });
  }

  out.sort((a, b) => {
    const connOrder = { online: 0, idle: 1, offline: 2, error: 3 };
    const ca = connOrder[a.connectivity] ?? 4;
    const cb = connOrder[b.connectivity] ?? 4;
    if (ca !== cb) return ca - cb;
    return Date.parse(b.last_seen) - Date.parse(a.last_seen);
  });

  return out;
}

/** Public row: `email` is the real email, `account_key` the row identity, plus pool fields (from the state,
 * so rows stored before pools existed get them too, and re-evaluates real-time countdown fields against evaluation time `now`). */
function publicRow(s, poolLabels, now) {
  const pool = s.pool || null;
  const r = { ...s.row, email: s.account_email || s.email, account_key: s.email, pool, pool_label: pool ? poolLabels[pool] || pool : null };

  if (s.monthly_used_percent !== undefined && s.monthly_used_percent !== null) {
    r.monthly_used_percent = s.monthly_used_percent;
    r.monthly_free_now = r1(Math.max(0, 100 - s.monthly_used_percent));
    r.monthly_resets_at = toIso(s.monthly_resets_at);
    r.monthly_quota_limit = s.monthly_quota_limit ?? null;
    r.monthly_quota_used = s.monthly_quota_used ?? null;
  }
  if (s.account_label) {
    r.account_label = s.account_label;
  }

  // Real-time evaluation of weekly reset expiry
  if (now && r.weekly_resets_at) {
    const wTs = tsOf(r.weekly_resets_at);
    if (wTs !== null && now >= wTs) {
      if (now - wTs <= 2 * HOUR_MS + 10 * MINUTE_MS) {
        r.weekly_reset_ready = true;
      }
      r.weekly_resets_at_passed = r.weekly_resets_at;
      r.weekly_capped = false;
      r.five_hour_disabled = false;
      r.weekly_used = 0;
      r.weekly_resets_at = null;
      if (r.state_code === "COOLDOWN") {
        r.state_code = "FRESH";
        r.used_percent = 0;
        r.free_now = 100;
        r.remaining_percent = 100;
        r.resets_at = null;
        r.resets_at_gmt7 = "N/A";
        Object.assign(r, txt("resets_in", "srv_ready"));
        r.remaining_hours = 0;
        r.pacing_status = "safe";
        Object.assign(r, txt("pacing_badge_text", "srv_badge_ready"), txt("prediction_text", "srv_pred_week_refreshed"));
        r.surplus_deficit_text = "+100%";
      }
      if (s.last_valid_at && s.last_valid_at < wTs) {
        r.reset_passed_unverified = true;
      }
    }
  }

  if (now && r.resets_at) {
    const rTs = tsOf(r.resets_at);
    if (rTs !== null) {
      if (rTs > now) {
        r.resets_in = formatDuration(rTs - now);
        r.remaining_hours = r1((rTs - now) / HOUR_MS);
        if (r.state_code === "COOLDOWN") {
          Object.assign(r, txt("prediction_text", "srv_pred_cap", { at: rTs, left: rTs - now }));
        }
      } else {
        Object.assign(r, txt("resets_in", "srv_ready"));
        r.remaining_hours = 0;
        if (r.state_code === "COOLDOWN" && !r.weekly_capped) {
          r.state_code = "FRESH";
          r.used_percent = 0;
          r.free_now = 100;
          r.remaining_percent = 100;
          r.resets_at = null;
          r.resets_at_gmt7 = "N/A";
          r.pacing_status = "safe";
          Object.assign(r, txt("pacing_badge_text", "srv_badge_ready"), txt("prediction_text", "srv_pred_ready_5h"));
          r.surplus_deficit_text = "+100%";
          if (s.last_valid_at && s.last_valid_at < rTs) {
            r.reset_passed_unverified = true;
          }
        }
      }
    }
  }
  return r;
}

/** Team aggregates over one set of rows (all rows, or one pool). */
function aggregate(states, rows, windows, gaps, now) {
  const opportunity = computeOpportunity(rows, states, now);
  const totals = computeTotals(rows, opportunity);
  const hm = computeHeatmap(states, windows, gaps, now);
  return { opportunity, totals, hm };
}

function getVisibleProviders(settings, currentProvider) {
  if (settings && settings.providers) {
    const list = [];
    for (const [id, cfg] of Object.entries(settings.providers)) {
      if (cfg && (cfg.enabled || id === currentProvider) && PROVIDERS[id]) {
        list.push({ id, label: PROVIDERS[id].label });
      }
    }
    return list;
  }
  const defaultIds = ["claude", "agy", "codex"];
  if (currentProvider && !defaultIds.includes(currentProvider) && PROVIDERS[currentProvider]) {
    defaultIds.push(currentProvider);
  }
  return defaultIds.map((id) => ({ id, label: PROVIDERS[id].label }));
}

export function buildSnapshot({ states, samples, windows, weeks = [], gaps, machines = [] }, now, triggerEmail, version, provider = DEFAULT_PROVIDER, settings = null) {
  const pools = (PROVIDERS[provider] || PROVIDERS[DEFAULT_PROVIDER]).pools;
  const poolLabels = Object.fromEntries(pools.map((p) => [p.id, p.label]));
  const settingsObj = settings || buildDefaultSettings();
  const customMachineLabels = settingsObj.machine_labels || {};
  const machinesBy = machinesForSnapshot(machines, now, customMachineLabels);
  const activeBy = machinesBy.active;
  const detachedBy = machinesBy.detached;
  const lastSeenBy = machinesBy.lastSeen;

  const customAccountLabels = settingsObj.account_labels || {};

  const rows = states.filter((s) => s.row).map((s) => {
    const r = publicRow(s, poolLabels, now);
    const activeMachs = activeBy[r.account_key] || [];
    const detachedMachs = detachedBy[r.account_key] || [];
    const lastSeenMach = lastSeenBy[r.account_key] || null;
    const hasCollision = activeMachs.length > 1;
    return {
      ...r,
      machines: activeMachs,
      active_machines: activeMachs,
      detached_machines: detachedMachs,
      last_seen_machine: lastSeenMach,
      collision: hasCollision,
      seat_collision: hasCollision,
    };
  });
  const { opportunity, totals, hm } = aggregate(states, rows, windows, gaps, now);
  const histFrom = now - HISTORY_SPAN_MS;
  const histBy = {};
  for (const p of samples) {
    if (p.ts < histFrom || p.ts > now) continue;
    (histBy[p.email] = histBy[p.email] || []).push(p);
  }
  const accounts = rows
    .map((r) => {
      const accLabel = resolveAccountLabel(r.email, customAccountLabels);
      return {
        ...r,
        account_label: accLabel || r.account_label || null,
        stats_14d: hm.stats[r.account_key] || null,
        history: (histBy[r.account_key] || [])
          .sort((a, b) => a.ts - b.ts)
          .map((p) => ({ timestamp: toIso(p.ts), used_percent: p.used })),
      };
    })
    .sort((a, b) => (STATE_ORDER[a.state_code] - STATE_ORDER[b.state_code])
      || ((b.at_risk_waste || 0) - (a.at_risk_waste || 0))
      || a.account_key.localeCompare(b.account_key));
  // Pooled providers: the same aggregates per pool (pools are shown side by side, never summed).
  const byPool = {};
  for (const p of pools) {
    const ps = states.filter((s) => (s.pool || null) === p.id);
    const pr = rows.filter((r) => r.pool === p.id);
    const a = aggregate(ps, pr, windows, gaps, now);
    byPool[p.id] = {
      total_accounts: pr.length,
      totals: a.totals,
      opportunity: a.opportunity,
      heatmap: a.hm.heatmap,
      golden_hours: a.hm.golden_hours,
      history_14d: a.hm.history,
    };
  }
  const machineStats = computeMachineStats(machines, rows, samples, now, customMachineLabels);

  // Independent 7-day aggregates: every row re-analysed over its weekly window (same model as the 5h rows)
  const weeklyOverlay = {};
  const weeklyRows = rows.map((r) => {
    const o = computeWeeklyRow(r, now);
    weeklyOverlay[keyOf(r)] = o;
    return { ...r, ...o };
  });
  const weeklyAgg = aggregate(states, weeklyRows, windows, gaps, now);
  const weeklyByPool = {};
  for (const p of pools) {
    const ps = states.filter((s) => (s.pool || null) === p.id);
    const pr = weeklyRows.filter((r) => r.pool === p.id);
    const a = aggregate(ps, pr, windows, gaps, now);
    weeklyByPool[p.id] = {
      total_accounts: pr.length,
      totals: a.totals,
      opportunity: a.opportunity,
      heatmap: a.hm.heatmap,
      golden_hours: a.hm.golden_hours,
      history_14d: a.hm.history,
    };
  }

  return {
    version,
    provider,
    providers: getVisibleProviders(settings, provider),
    pools,
    settings: settingsObj,
    computed_at: toIso(now),
    computed_at_gmt7: formatGmt7(now),
    updated_at_gmt7: formatGmt7(now),
    trigger_email: triggerEmail,
    total_accounts: accounts.length,
    total_machines: new Set(machines.map((m) => machineIdentityKey(m, customMachineLabels))).size,
    latest_client_version: latestClientVersion(machines),
    totals,
    opportunity,
    heatmap: hm.heatmap,
    golden_hours: hm.golden_hours,
    history_14d: hm.history,
    // closed weekly quota periods (account_key, start/end, how much of the week was used); builds up from deployment
    history_weekly: {
      weeks: weeks
        .filter((w) => w.end_ts >= now - WEEK_RETENTION_MS && w.end_ts <= now)
        .sort((a, b) => b.end_ts - a.end_ts)
        .map((w) => ({ account_key: w.email, start_at: toIso(w.start_ts), end_at: toIso(w.end_ts), final_used: w.final_used, waste: w.waste })),
    },
    by_pool: byPool,
    accounts,
    machine_stats: machineStats,
    subviews: {
      "5h": { totals, opportunity, by_pool: byPool },
      "7d": { totals: weeklyAgg.totals, opportunity: weeklyAgg.opportunity, by_pool: weeklyByPool, rows: weeklyOverlay },
    },
    totals_7d: weeklyAgg.totals,
    opportunity_7d: weeklyAgg.opportunity,
    by_pool_7d: weeklyByPool,
  };
}

function emptyAggregates() {
  return {
    totals: computeTotals([], { will_exhaust: [] }),
    opportunity: { use_before_reset: [], fresh_now: [], will_exhaust: [], others: [], timeline_12h: { from: null, to: null, lanes: [] } },
    heatmap: { ...txt("unit", "srv_heatmap_unit"), span_days: 14, accounts: [], team: new Array(24).fill(0) },
    golden_hours: [],
    history_14d: { days: [], daily: [], windows: [] },
    history_weekly: { weeks: [] },
  };
}

export function emptySnapshot(provider = DEFAULT_PROVIDER, settings = null) {
  const pools = (PROVIDERS[provider] || PROVIDERS[DEFAULT_PROVIDER]).pools;
  const emptyAgg = emptyAggregates();
  const settingsObj = settings || buildDefaultSettings();
  return {
    version: 0,
    provider,
    providers: getVisibleProviders(settings, provider),
    pools,
    settings: settingsObj,
    computed_at: null,
    computed_at_gmt7: null,
    updated_at_gmt7: null,
    trigger_email: null,
    total_accounts: 0,
    total_machines: 0,
    latest_client_version: null,
    ...emptyAgg,
    by_pool: Object.fromEntries(pools.map((p) => [p.id, { total_accounts: 0, ...emptyAgg }])),
    accounts: [],
    machine_stats: [],
    subviews: {
      "5h": { totals: emptyAgg.totals, opportunity: emptyAgg.opportunity, by_pool: {} },
      "7d": { totals: emptyAgg.totals, opportunity: emptyAgg.opportunity, by_pool: {} },
    },
    totals_7d: emptyAgg.totals,
    opportunity_7d: emptyAgg.opportunity,
    by_pool_7d: {},
  };
}

/**
 * Dedupe closed windows by identity (email + start). A window closed early, reopened and closed again
 * appears twice (stored early row + new row): the later entry wins, as INSERT OR REPLACE does in SQL.
 */
export function dedupeWindows(list) {
  const byKey = new Map();
  for (const w of list) byKey.set(`${w.email}|${w.start_ts}`, w);
  return [...byKey.values()];
}

// ---------------------------------------------------------------------------
// Orchestration: one POST -> writes + new snapshot
// ---------------------------------------------------------------------------

/**
 * store: { states: {email: state}, samples: [...last 24h+], windows: [...14d], gaps: [...14d] }
 * Returns { writes: { states, samples, windows, gaps }, snapshot, state }.
 */
export function processReport(store, report, now, version, settings = null) {
  const writes = { states: [], samples: [], windows: [], weeks: [], gaps: [], machines: [] };
  const key = keyOf(report);
  const prev = store.states[key] || null;
  const machineId = report.machine_id || UNKNOWN_MACHINE;
  const machines = (store.machines || []).slice();
  const mi = machines.findIndex((m) => m.email === key && m.machine_id === machineId);
  const machineRow = nextMachineRow(mi >= 0 ? machines[mi] : null, report, now);
  if (mi >= 0) machines[mi] = machineRow; else machines.push(machineRow);
  writes.machines.push(machineRow);
  const recent = store.samples.filter((p) => p.email === key && Math.abs(now - p.ts) < DEDUPE_MS);
  const ing = ingestReport(prev, report, now, recent);
  writes.windows.push(...ing.windows);
  writes.weeks.push(...ing.weeks);
  writes.gaps.push(...ing.gaps);
  if (ing.sample) writes.samples.push(ing.sample);

  const allSamples = store.samples.concat(writes.samples);
  const reporter = ing.state;
  reporter.row = computeRow(reporter, allSamples.filter((p) => p.email === reporter.email), now);
  writes.states.push(reporter);

  const finalStates = [reporter];
  for (const [email, st] of Object.entries(store.states)) {
    if (email === key) continue;
    const ht = applyHardTransitions(st, now);
    writes.windows.push(...ht.windows);
    writes.weeks.push(...ht.weeks);
    if (ht.changed) writes.states.push(ht.state);
    finalStates.push(ht.state);
  }

  const snapshot = buildSnapshot({
    states: finalStates,
    samples: allSamples,
    windows: dedupeWindows(store.windows.concat(writes.windows)),
    weeks: dedupeWindows((store.weeks || []).concat(writes.weeks)),
    gaps: store.gaps.concat(writes.gaps),
    machines,
  }, now, report.email, version, report.provider || DEFAULT_PROVIDER, settings);
  return { writes, snapshot, state: reporter };
}

/** Rebuild a snapshot without a report (used once after the legacy KV import or settings update). */
export function rebuildSnapshot(store, now, trigger, version, provider = DEFAULT_PROVIDER, settings = null) {
  const writes = { states: [], windows: [], weeks: [] };
  const finalStates = [];
  for (const st of Object.values(store.states)) {
    const ht = applyHardTransitions(st, now);
    writes.windows.push(...ht.windows);
    writes.weeks.push(...ht.weeks);
    if (ht.changed) writes.states.push(ht.state);
    finalStates.push(ht.state);
  }
  const snapshot = buildSnapshot({
    states: finalStates,
    samples: store.samples,
    windows: dedupeWindows(store.windows.concat(writes.windows)),
    weeks: dedupeWindows((store.weeks || []).concat(writes.weeks)),
    gaps: store.gaps,
    machines: store.machines || [],
  }, now, trigger, version, provider, settings);
  return { writes, snapshot };
}

// ---------------------------------------------------------------------------
// Legacy KV import (account:<email> JSON with history[])
// ---------------------------------------------------------------------------

/**
 * Replay legacy KV records through the same state machine.
 * History points without resets_at are skipped: the old worker stored auth
 * alerts as {used_percent: 0, resets_at: null}, indistinguishable from FRESH.
 */
export function importLegacyRecords(records) {
  const states = {};
  const samples = [];
  const windows = [];
  const gaps = [];
  for (const rec of Array.isArray(records) ? records : []) {
    try {
      const one = importLegacyRecord(rec);
      if (!one) continue;
      states[one.state.email] = one.state;
      samples.push(...one.samples);
      windows.push(...one.windows);
      gaps.push(...one.gaps);
    } catch {
      // A malformed legacy record is skipped; it must never break the import of the others.
    }
  }
  return { states, samples, windows, gaps };
}

function importLegacyRecord(rec) {
  if (!rec || typeof rec !== "object" || typeof rec.email !== "string") return null;
  const email = rec.email.trim().toLowerCase();
  if (!EMAIL_RE.test(email) || email === "unknown@user") return null;
  let points = Array.isArray(rec.history)
    ? rec.history.filter((p) => p && typeof p === "object" && !Array.isArray(p))
    : [];
  if (points.length === 0 && rec.updated_at) {
    points = [{ timestamp: rec.updated_at, used_percent: rec.used_percent, resets_at: rec.resets_at }];
  }
  points = points
    .map((p) => ({
      ts: typeof p.timestamp === "string" ? Date.parse(p.timestamp) : NaN,
      used: p.used_percent,
      resets: parseTs(p.resets_at),
    }))
    .filter((p) => Number.isFinite(p.ts) && typeof p.used === "number" && Number.isFinite(p.used)
      && typeof p.resets === "number")
    .sort((a, b) => a.ts - b.ts);
  const windows = [];
  const gaps = [];
  const own = [];
  let st = null;
  for (const p of points) {
    const res = ingestReport(st, { kind: "quota", email, used: r1(clamp(p.used, 0, 100)), resets_at: p.resets, limits: null }, p.ts);
    if (st === null) res.state.first_seen = p.ts;
    st = res.state;
    if (res.sample) own.push(res.sample);
    windows.push(...res.windows);
    gaps.push(...res.gaps);
  }
  const updatedTs = typeof rec.updated_at === "string" ? Date.parse(rec.updated_at) : NaN;
  if (rec.auth_error === true && Number.isFinite(updatedTs)) {
    st = ingestReport(st, { kind: "auth", email, auth_state: "auth_required", error: "Imported from legacy KV" }, updatedTs).state;
  }
  if (!st) return null;
  st.row = computeRow(st, own, st.last_report_at);
  return { state: st, samples: own, windows, gaps };
}

/**
 * Smart Routing: Rank eligible accounts for a provider based on configured priority mode and weights.
 * Default: 7d priority higher than 5h by one tier (0.45 * U7 + 0.35 * U5 + 0.20 * H7_5 * gate).
 * Filters out AUTH, weekly_capped, COOLDOWN, 0% free, and 100% monthly used accounts.
 * Returns { provider, recommended, alternatives, total_eligible }.
 */
export function rankAccountsForRouting(snapshot, options = {}) {
  const provider = options.provider || snapshot?.provider || DEFAULT_PROVIDER;
  const settings = options.settings || snapshot?.settings || buildDefaultSettings();
  const providerCfg = settings.providers?.[provider] || {};
  const priorityMode = options.priority_mode || settings.priority_mode || "7d_first";

  let w7 = typeof providerCfg.weight_7d === "number" ? providerCfg.weight_7d : 0.45;
  let w5 = typeof providerCfg.weight_5h === "number" ? providerCfg.weight_5h : 0.35;
  if (priorityMode === "5h_first") {
    w5 = 0.45;
    w7 = 0.35;
  }
  const wGate = Math.max(0, 1 - (w7 + w5));

  const accounts = (snapshot?.accounts || []).filter((r) => {
    if (r.state_code === "AUTH") return false;
    if (r.weekly_capped) return false;
    if (r.state_code === "COOLDOWN") return false;
    if (r.free_now <= 0) return false;
    if (r.monthly_used_percent !== undefined && r.monthly_used_percent !== null && r.monthly_used_percent >= 100) return false;
    return true;
  });

  const scored = accounts.map((r) => {
    const u7 = typeof r.weekly_used === "number" ? r.weekly_used : 0;
    const u5 = typeof r.used_percent === "number" ? r.used_percent : 0;
    const uMonth = typeof r.monthly_used_percent === "number" ? r.monthly_used_percent : 0;

    const h7_5 = Math.max(0, u7 - u5);
    const gate = r.weekly_resets_at ? 1 : 0;

    let routingScore;
    if (priorityMode === "monthly_first" && providerCfg.has_monthly) {
      routingScore = 0.50 * uMonth + 0.30 * u7 + 0.20 * u5;
    } else {
      routingScore = w7 * u7 + w5 * u5 + wGate * h7_5 * gate;
    }

    return {
      account: r,
      email: r.email,
      account_key: r.account_key || r.email,
      pool: r.pool || null,
      state_code: r.state_code,
      free_now: r.free_now,
      used_percent: r.used_percent,
      weekly_used: r.weekly_used,
      monthly_used_percent: r.monthly_used_percent ?? null,
      routing_score: r1(routingScore),
    };
  });

  scored.sort((a, b) => {
    if (a.routing_score !== b.routing_score) return a.routing_score - b.routing_score;
    if (b.free_now !== a.free_now) return b.free_now - a.free_now;
    if (a.state_code !== b.state_code) return a.state_code === "FRESH" ? -1 : 1;
    return a.account_key.localeCompare(b.account_key);
  });

  const recommended = scored.length > 0 ? scored[0] : null;
  const alternatives = scored.length > 1 ? scored.slice(1) : [];

  return {
    provider,
    recommended,
    alternatives,
    total_eligible: scored.length,
  };
}
