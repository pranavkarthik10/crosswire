// The agentchat daemon: one per machine (M1: one per repo checkout).
//
// - binds an iroh endpoint on the persistent identity key
// - keeps a full-mesh of connections to roster peers, sending presence
//   beacons every few seconds and collecting theirs
// - answers remote `status?` requests from real local git state, without
//   any agent involvement
// - serves the local CLI over a Unix control socket (JSON lines)
//
// Senders are authenticated by the connection: remoteId() IS the peer's
// public key, and anything not in the roster is refused before parsing.

import { Endpoint, EndpointAddr, EndpointId, type Connection, setLogLevel, LogLevel } from "@number0/iroh";
import { existsSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { collectGitState } from "./gitstate";
import { configDir, loadIdentity, type Identity } from "./identity";
import { visiblePeers, type PeerEntry } from "./roster";
import { ALPN, MAX_ENVELOPE, decode, encode, type Envelope, type PresenceBeacon, type StatusReply } from "./wire";

const PRESENCE_INTERVAL_MS = 3_000;
const ONLINE_WINDOW_MS = PRESENCE_INTERVAL_MS * 3;
const REQUEST_TIMEOUT_MS = 10_000;

setLogLevel(LogLevel.Off);

interface PeerState {
  entry: PeerEntry;
  conn: Connection | null; // outbound, for beacons + requests
  lastInboundMs: number; // last beacon received from them
  lastBeacon: PresenceBeacon | null;
}

export interface PresenceRow {
  name: string;
  device: string;
  key: string;
  online: boolean;
  lastSeenSec: number | null;
  beacon: PresenceBeacon | null;
}

const timeout = <T>(p: Promise<T>, ms: number, what: string): Promise<T> =>
  Promise.race([p, new Promise<never>((_, rej) => setTimeout(() => rej(new Error(`${what} timed out after ${ms}ms`)), ms))]);

export class Daemon {
  private peers = new Map<string, PeerState>(); // key -> state
  private statusLine: string | null = null;
  private constructor(
    readonly identity: Identity,
    readonly workDir: string,
    readonly cfgDir: string,
    private ep: Endpoint,
    private repoRoot: string | null,
  ) {}

  static async start(opts: { workDir?: string; cfgDir?: string } = {}): Promise<Daemon> {
    const cfgDir = opts.cfgDir ?? configDir();
    const workDir = opts.workDir ?? process.cwd();
    const identity = loadIdentity(cfgDir);
    if (!identity) throw new Error(`no identity in ${cfgDir} — run \`agentchat init\` first`);
    const ep = await Endpoint.bind({ alpns: [ALPN], secretKey: identity.secretKey });
    const repoRoot = (await collectGitState(workDir)).repoRoot;
    const daemon = new Daemon(identity, workDir, cfgDir, ep, repoRoot);
    daemon.acceptLoop();
    daemon.meshTick();
    setInterval(() => daemon.meshTick(), PRESENCE_INTERVAL_MS).unref?.();
    daemon.serveControlSocket();
    return daemon;
  }

  get key(): string {
    return this.identity.publicKey;
  }

  private rosterNow(): PeerEntry[] {
    return visiblePeers({ repoRoot: this.repoRoot, configDir: this.cfgDir, selfKey: this.key });
  }

  // ---- outbound mesh ----

  private async meshTick() {
    const roster = this.rosterNow();
    for (const entry of roster) {
      let st = this.peers.get(entry.key);
      if (!st) this.peers.set(entry.key, (st = { entry, conn: null, lastInboundMs: 0, lastBeacon: null }));
      st.entry = entry;
      this.beaconTo(st).catch(() => {
        st.conn = null; // reconnect next tick
      });
    }
  }

  private async beaconTo(st: PeerState) {
    if (!st.conn || st.conn.closeReason() !== null) {
      st.conn = await timeout(
        this.ep.connect(new EndpointAddr(EndpointId.fromString(st.entry.key)), ALPN),
        REQUEST_TIMEOUT_MS,
        `dial ${st.entry.name}`,
      );
    }
    const git = await collectGitState(this.workDir);
    const beacon: PresenceBeacon = {
      t: "presence",
      name: this.identity.name,
      device: this.identity.device,
      ts: Date.now(),
      branch: git.branch,
      repo: git.repoRoot ? basename(git.repoRoot) : null,
      dirtyCount: git.dirtyFiles.length,
      statusLine: this.statusLine,
    };
    const uni = await st.conn.openUni();
    await uni.writeAll(encode(beacon));
    await uni.finish();
  }

  // ---- inbound ----

  private async acceptLoop() {
    while (true) {
      const incoming = await this.ep.acceptNext();
      if (!incoming) return; // endpoint closed
      this.handleIncoming(incoming).catch(() => {});
    }
  }

  private async handleIncoming(incoming: Awaited<ReturnType<Endpoint["acceptNext"]>> & {}) {
    const conn = await (await incoming.accept()).connect();
    const remoteKey = conn.remoteId().toString();
    const known = this.rosterNow().find((p) => p.key === remoteKey);
    if (!known) {
      conn.close(1n, [...new TextEncoder().encode("not in roster")]);
      return;
    }
    // presence beacons (uni) and requests (bi), concurrently, until close
    const unis = (async () => {
      while (true) {
        const recv = await conn.acceptUni();
        const env = decode(await recv.readToEnd(MAX_ENVELOPE));
        if (env.t === "presence") {
          const st =
            this.peers.get(remoteKey) ??
            this.peers.set(remoteKey, { entry: known, conn: null, lastInboundMs: 0, lastBeacon: null }).get(remoteKey)!;
          st.lastInboundMs = Date.now();
          st.lastBeacon = env;
        }
      }
    })();
    const bis = (async () => {
      while (true) {
        const bi = await conn.acceptBi();
        const env = decode(await bi.recv.readToEnd(MAX_ENVELOPE));
        const reply = await this.handleRequest(env);
        if (reply) await bi.send.writeAll(encode(reply));
        await bi.send.finish();
      }
    })();
    await Promise.allSettled([unis, bis]);
  }

  private async handleRequest(env: Envelope): Promise<Envelope | null> {
    if (env.t === "status?") return this.localStatus();
    return null;
  }

  private async localStatus(): Promise<StatusReply> {
    return {
      t: "status",
      name: this.identity.name,
      device: this.identity.device,
      ts: Date.now(),
      statusLine: this.statusLine,
      git: await collectGitState(this.workDir),
    };
  }

  // ---- queries (used by control socket) ----

  presence(): PresenceRow[] {
    const now = Date.now();
    return this.rosterNow().map((entry) => {
      const st = this.peers.get(entry.key);
      const lastSeen = st?.lastInboundMs || null;
      return {
        name: entry.name,
        device: entry.device,
        key: entry.key,
        online: !!lastSeen && now - lastSeen < ONLINE_WINDOW_MS,
        lastSeenSec: lastSeen ? Math.round((now - lastSeen) / 1000) : null,
        beacon: st?.lastBeacon ?? null,
      };
    });
  }

  async statusOf(peerName: string): Promise<StatusReply> {
    const candidates = this.presence().filter((p) => p.name === peerName || `${p.name}@${p.device}` === peerName);
    if (candidates.length === 0) throw new Error(`unknown peer: ${peerName}`);
    const target = candidates.find((c) => c.online) ?? candidates[0];
    const st = this.peers.get(target.key)!;
    const ask = async () => {
      if (!st.conn || st.conn.closeReason() !== null)
        st.conn = await this.ep.connect(new EndpointAddr(EndpointId.fromString(target.key)), ALPN);
      const bi = await st.conn.openBi();
      await bi.send.writeAll(encode({ t: "status?" }));
      await bi.send.finish();
      const reply = decode(await bi.recv.readToEnd(MAX_ENVELOPE));
      if (reply.t !== "status") throw new Error(`unexpected reply: ${reply.t}`);
      return reply;
    };
    try {
      return await timeout(ask(), REQUEST_TIMEOUT_MS, `status ${peerName}`);
    } catch (err) {
      st.conn = null;
      throw err;
    }
  }

  // ---- control socket (CLI <-> daemon, JSON lines over UDS) ----

  static sockPath(cfgDir: string = configDir()): string {
    return join(cfgDir, "daemon.sock");
  }

  private serveControlSocket() {
    const sock = Daemon.sockPath(this.cfgDir);
    if (existsSync(sock)) unlinkSync(sock); // caller ensured no live daemon
    const daemon = this;
    Bun.listen({
      unix: sock,
      socket: {
        data(socket, chunk) {
          const buf = ((socket.data as string) ?? "") + chunk.toString();
          const nl = buf.indexOf("\n");
          if (nl === -1) {
            socket.data = buf;
            return;
          }
          daemon
            .handleControl(buf.slice(0, nl))
            .then((reply) => {
              socket.write(JSON.stringify(reply) + "\n");
              socket.flush();
              socket.end();
            })
            .catch(() => socket.end());
        },
      },
    });
    writeFileSync(join(this.cfgDir, "daemon.json"), JSON.stringify({ pid: process.pid, key: this.key }) + "\n");
  }

  private async handleControl(line: string): Promise<unknown> {
    try {
      const req = JSON.parse(line);
      switch (req.cmd) {
        case "ping":
          return { ok: true, key: this.key, name: this.identity.name, device: this.identity.device, workDir: this.workDir };
        case "presence":
          return { ok: true, presence: this.presence() };
        case "status":
          if (req.peer) return { ok: true, status: await this.statusOf(req.peer) };
          return { ok: true, status: await this.localStatus() };
        case "set-status": // exercised properly in M2; trivial to carry now
          this.statusLine = typeof req.line === "string" && req.line.length > 0 ? req.line.slice(0, 200) : null;
          return { ok: true };
        default:
          return { ok: false, error: `unknown cmd: ${req.cmd}` };
      }
    } catch (err) {
      return { ok: false, error: String(err instanceof Error ? err.message : err) };
    }
  }
}
