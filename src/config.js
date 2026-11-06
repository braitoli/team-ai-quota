/**
 * Multi-Provider Configuration, Machine/Account Labeling & Routing Settings.
 * Central registry for CLI coding agents (claude, codex, agy, gemini, copilot, cursor).
 */

export const CLI_PROVIDERS = {
  claude: { id: "claude", label: "Claude Code", cli: "claude", default_windows: ["7d", "5h"], default_enabled: true },
  codex: { id: "codex", label: "Codex", cli: "codex", default_windows: ["7d", "5h"], default_enabled: true },
  agy: { id: "agy", label: "Antigravity (Agy)", cli: "agy", default_windows: ["7d", "5h"], pooled: true, default_enabled: true },
  gemini: { id: "gemini", label: "Gemini CLI", cli: "gemini", default_windows: ["7d", "5h"], default_enabled: true },
  copilot: { id: "copilot", label: "GitHub Copilot CLI", cli: "gh copilot", default_windows: ["30d", "7d", "5h"], has_monthly: true, default_enabled: true },
  cursor: { id: "cursor", label: "Cursor Agent CLI", cli: "cursor", default_windows: ["30d", "7d", "5h"], has_monthly: true, default_enabled: true },
};

/** No built-in machine names: labels come from the MACHINE_LABELS env var and the Settings API. */
export const DEFAULT_MACHINE_LABELS = {};

/** Parse env variable holding labels as JSON or "key:val,key2:val2" */
export function parseLabelEnv(val) {
  if (!val) return {};
  if (typeof val === "object" && !Array.isArray(val)) return val;
  if (typeof val !== "string") return {};
  const trimmed = val.trim();
  if (!trimmed) return {};
  if (trimmed.startsWith("{")) {
    try {
      const parsed = JSON.parse(trimmed);
      return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }
  const result = {};
  for (const part of trimmed.split(",")) {
    const idx = part.indexOf(":");
    if (idx > 0) {
      const k = part.slice(0, idx).trim();
      const v = part.slice(idx + 1).trim();
      if (k && v) result[k] = v;
    }
  }
  return result;
}

/** Build default system settings with optional environment overrides. */
export function buildDefaultSettings(env = {}) {
  const parsedEnvMachineLabels = parseLabelEnv(env.MACHINE_LABELS);
  const parsedEnvAccountLabels = parseLabelEnv(env.ACCOUNT_LABELS);

  let enabledSet = null;
  if (typeof env.ENABLED_PROVIDERS === "string" && env.ENABLED_PROVIDERS.trim()) {
    enabledSet = new Set(env.ENABLED_PROVIDERS.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean));
  }

  const providers = {
    claude:  { enabled: true,  windows: { "7d": true,  "5h": true,  "30d": false }, weight_7d: 0.45, weight_5h: 0.35 },
    codex:   { enabled: true,  windows: { "7d": true,  "5h": true,  "30d": false }, weight_7d: 0.45, weight_5h: 0.35 },
    agy:     { enabled: true,  windows: { "7d": true,  "5h": true,  "30d": false }, weight_7d: 0.45, weight_5h: 0.35 },
    gemini:  { enabled: false, windows: { "7d": true,  "5h": true,  "30d": false }, weight_7d: 0.45, weight_5h: 0.35 },
    copilot: { enabled: false, windows: { "7d": false, "5h": false, "30d": true  }, weight_7d: 0.45, weight_5h: 0.35, monthly_reset_day: 1 },
    cursor:  { enabled: false, windows: { "7d": false, "5h": false, "30d": true  }, weight_7d: 0.45, weight_5h: 0.35, monthly_reset_day: 1 },
  };

  if (enabledSet) {
    for (const [id, cfg] of Object.entries(providers)) {
      cfg.enabled = enabledSet.has(id);
    }
  }

  return {
    providers,
    machine_labels: { ...DEFAULT_MACHINE_LABELS, ...parsedEnvMachineLabels },
    account_labels: { ...parsedEnvAccountLabels },
    priority_mode: "7d_first", // "7d_first" | "5h_first" | "monthly_first"
  };
}

