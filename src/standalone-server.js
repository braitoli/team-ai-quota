/**
 * Standalone Node.js + SQLite server for team-ai-quota.
 * Runs anywhere (Docker, VPS, homelab, Kubernetes) using native `node:http`
 * and `node:sqlite` (DatabaseSync) with zero external npm dependencies.
 */
import * as moduleApi from "node:module";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";

// Register custom loader hook to resolve "cloudflare:workers" without external flags.
if (typeof moduleApi.registerHooks === "function") {
  moduleApi.registerHooks({
    resolve(specifier, context, nextResolve) {
      if (specifier === "cloudflare:workers") {
        return {
          url: "data:text/javascript," + encodeURIComponent("export class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }"),
          format: "module",
          shortCircuit: true,
        };
      }
      return nextResolve(specifier, context);
    },
  });
} else if (typeof moduleApi.register === "function") {
  moduleApi.register("data:text/javascript," + encodeURIComponent(`
    export async function resolve(specifier, context, nextResolve) {
      if (specifier === "cloudflare:workers") {
        return {
          url: "data:text/javascript," + encodeURIComponent("export class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }"),
          format: "module",
          shortCircuit: true,
        };
      }
      return nextResolve(specifier, context);
    }
  `));
}

// Dynamically import Worker handler and TeamStore after hook registration.
const { default: worker, TeamStore } = await import("./index.js");

/**
 * Creates an SQLite adapter matching Cloudflare DO SQLite interface:
 * `this.sql.exec(query, ...bindings)` returning an iterable with `.toArray()`.
 */
export function createSqlAdapter(db) {
  return {
    exec(query, ...bindings) {
      const trimmed = query.trim();
      const statements = trimmed
        .split(";")
        .map((s) => s.trim())
        .filter(Boolean);

      // Multi-statement DDL/DML without parameters
      if (bindings.length === 0 && statements.length > 1) {
        db.exec(query);
        return {
          toArray: () => [],
          [Symbol.iterator]: function* () {},
        };
      }

      const isSelect = /^\s*(SELECT|PRAGMA|WITH)\b/i.test(trimmed);
      const stmt = db.prepare(query);
      if (isSelect) {
        const rows = stmt.all(...bindings);
        return {
          toArray: () => rows,
          [Symbol.iterator]: () => rows[Symbol.iterator](),
        };
      } else {
        stmt.run(...bindings);
        return {
          toArray: () => [],
          [Symbol.iterator]: function* () {},
        };
      }
    },
  };
}

/**
 * Creates a Durable Object namespace backed by persistent SQLite database files.
 * Stores per-provider database in `${dataDir}/quota-${provider}.sqlite`.
 */
export function createSqliteStoreNamespace(dataDir = "./data", env = {}) {
  const instances = new Map();

  function getStore(name) {
    if (instances.has(name)) {
      return instances.get(name).store;
    }

    let db;
    if (dataDir === ":memory:") {
      db = new DatabaseSync(":memory:");
    } else {
      fs.mkdirSync(dataDir, { recursive: true });
      const dbPath = path.join(dataDir, `quota-${name}.sqlite`);
      db = new DatabaseSync(dbPath);
    }
    db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;");

    let initPromise = null;
    let txDepth = 0;
    const sql = createSqlAdapter(db);

    const storage = {
      sql,
      transactionSync(fn) {
        if (txDepth === 0) {
          db.exec("BEGIN");
        } else {
          db.exec(`SAVEPOINT sp_${txDepth}`);
        }
        txDepth++;
        try {
          const res = fn();
          txDepth--;
          if (txDepth === 0) {
            db.exec("COMMIT");
          } else {
            db.exec(`RELEASE SAVEPOINT sp_${txDepth}`);
          }
          return res;
        } catch (err) {
          txDepth--;
          if (txDepth === 0) {
            db.exec("ROLLBACK");
          } else {
            db.exec(`ROLLBACK TO SAVEPOINT sp_${txDepth}`);
          }
          throw err;
        }
      },
    };

    const ctx = {
      id: { name },
      storage,
      blockConcurrencyWhile(fn) {
        initPromise = Promise.resolve(fn());
        return initPromise;
      },
    };

    const rawStore = new TeamStore(ctx, env);
    const storeProxy = new Proxy(rawStore, {
      get(target, prop, receiver) {
        const val = Reflect.get(target, prop, receiver);
        if (typeof val === "function") {
          return async function (...args) {
            if (initPromise) await initPromise;
            return val.apply(target, args);
          };
        }
        return val;
      },
    });

    instances.set(name, { db, store: storeProxy, rawStore });
    return storeProxy;
  }

  return {
    idFromName(name) {
      return { name };
    },
    get(id) {
      const name = (id && id.name) || "team";
      return getStore(name);
    },
    close() {
      for (const { db } of instances.values()) {
        try {
          db.close();
        } catch {}
      }
      instances.clear();
    },
  };
}

