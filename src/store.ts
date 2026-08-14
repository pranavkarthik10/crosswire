import { existsSync, mkdirSync, readFileSync, appendFileSync, writeFileSync, renameSync } from "node:fs";
import { join } from "node:path";

// Matches InboxItem in src/daemon.ts (do not import from daemon — copy the shape):
export interface StoredInboxItem {
  id: string;
  kind: "ask" | "send";
  from: string;
  text: string;
  ts: number;
  read: boolean;
  answered: boolean;
}

const inboxPath = (cfgDir: string) => join(cfgDir, "inbox.jsonl");
const reposPath = (cfgDir: string) => join(cfgDir, "repos.json");

function ensureDir(cfgDir: string): void {
  try {
    mkdirSync(cfgDir, { recursive: true });
  } catch {}
}

function atomicWrite(path: string, data: string): void {
  const tmp = path + ".tmp";
  writeFileSync(tmp, data);
  renameSync(tmp, path);
}

/** Load last `cap` inbox items, oldest first. Skips corrupt lines; never throws. */
export function loadInbox(cfgDir: string, cap = 200): StoredInboxItem[] {
  let raw: string;
  try {
    raw = readFileSync(inboxPath(cfgDir), "utf8");
  } catch {
    return [];
  }
  const items: StoredInboxItem[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      const obj = JSON.parse(line);
      if (obj && typeof obj === "object" && typeof obj.id === "string") items.push(obj);
    } catch {}
  }
  return items.slice(-cap);
}

/** Append one item as a JSON line; creates dir/file as needed. */
export function appendInbox(cfgDir: string, item: StoredInboxItem): void {
  ensureDir(cfgDir);
  appendFileSync(inboxPath(cfgDir), JSON.stringify(item) + "\n");
}

/** Rewrite the whole inbox file (persists read/answered flags). Atomic-ish. */
export function updateInbox(cfgDir: string, items: StoredInboxItem[]): void {
  ensureDir(cfgDir);
  atomicWrite(inboxPath(cfgDir), items.map((i) => JSON.stringify(i)).join("\n") + (items.length ? "\n" : ""));
}

/** Load known repos, most-recently-used first; drops repos whose dir no longer exists. */
export function loadRepos(cfgDir: string): { root: string; lastUsed: number }[] {
  let map: Record<string, number>;
  try {
    map = JSON.parse(readFileSync(reposPath(cfgDir), "utf8"));
    if (!map || typeof map !== "object" || Array.isArray(map)) return [];
  } catch {
    return [];
  }
  return Object.entries(map)
    .filter(([root, ms]) => typeof ms === "number" && existsSync(root))
    .map(([root, lastUsed]) => ({ root, lastUsed: lastUsed as number }))
    .sort((a, b) => b.lastUsed - a.lastUsed);
}

/** Upsert a repo with lastUsed=now. Atomic-ish write. */
export function touchRepo(cfgDir: string, repoRoot: string): void {
  ensureDir(cfgDir);
  const map: Record<string, number> = {};
  for (const { root, lastUsed } of loadRepos(cfgDir)) map[root] = lastUsed;
  map[repoRoot] = Date.now();
  atomicWrite(reposPath(cfgDir), JSON.stringify(map));
}
