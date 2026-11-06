/**
 * Claude Quota Monitor - Cloudflare Worker (router + auth).
 * State lives in one SQLite-backed Durable Object per provider (TeamStore; claude: idFromName("team"),
 * other providers: idFromName(provider)). `?provider=` selects it on GET, the body's `provider` on POST.
 * Numbers are recomputed only when a client POSTs a report; GET endpoints return the stored snapshot.
 */
import { validateReport, isProvider, DEFAULT_PROVIDER, PROVIDERS, rankAccountsForRouting } from "./analytics.js";
import { validateSettingsPatch } from "./config.js";
import { renderDashboardPage, renderRestrictedPage } from "./dashboard.js";

export { TeamStore } from "./team-store.js";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, x-api-key, Authorization, If-None-Match",
  "Access-Control-Expose-Headers": "ETag",
};
const PRIVATE = { "Cache-Control": "private, no-store" };

/** Extract auth key from query param, x-api-key header, or bearer token. */
function getRequestKey(request) {
  const url = new URL(request.url);
  const queryKey = url.searchParams.get("key");
  if (queryKey) return queryKey.trim();
  const headerKey = request.headers.get("x-api-key");
  if (headerKey) return headerKey.trim();
  const authHeader = request.headers.get("authorization");
  if (authHeader && authHeader.toLowerCase().startsWith("bearer ")) {
    return authHeader.substring(7).trim();
  }
  return null;
}

/** Constant-time string comparison (time depends only on the longer length). */
function timingSafeEqual(a, b) {
  const enc = new TextEncoder();
  const x = enc.encode(String(a));
  const y = enc.encode(String(b));
  const len = Math.max(x.length, y.length);
  let diff = x.length ^ y.length;
  for (let i = 0; i < len; i++) {
    diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  }
  return diff === 0;
}

function isAuthorized(request, env) {
  const secret = env.API_SECRET_KEY;
  if (!secret) return true;
  const key = getRequestKey(request);
  if (!key) return false;
  return timingSafeEqual(key, secret);
}

function jsonResponse(data, status = 200, extraHeaders = {}) {
  return new Response(typeof data === "string" ? data : JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      ...CORS_HEADERS,
      ...extraHeaders,
    },
  });
}

function htmlResponse(html, status = 200) {
  return new Response(html, {
    status,
    headers: { "Content-Type": "text/html; charset=utf-8", ...PRIVATE },
  });
}

/** ETag token of a provider snapshot version: claude keeps the bare "<version>", others "<provider>-<version>". */
function etagToken(provider, version) {
  return provider === DEFAULT_PROVIDER ? String(version) : `${provider}-${version}`;
}

/**
 * Parse If-None-Match into the version string of THIS provider ("5", W/"5", "agy-5"; "*" not supported).
 * A token of another provider never matches, so versions of different objects cannot yield a false 304.
 */