/**
 * Creates the standalone HTTP server instance.
 */
export function createServer(options = {}) {
  const port = options.port ?? (process.env.PORT ? Number(process.env.PORT) : 8787);
  const host = options.host ?? (process.env.HOST || "0.0.0.0");
  const dataDir =
    options.dataDir ??
    (process.env.DATA_DIR ||
      (process.env.DB_PATH
        ? process.env.DB_PATH.endsWith(".sqlite")
          ? path.dirname(process.env.DB_PATH)
          : process.env.DB_PATH
        : "./data"));
  const secretKey =
    options.secretKey ??
    (process.env.QUOTA_AUTH_KEY || process.env.SECRET_KEY || process.env.API_SECRET_KEY || "");
  const machineLabels = options.machineLabels ?? (process.env.MACHINE_LABELS || "");
  const accountLabels = options.accountLabels ?? (process.env.ACCOUNT_LABELS || "");
  const devSeed = options.devSeed ?? (process.env.DEV_SEED || "");
  const enabledProviders = options.enabledProviders ?? (process.env.ENABLED_PROVIDERS || "");

  const env = {
    ...process.env,
    API_SECRET_KEY: secretKey,
    MACHINE_LABELS: machineLabels,
    ACCOUNT_LABELS: accountLabels,
    DEV_SEED: devSeed,
    ENABLED_PROVIDERS: enabledProviders,
  };
  const namespace = createSqliteStoreNamespace(dataDir, env);
  env.TEAM_STORE = namespace;

  const server = http.createServer(async (req, res) => {
    try {
      const protocol = req.socket.encrypted ? "https" : "http";
      const hostHeader = req.headers.host || `127.0.0.1:${port}`;
      const url = new URL(req.url, `${protocol}://${hostHeader}`);

      // Convenient route aliases
      if (url.pathname === "/api/health") {
        url.pathname = "/health";
      } else if (url.pathname === "/api/quota") {
        url.pathname = "/api/status";
      } else if (url.pathname === "/quota") {
        url.pathname = "/status";
      } else if (url.pathname === "/api/report" || url.pathname === "/report") {
        url.pathname = "/api/update";
      }

      const headers = new Headers();
      for (const [key, val] of Object.entries(req.headers)) {
        if (val !== undefined) {
          if (Array.isArray(val)) {
            for (const item of val) headers.append(key, item);
          } else {
            headers.set(key, val);
          }
        }
      }

      // Propagate remote client IP
      const remoteIp = req.socket.remoteAddress;
      if (!headers.has("cf-connecting-ip") && remoteIp) {
        headers.set("cf-connecting-ip", remoteIp.replace(/^::ffff:/, ""));
      }
      if (!headers.has("x-forwarded-for") && remoteIp) {
        headers.set("x-forwarded-for", remoteIp.replace(/^::ffff:/, ""));
      }

      const init = {
        method: req.method,
        headers,
      };

      if (req.method !== "GET" && req.method !== "HEAD") {
        const chunks = [];
        for await (const chunk of req) {
          chunks.push(chunk);
        }
        init.body = Buffer.concat(chunks);
      }

      const webReq = new Request(url.toString(), init);
      const response = await worker.fetch(webReq, env);

      res.statusCode = response.status;
      for (const [k, v] of response.headers.entries()) {
        res.setHeader(k, v);
      }

      if (response.body) {
        const reader = response.body.getReader();
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          res.write(value);
        }
      }
      res.end();
    } catch (err) {
      console.error("[standalone-server] Error handling request:", err);
      if (!res.headersSent) {
        res.statusCode = 500;
        res.setHeader("Content-Type", "application/json; charset=utf-8");
        res.end(JSON.stringify({ error: "Internal Server Error", message: err && err.message }));
      }
    }
  });

  server.on("close", () => {
    namespace.close();
  });

  return {
    server,
    namespace,
    env,
    port,
    host,
    listen(callback) {
      return server.listen(port, host, callback);
    },
    close() {
      return new Promise((resolve, reject) => {
        server.close((err) => {
          if (err) reject(err);
          else resolve();
        });
      });
    },
  };
}

// Self-start when run directly
const isDirectRun =
  Boolean(process.argv[1]) &&
  (import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href ||
    process.argv[1].endsWith("standalone-server.js"));

if (isDirectRun) {
  const app = createServer();
  app.listen(() => {
    console.log(`[team-ai-quota] Standalone SQLite server listening on http://${app.host}:${app.port}`);
    console.log(`[team-ai-quota] Persistent SQLite data directory: ${process.env.DATA_DIR || "./data"}`);
  });

  const onShutdown = () => {
    console.log("[team-ai-quota] Shutting down server...");
    app.close()
      .then(() => process.exit(0))
      .catch(() => process.exit(1));
  };

  process.on("SIGTERM", onShutdown);
  process.on("SIGINT", onShutdown);
}
