// Assemble the npm packages from release binaries, tmeet/opencode-style.
//
//   bun scripts/prepare-npm.ts <version> <binaries-dir>
//
// <binaries-dir> holds crosswire-<target>.tar.gz release artifacts (from CI or
// `gh release download`). Emits dist-npm/:
//   crosswire-darwin-arm64/ … four platform packages, each: the binary + manifest
//   crosswire/                the launcher package with optionalDependencies
// Publish order: platform packages first, then the main package.

import { execFileSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const [version, binDir] = process.argv.slice(2);
if (!version || !binDir) {
  console.error("usage: bun scripts/prepare-npm.ts <version> <binaries-dir>");
  process.exit(1);
}

const TARGETS = [
  { target: "darwin-arm64", os: "darwin", cpu: "arm64" },
  { target: "darwin-x64", os: "darwin", cpu: "x64" },
  { target: "linux-x64", os: "linux", cpu: "x64" },
  { target: "linux-arm64", os: "linux", cpu: "arm64" },
];

const root = join(import.meta.dir, "..");
const out = join(root, "dist-npm");
rmSync(out, { recursive: true, force: true });

const optionalDependencies: Record<string, string> = {};

for (const { target, os, cpu } of TARGETS) {
  const tarball = join(binDir, `crosswire-${target}.tar.gz`);
  if (!existsSync(tarball)) {
    console.error(`missing ${tarball}`);
    process.exit(1);
  }
  const name = `crosswire-${target}`;
  const dir = join(out, name);
  mkdirSync(join(dir, "bin"), { recursive: true });
  execFileSync("tar", ["-xzf", tarball, "-C", join(dir, "bin")]); // extracts ./crosswire
  chmodSync(join(dir, "bin", "crosswire"), 0o755);
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify(
      {
        name,
        version,
        description: `crosswire prebuilt binary for ${target}`,
        repository: "github:pranavkarthik10/crosswire",
        license: "MIT",
        os: [os],
        cpu: [cpu],
        files: ["bin/crosswire"],
      },
      null,
      2,
    ) + "\n",
  );
  optionalDependencies[name] = version;
  console.log(`prepared ${name}`);
}

const main = join(out, "crosswire");
mkdirSync(join(main, "bin"), { recursive: true });
cpSync(join(root, "bin", "crosswire.cjs"), join(main, "bin", "crosswire.cjs"));
cpSync(join(root, "README.md"), join(main, "README.md"));
writeFileSync(
  join(main, "package.json"),
  JSON.stringify(
    {
      name: "crosswire",
      version,
      description:
        "Chat and coordination between coding agents — yours and your teammates' — peer-to-peer, dial-by-key, no server. Presence, status, and agent-to-agent questions from any CLI harness.",
      repository: "github:pranavkarthik10/crosswire",
      license: "MIT",
      bin: { crosswire: "bin/crosswire.cjs" },
      files: ["bin/crosswire.cjs", "README.md"],
      optionalDependencies,
      keywords: ["agents", "claude-code", "p2p", "iroh", "coding-agents", "coordination", "cli"],
    },
    null,
    2,
  ) + "\n",
);
console.log(`prepared crosswire (launcher, optionalDependencies on ${Object.keys(optionalDependencies).length} platform packages)`);
console.log(`\npublish with:\n  for p in ${TARGETS.map((t) => `crosswire-${t.target}`).join(" ")} crosswire; do (cd dist-npm/$p && npm publish --access public); done`);
