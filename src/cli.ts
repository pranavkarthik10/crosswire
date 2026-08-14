#!/usr/bin/env bun
// The `crosswire` CLI.
//
//   crosswire init [--name <n>] [--device <d>]   identity + team roster entry
//   crosswire id                                 print this machine's identity
//   crosswire status [peer]                      presence, or one peer's live status
//   crosswire ask <peer> "<question>"            ask a peer's live agent (blocks for the answer)
//   crosswire send <peer> "<text>"               fire-and-forget message
//   crosswire inbox                              queued incoming messages, newest first
//   crosswire reply <id> "<answer>"              answer a pending ask
//   crosswire set-status "<line>"                authored status line ("" clears)
//   crosswire install [--project]                install the skill into detected harnesses
//   crosswire daemon                             run the daemon in the foreground
//
// Commands talk to the daemon over its control socket and auto-spawn it
// (detached, logging to <cfg>/daemon.log) when it isn't running. When run
// from inside a Claude Code session, the session's messaging inbox is
// registered with the daemon so incoming asks can be injected into it.

import { mkdirSync, openSync } from "node:fs";
import { join } from "node:path";
import { Daemon } from "./daemon";
import { collectGitState } from "./gitstate";
import { configDir, createIdentity, loadIdentity } from "./identity";
import { addToTeamRoster, loadTeamRoster } from "./roster";
import { touchRepo } from "./store";
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

/**
 * Make this context automatically reachable: record the repo we're in (the
 * daemon serves every registered repo), and if we're inside an agent session,
 * register its inbox too (a fallback — sessions are normally discovered from
 * Claude Code's own registry without this).
 */
async function registerContext(): Promise<void> {
  const repoRoot = (await collectGitState(process.cwd())).repoRoot;
  if (repoRoot) touchRepo(cfg, repoRoot);
  const socket = process.env.CLAUDE_CODE_MESSAGING_SOCKET;
  const token = process.env.CLAUDE_CODE_MESSAGING_TOKEN;
  if (!socket || !token) return;
  await controlRequest({ cmd: "register-session", socket, token }, 3_000).catch(() => {});
}

/**
 * How to start the daemon as a child process. In a compiled binary,
 * process.execPath IS crosswire (cli.ts lives in the virtual bunfs and can't
 * be re-invoked by path); from source it's bun + the script.
 */
export function daemonArgv(): string[] {
  const compiled = import.meta.path.startsWith("/$bunfs");
  return compiled ? [process.execPath, "daemon"] : [process.execPath, join(import.meta.dir, "cli.ts"), "daemon"];
}

