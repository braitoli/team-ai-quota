export class ApiError extends Error {
  constructor(message, status) { super(message); this.status = status; }
}

/** GET <base><path> with the access key; returns parsed JSON. */
export async function get(cfg, route, params = {}) {
  if (!cfg.url) throw new ApiError("no Worker URL: set TAQ_URL, pass --url, or run `taq config --url <url> --key <key>`");
  const qs = new URLSearchParams(Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== ""));
  const url = `${cfg.url}${route}${qs.toString() ? "?" + qs : ""}`;
  let res;
  try {
    res = await fetch(url, { headers: { Accept: "application/json", "x-api-key": cfg.key || "" } });
  } catch (e) {
    throw new ApiError(`cannot reach ${cfg.url} (${e && e.cause && e.cause.code || e.message})`);
  }
  if (res.status === 401 || res.status === 403) throw new ApiError("the Worker rejected the access key (HTTP " + res.status + ")", res.status);
  if (!res.ok) throw new ApiError(`the Worker answered HTTP ${res.status}`, res.status);
  try { return await res.json(); } catch { throw new ApiError("the Worker did not return JSON"); }
}
