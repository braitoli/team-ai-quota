import fs from "node:fs";
import { get, ApiError } from "./api.mjs";
import { resolveConfig, parseDashboardLink, saveConfig, configPath } from "./config.mjs";
import { fmtStatus, fmtBest, fmtMachines, fmtWaste } from "./format.mjs";

const HELP = `taq - Team AI Quota command line

Usage: taq <command> [options]

Commands:
  best        which account to use right now (exit 3 when none is eligible)
  status      every account: state, 5h and 7d usage, resets
  machines    which machine is measuring which account
  waste       weekly quota used and left unused, per account
  health      is the Worker reachable
  login       save the dashboard link (URL + access key) once: taq login "https://host/?key=..."
  config      show the saved Worker URL and key (key is never printed)

Options:
  --provider <id>        claude (default), agy, codex, gemini, copilot, cursor
  --priority-mode <m>    best only: 7d_first (default), 5h_first, monthly_first
  --email                best only: print just the email address
  --json                 print the raw JSON from the Worker
  --url <url>            Worker URL (or TAQ_URL)
  --key <key>            access key (or TAQ_KEY)
  -h, --help, -v, --version

Without --url/--key it also reuses what the reporter already has on this machine
(~/.config/ai-quota/config.json and ~/.claude/claude-quota-secret-key.txt).
`;

export function parseArgs(argv) {
  const flags = {}; const rest = [];
  const withValue = new Set(["provider", "priority-mode", "url", "key"]);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "-h") flags.help = true;
    else if (a === "-v") flags.version = true;
    else if (a.startsWith("--")) {
      const [k, inline] = a.slice(2).split(/=(.*)/s);
      if (withValue.has(k)) {
        const v = inline !== undefined ? inline : argv[++i];
        if (v === undefined || v.startsWith("--")) throw new ApiError(`--${k} needs a value`);
        flags[k] = v;
      } else flags[k] = true;
    } else rest.push(a);
  }
  return { flags, cmd: rest[0], rest: rest.slice(1) };
}

function version() {
  return JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;
}

export async function main(argv, env = process.env, out = process.stdout, err = process.stderr) {
  const print = (s) => out.write(s.endsWith("\n") ? s : s + "\n");
  let parsed;
  try { parsed = parseArgs(argv); } catch (e) { err.write(`taq: ${e.message}\n`); return 2; }
  const { flags, cmd } = parsed;
  if (flags.version) { print(version()); return 0; }
  if (flags.help || !cmd || cmd === "help") { print(HELP); return cmd || flags.help ? 0 : 2; }

  if (cmd === "config") return configCmd(flags, env, print);
  if (cmd === "login") return loginCmd(parsed.rest, flags, print, err);

  const cfg = resolveConfig(flags, env);
  const provider = flags.provider || "claude";
  try {
    if (cmd === "health") {
      const res = await get(cfg, "/health");
      print(flags.json ? JSON.stringify(res, null, 2) : `ok (${cfg.url})`);
      return 0;
    }
    if (cmd === "best") {
      const res = await get(cfg, "/route", { provider, priority_mode: flags["priority-mode"] });
      if (flags.json) print(JSON.stringify(res, null, 2));
      else if (flags.email) { if (res.recommended) print(res.recommended.email); }
      else print(fmtBest(res));
      return res.recommended ? 0 : 3;
    }
    const render = { status: fmtStatus, machines: fmtMachines, waste: fmtWaste }[cmd];
    if (!render) { err.write(`taq: unknown command "${cmd}". Try: taq --help\n`); return 2; }
    const snap = await get(cfg, "/status", { provider });
    print(flags.json ? JSON.stringify(snap, null, 2) : render(snap));
    return 0;
  } catch (e) {
    if (e instanceof ApiError) { err.write(`taq: ${e.message}\n`); return 1; }
    throw e;
  }
}

function configCmd(flags, env, print) {
  if (flags.url || flags.key) { print(`saved to ${saveConfig({ url: flags.url, key: flags.key })}`); return 0; }
  const cfg = resolveConfig({}, env);
  print(`url: ${cfg.url || "(not set)"}\nkey: ${cfg.key ? `set (${cfg.key.length} chars)` : "(not set)"}\nfile: ${configPath()}`);
  return 0;
}

// taq login <dashboard link>  (the same link you open in the browser, with ?key=...)
function loginCmd(rest, flags, print, err) {
  const parsed = rest[0] ? parseDashboardLink(rest[0]) : null;
  const patch = parsed || (flags.url && flags.key ? { url: flags.url, key: flags.key } : null);
  if (!patch) { err.write("taq: usage: taq login <dashboard link with ?key=...>   (or: taq login --url <url> --key <key>)\n"); return 2; }
  print(`saved to ${saveConfig(patch)} (${patch.url})`);
  return 0;
}
