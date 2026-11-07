#!/usr/bin/env node
import { main } from "../src/cli.mjs";

main(process.argv.slice(2), process.env).then(
  (code) => process.exit(code),
  (err) => {
    process.stderr.write(`taq: ${err && err.message ? err.message : err}\n`);
    process.exit(1);
  }
);
