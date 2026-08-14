#!/usr/bin/env bun
// The `agentchat` CLI.
//
//   agentchat init [--name <n>] [--device <d>]   identity + team roster entry
//   agentchat id                                 print this machine's identity
//   agentchat status [peer]                      presence, or one peer's live status
//   agentchat daemon                             run the daemon in the foreground
//
// `status` talks to the daemon over its control socket and auto-spawns it
// (detached, logging to <cfg>/daemon.log) when it isn't running.

import { openSync } from "node:fs";
import { join } from "node:path";
import { Daemon } from "./daemon";
import { collectGitState } from "./gitstate";
import { configDir, createIdentity, loadIdentity } from "./identity";
import { addToTeamRoster, loadTeamRoster } from "./roster";
import type { PresenceRow } from "./daemon";
import type { StatusReply } from "./wire";

const cfg = configDir();

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(`--${name}`);
  return i !== -1 ? args[i + 1] : undefined;
}

// ---- control socket client ----

function controlRequest(req: object, timeoutMs = 15_000): Promise<any> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("daemon did not respond")), timeoutMs);
    let buf = "";
    Bun.connect({
      unix: Daemon.sockPath(cfg),
      socket: {
        open(socket) {
          socket.write(JSON.stringify(req) + "\n");
          socket.flush();
        },
        data(_socket, chunk) {
          buf += chunk.toString();
          const nl = buf.indexOf("\n");
          if (nl !== -1) {
            clearTimeout(timer);
            try {
              resolve(JSON.parse(buf.slice(0, nl)));
            } catch (err) {
              reject(err as Error);
            }
          }
        },
        error(_socket, err) {
          clearTimeout(timer);
          reject(err);
        },
        connectError(_socket, err) {
          clearTimeout(timer);
          reject(err);
        },
      },
    }).catch((err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

async function ensureDaemon(): Promise<void> {
  try {
    const pong = await controlRequest({ cmd: "ping" }, 2_000);
    if (pong?.ok) return;
  } catch {
    // not running (or stale socket) — spawn it
  }
  const log = openSync(join(cfg, "daemon.log"), "a");
  Bun.spawn([process.execPath, import.meta.dir + "/cli.ts", "daemon"], {
    cwd: process.cwd(),
    stdout: log,
    stderr: log,
    stdin: "ignore",
  }).unref();
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    await Bun.sleep(500);
    try {
      const pong = await controlRequest({ cmd: "ping" }, 2_000);
      if (pong?.ok) return;
    } catch {
      /* keep waiting */
    }
  }
  throw new Error(`daemon failed to start — see ${join(cfg, "daemon.log")}`);
}

// ---- output ----

const age = (sec: number | null) => (sec === null ? "never" : sec < 60 ? `${sec}s ago` : `${Math.round(sec / 60)}m ago`);

function printPresence(rows: PresenceRow[]) {
  if (rows.length === 0) {
    console.log("no peers — add teammates to .agentchat/peers.toml (or pair a contact)");
    return;
  }
  for (const r of rows) {
    const dot = r.online ? "●" : "○";
    const b = r.beacon;
    const where = b?.repo ? ` ${b.repo}${b.branch ? `@${b.branch}` : ""}` : "";
    const dirty = b && b.dirtyCount > 0 ? ` (${b.dirtyCount} dirty)` : "";
    const status = b?.statusLine ? ` — "${b.statusLine}"` : "";
    const seen = r.online ? "" : ` (seen ${age(r.lastSeenSec)})`;
    console.log(`${dot} ${r.name}@${r.device}${where}${dirty}${status}${seen}`);
  }
}

function printStatus(s: StatusReply) {
  console.log(`${s.name}@${s.device}${s.statusLine ? ` — "${s.statusLine}"` : ""}`);
  if (!s.git.repoRoot) {
    console.log("  (not in a git repo)");
    return;
  }
  console.log(`  branch: ${s.git.branch ?? "?"}`);
  if (s.git.dirtyFiles.length) console.log(`  dirty:  ${s.git.dirtyFiles.slice(0, 10).join(", ")}${s.git.dirtyFiles.length > 10 ? ", …" : ""}`);
  for (const c of s.git.recentCommits.slice(0, 3)) console.log(`  ${c.sha} ${c.subject} (${age(c.ageSec)})`);
}

// ---- commands ----

const [cmd, ...rest] = process.argv.slice(2);

switch (cmd) {
  case "init": {
    const identity = createIdentity(cfg, { name: flag(rest, "name"), device: flag(rest, "device") });
    console.log(`identity: ${identity.name}@${identity.device}`);
    console.log(`key:      ${identity.publicKey}`);
    const repoRoot = (await collectGitState(process.cwd())).repoRoot;
    if (repoRoot) {
      addToTeamRoster(repoRoot, { name: identity.name, device: identity.device, key: identity.publicKey });
      const roster = loadTeamRoster(repoRoot);
      console.log(`team:     added to ${join(repoRoot, ".agentchat/peers.toml")} (${roster.length} member${roster.length === 1 ? "" : "s"})`);
      console.log(`\ncommit .agentchat/peers.toml so teammates can reach you.`);
    } else {
      console.log(`(not in a git repo — no team roster written; run init again inside one, identity is reused)`);
    }
    break;
  }

  case "id": {
    const identity = loadIdentity(cfg);
    if (!identity) {
      console.error("no identity — run `agentchat init`");
      process.exit(1);
    }
    console.log(`${identity.name}@${identity.device}`);
    console.log(identity.publicKey);
    break;
  }

  case "daemon": {
    const daemon = await Daemon.start();
    console.log(`agentchat daemon up: ${daemon.identity.name}@${daemon.identity.device} in ${daemon.workDir}`);
    console.log(`key: ${daemon.key}`);
    await new Promise(() => {}); // run forever
    break;
  }

  case "status": {
    await ensureDaemon();
    const peer = rest.find((a) => !a.startsWith("--"));
    if (peer) {
      const res = await controlRequest({ cmd: "status", peer });
      if (!res.ok) {
        console.error(`error: ${res.error}`);
        process.exit(1);
      }
      printStatus(res.status);
    } else {
      const res = await controlRequest({ cmd: "presence" });
      if (!res.ok) {
        console.error(`error: ${res.error}`);
        process.exit(1);
      }
      printPresence(res.presence);
    }
    break;
  }

  default:
    console.log("usage: agentchat <init|id|status [peer]|daemon>");
    process.exit(cmd ? 1 : 0);
}
