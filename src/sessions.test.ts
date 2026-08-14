import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverSessions, sessionsForRepo } from "./sessions";

const HASH = "a".repeat(64);
let dir: string;      // fake sessions registry
let repoA: string;    // cwd for the live session
let repoBC: string;   // "/…/b" sibling trap "…/bc"

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "cw-sessions-"));
  repoA = join(dir, "repos", "b");
  repoBC = join(dir, "repos", "bc");
  mkdirSync(repoA, { recursive: true });
  mkdirSync(repoBC, { recursive: true });

  const sock = join(dir, "live.sock");
  writeFileSync(sock, ""); // dummy socket-path file

  // (a) live session: our own pid, existing socket
  writeFileSync(
    join(dir, `${process.pid}.json`),
    JSON.stringify({
      pid: process.pid,
      cwd: repoA,
      startedAt: 2000,
      procStart: "Fri Aug 14 03:57:05 2026",
      kind: "interactive",
      messagingSocketPath: sock,
      name: "agent-chat-9f",
    }),
  );
  writeFileSync(
    join(dir, `${process.pid}.${HASH}.key`),
    JSON.stringify({ peerToken: "deadbeef".repeat(4), procStart: "Fri Aug 14 03:57:05 2026" }),
  );

  // (b) dead pid
  writeFileSync(
    join(dir, "999999.json"),
    JSON.stringify({
      pid: 999999,
      cwd: repoA,
      startedAt: 3000,
      kind: "interactive",
      messagingSocketPath: sock,
      name: "dead",
    }),
  );

  // (c) corrupt json
  writeFileSync(join(dir, "12345.json"), "{not valid json!!");

  // (d) live pid, different cwd — the "/a/bc" containment trap
  const sock2 = join(dir, "live2.sock");
  writeFileSync(sock2, "");
  writeFileSync(
    join(dir, `${process.pid + 100000}.json`), // likely dead; use own pid via second file instead
    JSON.stringify({ pid: 999998, cwd: repoBC, startedAt: 1000 }),
  );
  // Use our own pid again in a second registry entry name so it counts as alive.
  writeFileSync(
    join(dir, "1.json"), // pid 1 (launchd) is alive but EPERM -> treated alive
    JSON.stringify({
      pid: 1,
      cwd: repoBC,
      startedAt: 1000,
      kind: "print",
      messagingSocketPath: sock2,
      name: "other-repo",
    }),
  );
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("discoverSessions", () => {
  test("includes live sessions, skips dead pids and corrupt files", () => {
    const found = discoverSessions(dir);
    const pids = found.map((s) => s.pid).sort((x, y) => x - y);
    expect(pids).toEqual([1, process.pid]);
    expect(found.some((s) => s.name === "dead")).toBe(false);
  });

  test("extracts peerToken from matching .key file", () => {
    const me = discoverSessions(dir).find((s) => s.pid === process.pid)!;
    expect(me.token).toBe("deadbeef".repeat(4));
    expect(me.name).toBe("agent-chat-9f");
    expect(me.kind).toBe("interactive");
    expect(me.startedAt).toBe(2000);
  });

  test("token is null when no .key file exists", () => {
    const other = discoverSessions(dir).find((s) => s.pid === 1)!;
    expect(other.token).toBeNull();
  });

  test("returns [] for a missing directory", () => {
    expect(discoverSessions(join(dir, "nope"))).toEqual([]);
  });
});

describe("sessionsForRepo", () => {
  test("matches exact cwd and containment", () => {
    const found = sessionsForRepo(repoA, dir);
    expect(found.map((s) => s.pid)).toEqual([process.pid]);
  });

  test("parent dir contains both repos, sorted most recent first", () => {
    const found = sessionsForRepo(join(dir, "repos"), dir);
    expect(found.map((s) => s.pid)).toEqual([process.pid, 1]); // startedAt 2000 > 1000
  });

  test('"/a/bc" is not inside "/a/b"', () => {
    // repoBC ("…/repos/bc") session must NOT match repoA ("…/repos/b")
    const found = sessionsForRepo(repoA, dir);
    expect(found.some((s) => s.cwd === repoBC)).toBe(false);
  });
});
