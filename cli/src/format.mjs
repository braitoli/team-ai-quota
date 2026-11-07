const pct = (v) => (v === null || v === undefined || !Number.isFinite(+v) ? "-" : `${Math.round(+v)}%`);
const when = (iso) => {
  if (!iso) return "-";
  const d = new Date(iso);
  return Number.isNaN(+d) ? "-" : d.toISOString().slice(5, 16).replace("T", " ") + "Z";
};

/** Plain text table: rows is an array of arrays, head the column titles. */
export function table(head, rows) {
  const all = [head, ...rows].map((r) => r.map((c) => String(c ?? "-")));
  const w = head.map((_, i) => Math.max(...all.map((r) => r[i].length)));
  return all.map((r) => r.map((c, i) => c.padEnd(w[i])).join("  ").trimEnd()).join("\n");
}

export function fmtStatus(snap) {
  const rows = (snap.accounts || []).map((a) => [
    a.email, a.state_code, pct(a.used_percent), pct(a.weekly_used), when(a.resets_at), when(a.weekly_resets_at),
    a.status || "-", a.at_risk_waste > 0.5 ? `~${Math.round(a.at_risk_waste)}% unused at reset` : "",
  ]);
  return rows.length ? table(["ACCOUNT", "STATE", "5H USED", "7D USED", "5H RESET", "7D RESET", "LINK", "NOTE"], rows) : "No accounts reported yet.";
}

export function fmtBest(res) {
  if (!res.recommended) return `No eligible ${res.provider || ""} account right now (all locked, expired or out of quota).`.replace("  ", " ");
  const r = res.recommended;
  const alts = (res.alternatives || []).slice(0, 3).map((a) => `${a.email} (${pct(a.weekly_used)} 7d, ${pct(a.used_percent)} 5h)`);
  return [
    `Use: ${r.email}`,
    `  5h used ${pct(r.used_percent)}, 7d used ${pct(r.weekly_used)}, free now ${pct(r.free_now)}, state ${r.state_code}`,
    alts.length ? `Next: ${alts.join("; ")}` : "No other eligible account.",
  ].join("\n");
}

export function fmtMachines(snap) {
  const rows = (snap.machine_stats || []).map((m) => [
    m.name || m.id_short || m.machine_id, m.os || "-", m.connectivity || m.status || "-", m.active_email || "-",
    pct(m.active_used_percent), when(m.last_seen), m.client_version || "-",
  ]);
  return rows.length ? table(["MACHINE", "OS", "LINK", "ACTIVE ACCOUNT", "USED", "LAST SEEN", "VERSION"], rows) : "No machines reported yet.";
}

/** Closed weekly quota periods per account (accounts with a weekly limit). */
export function fmtWaste(snap) {
  const weeks = (snap.history_weekly && snap.history_weekly.weeks) || [];
  if (!weeks.length) return "No closed week yet. A week closes when an account's weekly limit resets.";
  const by = {};
  for (const w of weeks) (by[w.account_key] = by[w.account_key] || []).push(w);
  const rows = Object.entries(by).map(([k, ws]) => {
    const used = ws.reduce((s, w) => s + w.final_used, 0) / ws.length;
    const last = ws.slice().sort((a, b) => Date.parse(b.end_at) - Date.parse(a.end_at))[0];
    return [k, ws.length, pct(used), pct(100 - used), `${pct(last.final_used)} (ended ${when(last.end_at)})`];
  });
  return table(["ACCOUNT", "WEEKS", "AVG USED", "AVG UNUSED", "LAST WEEK USED"], rows);
}
