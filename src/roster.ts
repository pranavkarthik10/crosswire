import * as fs from "node:fs";
import * as path from "node:path";
import { parse, stringify } from "smol-toml";

export interface PeerEntry {
  name: string; // person name, e.g. "pranav"
  device: string; // device label, e.g. "mbp"
  key: string; // iroh EndpointId base32/hex string (opaque)
}

function assertEntry(entry: PeerEntry): void {
  for (const field of ["name", "device", "key"] as const) {
    if (typeof entry[field] !== "string" || entry[field].length === 0) {
      throw new TypeError(`PeerEntry.${field} must be a non-empty string`);
    }
  }
}

function loadFile(file: string): PeerEntry[] {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return []; // missing / unreadable file → empty roster
  }
  let doc: unknown;
  try {
    doc = parse(text);
  } catch (err) {
    throw new Error(`corrupt roster file at ${file}: ${(err as Error).message}`);
  }
  const peers = (doc as { peer?: unknown }).peer;
  if (!Array.isArray(peers)) return [];
  const out: PeerEntry[] = [];
  for (const p of peers) {
    const { name, device, key } = (p ?? {}) as Record<string, unknown>;
    if (
      typeof name === "string" && name.length > 0 &&
      typeof device === "string" && device.length > 0 &&
      typeof key === "string" && key.length > 0
    ) {
      out.push({ name, device, key });
    }
  }
  return out;
}

function saveFile(file: string, peers: PeerEntry[]): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const doc = {
    peer: peers.map(({ name, device, key }) => ({ name, device, key })),
  };
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, stringify(doc) + "\n");
  fs.renameSync(tmp, file);
}

function upsert(file: string, entry: PeerEntry): void {
  assertEntry(entry);
  const peers = loadFile(file);
  const i = peers.findIndex((p) => p.key === entry.key);
  if (i >= 0) peers[i] = { ...entry };
  else peers.push({ ...entry });
  saveFile(file, peers);
}

function teamRosterPath(repoRoot: string): string {
  return path.join(repoRoot, ".crosswire", "peers.toml");
}

function contactsPath(configDir: string): string {
  return path.join(configDir, "contacts.toml");
}

export function loadTeamRoster(repoRoot: string): PeerEntry[] {
  return loadFile(teamRosterPath(repoRoot));
}

export function addToTeamRoster(repoRoot: string, entry: PeerEntry): void {
  upsert(teamRosterPath(repoRoot), entry);
}

export function loadContacts(configDir: string): PeerEntry[] {
  return loadFile(contactsPath(configDir));
}

export function addContact(configDir: string, entry: PeerEntry): void {
  upsert(contactsPath(configDir), entry);
}

export function visiblePeers(opts: {
  repoRoot?: string | null;
  configDir: string;
  selfKey: string;
}): PeerEntry[] {
  const team = opts.repoRoot ? loadTeamRoster(opts.repoRoot) : [];
  const seen = new Set<string>([opts.selfKey]);
  const out: PeerEntry[] = [];
  for (const p of [...team, ...loadContacts(opts.configDir)]) {
    if (seen.has(p.key)) continue;
    seen.add(p.key);
    out.push(p);
  }
  return out;
}
