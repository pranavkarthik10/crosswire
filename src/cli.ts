#!/usr/bin/env bun
// The `agentchat` CLI.
//
//   agentchat init [--name <n>] [--device <d>]   identity + team roster entry
//   agentchat id                                 print this machine's identity
//   agentchat status [peer]                      presence, or one peer's live status
//   agentchat ask <peer> "<question>"            ask a peer's live agent (blocks for the answer)
//   agentchat send <peer> "<text>"               fire-and-forget message
//   agentchat inbox                              queued incoming messages, newest first
//   agentchat reply <id> "<answer>"              answer a pending ask
//   agentchat set-status "<line>"                authored status line ("" clears)
//   agentchat install [--project]                install the skill into detected harnesses
//   agentchat daemon                             run the daemon in the foreground
//
// Commands talk to the daemon over its control socket and auto-spawn it
// (detached, logging to <cfg>/daemon.log) when it isn't running. When run
// from inside a Claude Code session, the session's messaging inbox is
// registered with the daemon so incoming asks can be injected into it.

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

/** Runs inside an agent session? Register its inbox so asks can reach it. */
async function registerSessionIfAny(): Promise<void> {
  const socket = process.env.CLAUDE_CODE_MESSAGING_SOCKET;
  const token = process.env.CLAUDE_CODE_MESSAGING_TOKEN;
  if (!socket || !token) return;
  await controlRequest({ cmd: "register-session", socket, token }, 3_000).catch(() => {});
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

  case "ask": {
    const [peer, ...q] = rest;
    const question = q.join(" ").trim();
    if (!peer || !question) {
      console.error('usage: agentchat ask <peer> "<question>"');
      process.exit(1);
    }
    await ensureDaemon();
    await registerSessionIfAny();
    console.error(`asking ${peer}'s agent (may take a minute or two)…`);
    const res = await controlRequest({ cmd: "ask", peer, question }, 140_000);
    if (!res.ok) {
      console.error(`error: ${res.error}`);
      process.exit(1);
    }
    console.log(res.answer);
    break;
  }

  case "send": {
    const [peer, ...t] = rest;
    const text = t.join(" ").trim();
    if (!peer || !text) {
      console.error('usage: agentchat send <peer> "<text>"');
      process.exit(1);
    }
    await ensureDaemon();
    await registerSessionIfAny();
    const res = await controlRequest({ cmd: "send", peer, text }, 20_000);
    if (!res.ok) {
      console.error(`error: ${res.error}`);
      process.exit(1);
    }
    console.log(`sent (${res.note})`);
    break;
  }

  case "inbox": {
    await ensureDaemon();
    await registerSessionIfAny();
    const res = await controlRequest({ cmd: "inbox", markRead: true });
    if (!res.ok) {
      console.error(`error: ${res.error}`);
      process.exit(1);
    }
    if (res.inbox.length === 0) {
      console.log("inbox empty");
      break;
    }
    for (const m of res.inbox) {
      const flag = m.kind === "ask" ? (m.answered ? "ask✓" : "ask?") : "msg ";
      const when = age(Math.round((Date.now() - m.ts) / 1000));
      console.log(`${m.read ? " " : "•"} [${flag}] ${m.id} ${m.from} (${when}): ${m.text}`);
    }
    console.log(`\nanswer an open ask with: agentchat reply <id> "<answer>"`);
    break;
  }

  case "reply": {
    const [id, ...a] = rest;
    const answer = a.join(" ").trim();
    if (!id || !answer) {
      console.error('usage: agentchat reply <id> "<answer>"');
      process.exit(1);
    }
    await ensureDaemon();
    const res = await controlRequest({ cmd: "reply", id, answer });
    if (!res.ok) {
      console.error(`error: ${res.error}`);
      process.exit(1);
    }
    console.log("reply delivered");
    break;
  }

  case "set-status": {
    await ensureDaemon();
    await registerSessionIfAny();
    const res = await controlRequest({ cmd: "set-status", line: rest.join(" ").trim() });
    console.log(res.ok ? "status set" : `error: ${res.error}`);
    break;
  }

  case "status": {
    await ensureDaemon();
    await registerSessionIfAny();
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

  case "install": {
    const { installSkill } = await import("./install");
    installSkill({ project: rest.includes("--project") });
    break;
  }

  default:
    console.log('usage: agentchat <init|id|status [peer]|ask|send|inbox|reply|set-status|install|daemon>');
    process.exit(cmd ? 1 : 0);
}