async function ensureDaemon(): Promise<void> {
  try {
    const pong = await controlRequest({ cmd: "ping" }, 2_000);
    if (pong?.ok) return;
  } catch {
    // not running (or stale socket) — spawn it
  }
  if (!loadIdentity(cfg)) {
    console.error("no identity yet — run `crosswire init` first (in your repo, so teammates can find you)");
    process.exit(1);
  }
  mkdirSync(cfg, { recursive: true });
  const log = openSync(join(cfg, "daemon.log"), "a");
  Bun.spawn(daemonArgv(), {
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
    console.log("no peers — add teammates to .crosswire/peers.toml (or pair a contact)");
    return;
  }
  for (const r of rows) {
    const dot = r.online ? "●" : "○";
    const b = r.beacon;
    const status = b?.statusLine ? ` — "${b.statusLine}"` : "";
    const seen = r.online ? "" : ` (seen ${age(r.lastSeenSec)})`;
    console.log(`${dot} ${r.name}@${r.device}${status}${seen}`);
  }
}

function printStatus(s: StatusReply) {
  console.log(`${s.name}@${s.device}${s.statusLine ? ` — "${s.statusLine}"` : ""}${s.agentActive ? "  [agent active]" : ""}`);
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
      touchRepo(cfg, repoRoot); // the daemon serves every registered repo
      addToTeamRoster(repoRoot, { name: identity.name, device: identity.device, key: identity.publicKey });
      const roster = loadTeamRoster(repoRoot);
      console.log(`team:     added to ${join(repoRoot, ".crosswire/peers.toml")} (${roster.length} member${roster.length === 1 ? "" : "s"})`);
      console.log(`\ncommit .crosswire/peers.toml so teammates can reach you.`);
    } else {
      console.log(`(not in a git repo — no team roster written; run init again inside one, identity is reused)`);
    }
    break;
  }

  case "id": {
    const identity = loadIdentity(cfg);
    if (!identity) {
      console.error("no identity — run `crosswire init`");
      process.exit(1);
    }
    console.log(`${identity.name}@${identity.device}`);
    console.log(identity.publicKey);
    break;
  }

  case "daemon": {
    const daemon = await Daemon.start();
    console.log(`crosswire daemon up: ${daemon.identity.name}@${daemon.identity.device}`);
    console.log(`key: ${daemon.key}`);
    await new Promise(() => {}); // run forever
    break;
  }

  case "ask": {
    const [peer, ...q] = rest;
    const question = q.join(" ").trim();
    if (!peer || !question) {
      console.error('usage: crosswire ask <peer> "<question>"');
      process.exit(1);
    }
    await ensureDaemon();
    await registerContext();
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
      console.error('usage: crosswire send <peer> "<text>"');
      process.exit(1);
    }
    await ensureDaemon();
    await registerContext();
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
    await registerContext();
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
    console.log(`\nanswer an open ask with: crosswire reply <id> "<answer>"`);
    break;
  }

  case "reply": {
    const [id, ...a] = rest;
    const answer = a.join(" ").trim();
    if (!id || !answer) {
      console.error('usage: crosswire reply <id> "<answer>"');
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
    await registerContext();
    const res = await controlRequest({ cmd: "set-status", line: rest.join(" ").trim() });
    console.log(res.ok ? "status set" : `error: ${res.error}`);
    break;
  }

  case "status": {
    await ensureDaemon();
    await registerContext();
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

  case "invite": {
    await ensureDaemon();
    const res = await controlRequest({ cmd: "invite" }, 20_000);
    if (!res.ok) {
      console.error(`error: ${res.error}`);
      process.exit(1);
    }
    console.log(`invite code (10 min, single use) — send it to your contact:\n`);
    console.log(`  crosswire join ${res.code}\n`);
    console.log(`keep this terminal's daemon running until they join.`);
    break;
  }

  case "join": {
    const code = rest[0];
    if (!code) {
      console.error("usage: crosswire join <code>");
      process.exit(1);
    }
    await ensureDaemon();
    const res = await controlRequest({ cmd: "join", code }, 40_000);
    if (!res.ok) {
      console.error(`error: ${res.error}`);
      process.exit(1);
    }
    console.log(`paired with ${res.contact.name}@${res.contact.device} — they're in your contacts now.`);
    break;
  }

  case "peer": {
    const peer = rest[0];
    const inbound = flag(rest, "inbound");
    const wakeFlag = flag(rest, "wake");
    if (!peer || (!inbound && !wakeFlag)) {
      console.error('usage: crosswire peer <name> [--inbound accept|hold|refuse] [--wake on|off]');
      process.exit(1);
    }
    if (inbound && !["accept", "hold", "refuse"].includes(inbound)) {
      console.error("--inbound must be accept, hold or refuse");
      process.exit(1);
    }
    await ensureDaemon();
    const req: Record<string, unknown> = { cmd: "peer-policy", peer };
    if (inbound) req.inbound = inbound;
    if (wakeFlag) req.wake = wakeFlag === "on";
    const res = await controlRequest(req);
    if (!res.ok) {
      console.error(`error: ${res.error}`);
      process.exit(1);
    }
    for (const a of res.applied) console.log(`${a.peer}: inbound=${a.policy.inbound} wake=${a.policy.wake ? "on" : "off"}`);
    break;
  }

  case "service": {
    const { serviceInstall, serviceUninstall } = await import("./service");
    const sub = rest[0];
    if (sub === "install") serviceInstall(daemonArgv(), join(cfg, "daemon.log"));
    else if (sub === "uninstall") serviceUninstall();
    else {
      console.error("usage: crosswire service <install|uninstall>");
      process.exit(1);
    }
    break;
  }

  case undefined: {
    // no subcommand: the live dashboard
    await ensureDaemon();
    await registerContext();
    const { runTui } = await import("./tui");
    await runTui({ sockPath: Daemon.sockPath(cfg) });
    break;
  }

  default:
    console.log('usage: crosswire <init|id|status [peer]|ask|send|inbox|reply|set-status|invite|join|peer|install|service|daemon>  (no args: dashboard)');
    process.exit(1);
}
