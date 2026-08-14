import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  addContact,
  addToTeamRoster,
  loadContacts,
  loadTeamRoster,
  visiblePeers,
  type PeerEntry,
} from "./roster";

const p = (name: string, device: string, key: string): PeerEntry => ({ name, device, key });

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "roster-"));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("roster", () => {
  test("loads empty when files are missing", () => {
    expect(loadTeamRoster(dir)).toEqual([]);
    expect(loadContacts(dir)).toEqual([]);
  });

  test("add + reload round-trips (team and contacts)", () => {
    const a = p("pranav", "mbp", "key-a");
    const b = p("john", "thinkpad", "key-b");
    addToTeamRoster(dir, a);
    addToTeamRoster(dir, b);
    expect(loadTeamRoster(dir)).toEqual([a, b]);
    expect(fs.existsSync(path.join(dir, ".agentchat", "peers.toml"))).toBe(true);

    addContact(dir, a);
    expect(loadContacts(dir)).toEqual([a]);
  });

  test("upsert by key replaces existing entry", () => {
    addToTeamRoster(dir, p("pranav", "mbp", "key-a"));
    addToTeamRoster(dir, p("pranav", "studio", "key-a"));
    expect(loadTeamRoster(dir)).toEqual([p("pranav", "studio", "key-a")]);
  });

  test("rejects entries with empty fields", () => {
    expect(() => addToTeamRoster(dir, p("", "mbp", "k"))).toThrow(TypeError);
    expect(() => addContact(dir, p("pranav", "", "k"))).toThrow(TypeError);
    expect(() => addContact(dir, p("pranav", "mbp", ""))).toThrow(TypeError);
  });

  test("visiblePeers merges, dedupes by key, excludes self", () => {
    const repo = path.join(dir, "repo");
    const cfg = path.join(dir, "cfg");
    addToTeamRoster(repo, p("pranav", "mbp", "self-key"));
    addToTeamRoster(repo, p("john", "thinkpad", "key-j"));
    addContact(cfg, p("john", "old-label", "key-j")); // dupe key, team wins
    addContact(cfg, p("maya", "air", "key-m"));

    expect(visiblePeers({ repoRoot: repo, configDir: cfg, selfKey: "self-key" })).toEqual([
      p("john", "thinkpad", "key-j"),
      p("maya", "air", "key-m"),
    ]);

    // no repo → contacts only
    expect(visiblePeers({ repoRoot: null, configDir: cfg, selfKey: "self-key" })).toEqual([
      p("john", "old-label", "key-j"),
      p("maya", "air", "key-m"),
    ]);
  });

  test("corrupt file throws an error mentioning the path", () => {
    const file = path.join(dir, ".agentchat", "peers.toml");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "[[peer]\nname = broken");
    expect(() => loadTeamRoster(dir)).toThrow(file);
  });
});