function parseIfNoneMatch(header, provider) {
  if (!header) return null;
  const first = header.split(",")[0].trim().replace(/^W\//, "").replace(/^"|"$/g, "");
  const m = first.match(/^(?:([a-z0-9_]+)-)?([0-9]+)$/);
  if (!m) return null;
  const prefix = m[1] || DEFAULT_PROVIDER;
  return prefix === provider ? m[2] : null;
}

/** ?provider= (default claude); null when unknown. */
function queryProvider(url) {
  const p = url.searchParams.get("provider");
  if (p === null || p === "") return DEFAULT_PROVIDER;
  return isProvider(p) ? p : null;
}

function teamStore(env, provider = DEFAULT_PROVIDER) {
  // claude keeps the original object name so no existing data moves.
  const name = provider === DEFAULT_PROVIDER ? "team" : provider;
  return env.TEAM_STORE.get(env.TEAM_STORE.idFromName(name));
}

const badProvider = () => ({ error: `provider must be one of ${Object.keys(PROVIDERS).join(", ")}` });

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    const url = new URL(request.url);
    const path = url.pathname;

    if (path === "/favicon.ico") {
      // Public, no auth: avoids a 401 console error on every dashboard load.
      return new Response(null, { status: 204, headers: { "Cache-Control": "public, max-age=86400" } });
    }

    if (path === "/health") {
      return jsonResponse({ status: "ok", service: "team-ai-quota" });
    }

    if (request.method === "GET" && (path === "/" || path === "/dashboard")) {
      if (!isAuthorized(request, env)) {
        return htmlResponse(renderRestrictedPage(Boolean(getRequestKey(request))));
      }
      const provider = queryProvider(url);
      if (!provider) return htmlResponse("<h1>Provider không hợp lệ</h1>", 400);
      try {
        const snap = await teamStore(env, provider).getSnapshot(null);
        return htmlResponse(renderDashboardPage(snap.body, getRequestKey(request)));
      } catch (err) {
        console.error("dashboard error:", err && err.message);
        return htmlResponse("<h1>Lỗi máy chủ</h1><p>Không đọc được số liệu.</p>", 500);
      }
    }

    if (!isAuthorized(request, env)) {
      return jsonResponse(
        { error: "Unauthorized. Provide valid key in ?key=..., 'x-api-key' header or Bearer token." },
        401,
        PRIVATE
      );
    }

    if (request.method === "POST" && (path === "/update" || path === "/api/update" || path === "/report" || path === "/api/report")) {
      let body;
      try {
        body = await request.json();
      } catch {
        return jsonResponse({ error: "Invalid JSON body" }, 400, PRIVATE);
      }
      const v = validateReport(body);
      if (!v.ok) return jsonResponse({ error: v.error }, 400, PRIVATE);
      // Network origin of the reporting machine (owner's private team); shown only on the key-protected dashboard.
      v.report.ip = request.headers.get("CF-Connecting-IP") || null;
      v.report.country = (request.cf && request.cf.country) || request.headers.get("CF-IPCountry") || null;
      try {
        const res = await teamStore(env, v.report.provider).report(v.report);
        return jsonResponse({
          success: true,
          message: v.report.kind === "auth" ? "Auth/error state recorded" : "Account quota updated successfully",
          version: res.version,
          computed_at: res.computed_at,
          sample_added: res.sample_added,
          provider: v.report.provider,
          record: res.record,
        }, 200, PRIVATE);
      } catch (err) {
        console.error("update error:", err && err.message);
        return jsonResponse({ error: "Server error while saving report" }, 500, PRIVATE);
      }
    }

    if (request.method === "GET" && (path === "/status" || path === "/api/status")) {
      const provider = queryProvider(url);
      if (!provider) return jsonResponse(badProvider(), 400, PRIVATE);
      try {
        const inm = parseIfNoneMatch(request.headers.get("if-none-match"), provider);
        const snap = await teamStore(env, provider).getSnapshot(inm);
        const headers = { ...PRIVATE, ETag: `"${etagToken(provider, snap.version)}"` };
        if (snap.body === null) {
          return new Response(null, { status: 304, headers: { ...CORS_HEADERS, ...headers } });
        }
        return jsonResponse(snap.body, 200, headers);
      } catch (err) {
        console.error("status error:", err && err.message);
        return jsonResponse({ error: "Failed to read snapshot" }, 500, PRIVATE);
      }
    }

    if (request.method === "GET" && (path === "/settings" || path === "/api/settings")) {
      const provider = queryProvider(url) || DEFAULT_PROVIDER;
      try {
        const settings = await teamStore(env, provider).getSettings();
        return jsonResponse({ success: true, settings }, 200, PRIVATE);
      } catch (err) {
        console.error("settings GET error:", err && err.message);
        return jsonResponse({ error: "Failed to read settings" }, 500, PRIVATE);
      }
    }

    if ((request.method === "POST" || request.method === "PUT") && (path === "/settings" || path === "/api/settings")) {
      let body;
      try {
        body = await request.json();
      } catch {
        return jsonResponse({ error: "Invalid JSON body" }, 400, PRIVATE);
      }
      const v = validateSettingsPatch(body);
      if (!v.ok) return jsonResponse({ error: v.error }, 400, PRIVATE);
      const provider = queryProvider(url) || DEFAULT_PROVIDER;
      try {
        const settings = await teamStore(env, provider).updateSettings(v.patch);
        return jsonResponse({ success: true, settings }, 200, PRIVATE);
      } catch (err) {
        console.error("settings POST error:", err && err.message);
        return jsonResponse({ error: "Failed to update settings" }, 500, PRIVATE);
      }
    }

    if (request.method === "POST" && (path === "/labels" || path === "/api/labels")) {
      let body;
      try {
        body = await request.json();
      } catch {
        return jsonResponse({ error: "Invalid JSON body" }, 400, PRIVATE);
      }
      const v = validateSettingsPatch(body);
      if (!v.ok) return jsonResponse({ error: v.error }, 400, PRIVATE);
      const provider = queryProvider(url) || DEFAULT_PROVIDER;
      try {
        const patch = {};
        if (body.machine_labels) patch.machine_labels = body.machine_labels;
        if (body.account_labels) patch.account_labels = body.account_labels;
        const settings = await teamStore(env, provider).updateSettings(patch);
        return jsonResponse({ success: true, settings }, 200, PRIVATE);
      } catch (err) {
        console.error("labels POST error:", err && err.message);
        return jsonResponse({ error: "Failed to update labels" }, 500, PRIVATE);
      }
    }

    if (request.method === "GET" && (path === "/route" || path === "/api/route" || path === "/api/best-account")) {
      const provider = queryProvider(url);
      if (!provider) return jsonResponse(badProvider(), 400, PRIVATE);
      try {
        const snap = await teamStore(env, provider).getSnapshot(null);
        const snapshot = typeof snap.body === "string" ? JSON.parse(snap.body) : snap.body;
        const settings = await teamStore(env, provider).getSettings();
        const priorityMode = url.searchParams.get("priority_mode");
        const res = rankAccountsForRouting(snapshot, { provider, settings, priority_mode: priorityMode });
        return jsonResponse(res, 200, PRIVATE);
      } catch (err) {
        console.error("route GET error:", err && err.message);
        return jsonResponse({ error: "Failed to compute routing recommendation" }, 500, PRIVATE);
      }
    }

    // LOCAL DEV ONLY: seed fake data into the local DO. Disabled unless DEV_SEED=1 (only in .dev.vars).
    if (request.method === "POST" && path === "/__dev/seed" && env.DEV_SEED === "1") {
      const provider = queryProvider(url);
      if (!provider) return jsonResponse(badProvider(), 400, PRIVATE);
      const data = await request.json();
      const res = await teamStore(env, provider).devReplace(data);
      return jsonResponse({ success: true, version: res.version }, 200, PRIVATE);
    }

    return jsonResponse({ error: "Not Found" }, 404, PRIVATE);
  },
};
