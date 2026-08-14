#!/usr/bin/env node
// npm launcher for crosswire. The real binary (Bun + app compiled together,
// tmeet/opencode-style) ships in a platform package installed via
// optionalDependencies; this shim just finds and execs it. Plain Node, no Bun
// required on the user's machine.
const { spawnSync } = require("node:child_process");

const pkg = `crosswire-${process.platform}-${process.arch}`;
let bin;
try {
  bin = require.resolve(`${pkg}/bin/crosswire`);
} catch {
  console.error(`crosswire: no prebuilt binary for ${process.platform}-${process.arch}.`);
  console.error(`supported: darwin-arm64, darwin-x64, linux-x64, linux-arm64 (windows: use WSL).`);
  console.error(`fallback: clone github.com/pranavkarthik10/crosswire and run from source with Bun.`);
  process.exit(1);
}

const r = spawnSync(bin, process.argv.slice(2), { stdio: "inherit" });
process.exit(r.status === null ? 1 : r.status);
