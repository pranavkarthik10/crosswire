import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { collectGitState } from "./gitstate";

function git(dir: string, ...args: string[]): string {
  return execFileSync(
    "git",
    ["-c", "user.email=t@t", "-c", "user.name=t", ...args],
    { cwd: dir, encoding: "utf8" },
  );
}

let repo: string;
let plain: string;
let empty: string;

beforeAll(() => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), "gitstate-repo-"));
  plain = fs.mkdtempSync(path.join(os.tmpdir(), "gitstate-plain-"));
  empty = fs.mkdtempSync(path.join(os.tmpdir(), "gitstate-empty-"));

  git(repo, "init", "-b", "main");
  fs.writeFileSync(path.join(repo, "a.txt"), "one\n");
  git(repo, "add", "a.txt");
  git(repo, "commit", "-m", "first commit");
  fs.writeFileSync(path.join(repo, "b.txt"), "two\n");
  git(repo, "add", "b.txt");
  git(repo, "commit", "-m", "second commit");

  // Dirty state: modified tracked, untracked, and a staged rename.
  fs.writeFileSync(path.join(repo, "a.txt"), "one changed\n");
  fs.writeFileSync(path.join(repo, "untracked.txt"), "new\n");
  git(repo, "mv", "b.txt", "b-renamed.txt");

  git(empty, "init", "-b", "main");
});

afterAll(() => {
  for (const d of [repo, plain, empty]) fs.rmSync(d, { recursive: true, force: true });
});

describe("collectGitState", () => {
  test("real repo: branch, dirty files, commits, recent files", async () => {
    const s = await collectGitState(repo);

    expect(s.repoRoot).toBe(fs.realpathSync(repo));
    expect(s.branch).toBe("main");

    // Dirty: modified a.txt, untracked untracked.txt, rename b.txt -> b-renamed.txt
    expect(s.dirtyFiles).toContain("a.txt");
    expect(s.dirtyFiles).toContain("untracked.txt");
    expect(s.dirtyFiles).toContain("b-renamed.txt");
    expect(s.dirtyFiles).toContain("b.txt");

    // Commits: newest first, correct metadata, fresh ageSec.
    expect(s.recentCommits.length).toBe(2);
    expect(s.recentCommits[0]!.subject).toBe("second commit");
    expect(s.recentCommits[1]!.subject).toBe("first commit");
    for (const c of s.recentCommits) {
      expect(c.author).toBe("t");
      expect(c.sha).toMatch(/^[0-9a-f]{7,}$/);
      expect(c.ageSec).toBeGreaterThanOrEqual(0);
      expect(c.ageSec).toBeLessThan(600);
    }

    // Recent files: union of dirty + last-24h commit files, deduped, cap 20.
    for (const f of ["a.txt", "b.txt", "b-renamed.txt", "untracked.txt"]) {
      expect(s.recentFiles).toContain(f);
    }
    expect(new Set(s.recentFiles).size).toBe(s.recentFiles.length);
    expect(s.recentFiles.length).toBeLessThanOrEqual(20);
    // Dirty files come first.
    expect(s.dirtyFiles).toContain(s.recentFiles[0]!);
  });

  test("subdirectory of a repo resolves the same root", async () => {
    const sub = path.join(repo, "sub");
    fs.mkdirSync(sub, { recursive: true });
    const s = await collectGitState(sub);
    expect(s.repoRoot).toBe(fs.realpathSync(repo));
    expect(s.branch).toBe("main");
  });

  test("detached HEAD: branch is a short SHA", async () => {
    const first = git(repo, "rev-list", "--max-parents=0", "HEAD").trim();
    git(repo, "-c", "advice.detachedHead=false", "checkout", first);
    try {
      const s = await collectGitState(repo);
      expect(s.branch).toMatch(/^[0-9a-f]{7,}$/);
      expect(first.startsWith(s.branch!)).toBe(true);
    } finally {
      git(repo, "checkout", "main");
    }
  });

  test("empty repo (no commits): root and branch set, no commits", async () => {
    const s = await collectGitState(empty);
    expect(s.repoRoot).toBe(fs.realpathSync(empty));
    expect(s.branch).toBe("main");
    expect(s.dirtyFiles).toEqual([]);
    expect(s.recentCommits).toEqual([]);
    expect(s.recentFiles).toEqual([]);
  });

  test("non-repo dir returns the null shape", async () => {
    const s = await collectGitState(plain);
    expect(s).toEqual({
      repoRoot: null,
      branch: null,
      dirtyFiles: [],
      recentCommits: [],
      recentFiles: [],
    });
  });

  test("nonexistent dir returns the null shape without throwing", async () => {
    const s = await collectGitState(path.join(plain, "does-not-exist"));
    expect(s.repoRoot).toBeNull();
    expect(s.branch).toBeNull();
  });
});
