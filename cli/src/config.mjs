import fs from "node:fs";
import os from "node:os";
import path from "node:path";

function readJson(p) {
  try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return {}; }
}
function readText(p) {
  try { return fs.readFileSync(p, "utf8").trim(); } catch { return ""; }
}

/** "https://x.workers.dev/update" or "https://x.workers.dev/" -> "https://x.workers.dev" */
export function baseUrl(u) {
  return String(u || "").trim().replace(/\/+$/, "").replace(/\/(api\/)?(update|report|status)$/, "");
}

/**
 * Where the Worker URL and access key come from, first match wins:
 * flags, TAQ_URL / TAQ_KEY, ~/.config/team-ai-quota/config.json, then what the reporter already has on this machine
 * (CLAUDE_QUOTA_WORKER_URL, ~/.config/ai-quota/config.json worker_url, ~/.claude/claude-quota-secret-key.txt).
 */
export function resolveConfig(flags, env, home = os.homedir()) {
  const own = readJson(configPath(home));
  const rep = readJson(env.AI_QUOTA_CONFIG_PATH || path.join(home, ".config", "ai-quota", "config.json"));
  const url = flags.url || env.TAQ_URL || own.url || env.CLAUDE_QUOTA_WORKER_URL || rep.worker_url || "";
  const key = flags.key || env.TAQ_KEY || own.key || env.CLAUDE_QUOTA_SECRET_KEY
    || readText(env.CLAUDE_QUOTA_SECRET_KEY_FILE || path.join(home, ".claude", "claude-quota-secret-key.txt"));
  return { url: baseUrl(url), key: String(key || "").trim() };
}

/** A dashboard link like https://host/?key=XXXX&provider=claude -> { url, key } (what the browser uses). */
export function parseDashboardLink(link) {
  let u;
  try { u = new URL(String(link).trim()); } catch { return null; }
  const key = u.searchParams.get("key");
  if (!/^https?:$/.test(u.protocol) || !key) return null;
  return { url: baseUrl(u.origin), key };
}

export function configPath(home = os.homedir()) {
  return path.join(home, ".config", "team-ai-quota", "config.json");
}

/** Save url/key to ~/.config/team-ai-quota/config.json (mode 0600), keeping what is not overwritten. */
export function saveConfig(patch, home = os.homedir()) {
  const file = configPath(home);
  const cur = readJson(file);
  if (patch.url) cur.url = baseUrl(patch.url);
  if (patch.key) cur.key = String(patch.key).trim();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(cur, null, 2) + "\n", { mode: 0o600 });
  fs.chmodSync(file, 0o600);
  return file;
}
