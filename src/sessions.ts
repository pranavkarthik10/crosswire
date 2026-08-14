import { readdirSync, readFileSync, existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve, sep } from "node:path";

export interface DiscoveredSession {
  pid: number;
  name: string;
  cwd: string;
  socket: string;
  token: string | null;
  kind: string;
  startedAt: number;
}

const DEFAULT_DIR = join(homedir(), ".claude", "sessions");

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: any) {
    return err?.code === "EPERM";
  }
}

function readToken(dir: string, keyFiles: string[], pid: number, procStart?: string): string | null {
  const mine = keyFiles.filter((f) => f.startsWith(`${pid}.`));
  for (const f of mine) {
    try {
      const key = JSON.parse(readFileSync(join(dir, f), "utf8"));
      if (mine.length > 1 && procStart && key.procStart !== procStart) continue;
      if (typeof key.peerToken === "string") return key.peerToken;
    } catch {}
  }
  return null;
}

/** All live Claude Code sessions from the on-disk registry (default dir ~/.claude/sessions; overridable for tests). */
export function discoverSessions(sessionsDir?: string): DiscoveredSession[] {
  const dir = sessionsDir ?? DEFAULT_DIR;
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  const keyFiles = entries.filter((f) => /^\d+\.[0-9a-f]{64}\.key$/.test(f));
  const sessions: DiscoveredSession[] = [];
  for (const f of entries) {
    if (!/^\d+\.json$/.test(f)) continue;
    try {
      const meta = JSON.parse(readFileSync(join(dir, f), "utf8"));
      const pid = meta.pid;
      if (
        typeof pid !== "number" ||
        typeof meta.cwd !== "string" ||
        typeof meta.messagingSocketPath !== "string"
      ) continue;
      if (!isAlive(pid) || !existsSync(meta.messagingSocketPath)) continue;
      sessions.push({
        pid,
        name: typeof meta.name === "string" ? meta.name : String(pid),
        cwd: meta.cwd,
        socket: meta.messagingSocketPath,
        token: readToken(dir, keyFiles, pid, meta.procStart),
        kind: typeof meta.kind === "string" ? meta.kind : "unknown",
        startedAt: typeof meta.startedAt === "number" ? meta.startedAt : 0,
      });
    } catch {}
  }
  return sessions;
}

function real(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
}

/** Sessions whose cwd is inside repoRoot (or equal), most recently started first. */
export function sessionsForRepo(repoRoot: string, sessionsDir?: string): DiscoveredSession[] {
  const root = real(repoRoot);
  return discoverSessions(sessionsDir)
    .filter((s) => {
      const cwd = real(s.cwd);
      return cwd === root || cwd.startsWith(root.endsWith(sep) ? root : root + sep);
    })
    .sort((a, b) => b.startedAt - a.startedAt);
}