/** Validate a settings patch JSON. Returns { ok: true, patch } or { ok: false, error }. */
export function validateSettingsPatch(patch) {
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) {
    return { ok: false, error: "Settings patch must be a JSON object" };
  }

  if (patch.priority_mode !== undefined) {
    if (!["7d_first", "5h_first", "monthly_first"].includes(patch.priority_mode)) {
      return { ok: false, error: "priority_mode must be one of '7d_first', '5h_first', 'monthly_first'" };
    }
  }

  if (patch.machine_labels !== undefined) {
    if (typeof patch.machine_labels !== "object" || patch.machine_labels === null || Array.isArray(patch.machine_labels)) {
      return { ok: false, error: "machine_labels must be an object of string key-value pairs" };
    }
    for (const [k, v] of Object.entries(patch.machine_labels)) {
      if (typeof v !== "string") {
        return { ok: false, error: `machine_labels['${k}'] must be a string` };
      }
    }
  }

  if (patch.account_labels !== undefined) {
    if (typeof patch.account_labels !== "object" || patch.account_labels === null || Array.isArray(patch.account_labels)) {
      return { ok: false, error: "account_labels must be an object of string key-value pairs" };
    }
    for (const [k, v] of Object.entries(patch.account_labels)) {
      if (typeof v !== "string") {
        return { ok: false, error: `account_labels['${k}'] must be a string` };
      }
    }
  }

  if (patch.providers !== undefined) {
    if (typeof patch.providers !== "object" || patch.providers === null || Array.isArray(patch.providers)) {
      return { ok: false, error: "providers must be an object" };
    }
    for (const [p, cfg] of Object.entries(patch.providers)) {
      if (typeof cfg !== "object" || cfg === null || Array.isArray(cfg)) {
        return { ok: false, error: `providers['${p}'] must be an object` };
      }
      if (cfg.enabled !== undefined && typeof cfg.enabled !== "boolean") {
        return { ok: false, error: `providers['${p}'].enabled must be a boolean` };
      }
      if (cfg.windows !== undefined && (typeof cfg.windows !== "object" || cfg.windows === null || Array.isArray(cfg.windows))) {
        return { ok: false, error: `providers['${p}'].windows must be an object` };
      }
    }
  }

  return { ok: true, patch };
}

/** Merge settings patch onto base settings non-destructively. */
export function mergeSettings(base, patch) {
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) {
    return JSON.parse(JSON.stringify(base));
  }
  const next = JSON.parse(JSON.stringify(base));

  if (patch.priority_mode && typeof patch.priority_mode === "string") {
    next.priority_mode = patch.priority_mode;
  }

  if (patch.machine_labels && typeof patch.machine_labels === "object") {
    next.machine_labels = { ...next.machine_labels, ...patch.machine_labels };
  }

  if (patch.account_labels && typeof patch.account_labels === "object") {
    next.account_labels = { ...next.account_labels, ...patch.account_labels };
  }

  if (patch.providers && typeof patch.providers === "object") {
    for (const [p, pCfg] of Object.entries(patch.providers)) {
      if (!pCfg || typeof pCfg !== "object") continue;
      if (!next.providers[p]) {
        next.providers[p] = { ...pCfg };
      } else {
        next.providers[p] = {
          ...next.providers[p],
          ...pCfg,
          windows: {
            ...next.providers[p].windows,
            ...(pCfg.windows || {}),
          },
        };
      }
    }
  }

  return next;
}

/** Resolve friendly label for a machine object using custom and default machine labels. */
export function resolveMachineLabel(m, customMachineLabels = {}) {
  if (!m) return null;
  const merged = { ...DEFAULT_MACHINE_LABELS, ...(customMachineLabels || {}) };
  const mid = String(m.machine_id || "").trim().toLowerCase();
  const ids = String(m.id_short || "").trim().toLowerCase().replace(/^#/, "");
  const mName = String(m.machine_name || m.name || "").trim().toLowerCase();

  for (const [hash, label] of Object.entries(merged)) {
    const h = hash.toLowerCase();
    const l = label.toLowerCase();
    if (mid && (mid.startsWith(h) || mid === h)) return label;
    if (ids && ids === h) return label;
    if (mName) {
      if (mName === l || mName.startsWith(l + "-") || mName.startsWith(l + "_")) return label;
      if (mName.includes("#" + h)) return label;
      const re = new RegExp("(?:^|[^a-z0-9])" + h + "(?:[^a-z0-9]|$)", "i");
      if (re.test(mName)) return label;
    }
  }
  return m.friendly_label || (m.machine_name ? String(m.machine_name).trim().replace(/\.local$/i, "").trim() : null) || (m.id_short || null) || (mid || null);
}

/** Resolve friendly label / alias for an account email. */
export function resolveAccountLabel(email, customAccountLabels = {}) {
  if (!email) return null;
  const em = String(email).trim().toLowerCase();
  for (const [key, label] of Object.entries(customAccountLabels || {})) {
    if (key.trim().toLowerCase() === em) return label;
  }
  return null;
}
