import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, appendFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadInbox, appendInbox, updateInbox, loadRepos, touchRepo, type StoredInboxItem } from "./store";

let dir: string;

function item(n: number, over: Partial<StoredInboxItem> = {}): StoredInboxItem {
  return { id: `id-${n}`, kind: "ask", from: "peer", text: `msg ${n}`, ts: 1000 + n, read: false, answered: false, ...over };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "store-test-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("inbox", () => {
  test("loadInbox returns [] for missing dir/file", () => {
    expect(loadInbox(join(dir, "nope"))).toEqual([]);
    expect(loadInbox(dir)).toEqual([]);
  });

  test("append + load round-trip, oldest first", () => {
    const cfg = join(dir, "cfg"); // nonexistent dir — appendInbox must create it
    appendInbox(cfg, item(1));
    appendInbox(cfg, item(2));
    appendInbox(cfg, item(3));
    const got = loadInbox(cfg);
    expect(got).toEqual([item(1), item(2), item(3)]);
  });

  test("cap: append 250, load returns last 200, oldest first", () => {
    for (let i = 0; i < 250; i++) appendInbox(dir, item(i));
    const got = loadInbox(dir);
    expect(got.length).toBe(200);
    expect(got[0].id).toBe("id-50");
    expect(got[199].id).toBe("id-249");
    // custom cap
    expect(loadInbox(dir, 10).map((x) => x.id)).toEqual(
      Array.from({ length: 10 }, (_, i) => `id-${240 + i}`)
    );
  });

  test("updateInbox persists flag changes", () => {
    appendInbox(dir, item(1));
    appendInbox(dir, item(2));
    const items = loadInbox(dir);
    items[0].read = true;
    items[1].answered = true;
    updateInbox(dir, items);
    const got = loadInbox(dir);
    expect(got[0].read).toBe(true);
    expect(got[1].answered).toBe(true);
    expect(got.length).toBe(2);
  });

  test("corrupt jsonl lines are skipped", () => {
    appendInbox(dir, item(1));
    appendFileSync(join(dir, "inbox.jsonl"), "{not json}\n\n42\n");
    appendInbox(dir, item(2));
    const got = loadInbox(dir);
    expect(got.map((x) => x.id)).toEqual(["id-1", "id-2"]);
  });
});

describe("repos", () => {
  test("loadRepos returns [] for missing/corrupt file", () => {
    expect(loadRepos(dir)).toEqual([]);
    appendFileSync(join(dir, "repos.json"), "not json at all");
    expect(loadRepos(dir)).toEqual([]);
  });

  test("touchRepo upserts and orders MRU-first", async () => {
    const repoA = join(dir, "repoA");
    const repoB = join(dir, "repoB");
    mkdirSync(repoA);
    mkdirSync(repoB);
    touchRepo(dir, repoA);
    await Bun.sleep(5);
    touchRepo(dir, repoB);
    let got = loadRepos(dir);
    expect(got.map((r) => r.root)).toEqual([repoB, repoA]);
    // upsert: touching A again moves it to front, no duplicate
    await Bun.sleep(5);
    touchRepo(dir, repoA);
    got = loadRepos(dir);
    expect(got.map((r) => r.root)).toEqual([repoA, repoB]);
    expect(got.length).toBe(2);
  });

  test("repos whose dir no longer exists are pruned", () => {
    const repoA = join(dir, "repoA");
    const gone = join(dir, "gone");
    mkdirSync(repoA);
    mkdirSync(gone);
    touchRepo(dir, repoA);
    touchRepo(dir, gone);
    rmSync(gone, { recursive: true });
    const got = loadRepos(dir);
    expect(got.map((r) => r.root)).toEqual([repoA]);
  });
});
