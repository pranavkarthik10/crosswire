// gitstate — collect local git state for daemon-answered `status` queries (M1).
// Shells out to `git` (no deps); never throws — non-repo / no-git → null shape.

import { execFile } from "node:child_process";

export interface GitState {
  repoRoot: string | null;
  branch: string | null;
  dirtyFiles: string[];
  recentCommits: { sha: string; subject: string; author: string; ageSec: number }[];
  recentFiles: string[];
}

const EMPTY: GitState = {
  repoRoot: null,
  branch: null,
  dirtyFiles: [],
  recentCommits: [],
  recentFiles: [],
};

/** Run git with args in dir; resolve stdout, or null on any failure. */
function git(dir: string, args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(
      "git",
      args,
      { cwd: dir, maxBuffer: 16 * 1024 * 1024, encoding: "utf8" },
      (err, stdout) => resolve(err ? null : stdout),
    );
  });
}

/** Parse `git status --porcelain=v1 -z` output. Rename/copy entries carry a
 *  second NUL-separated path (the original name); both are reported dirty. */
function parseStatusZ(out: string): string[] {
  const files: string[] = [];
  const tokens = out.split("\0");
  for (let i = 0; i < tokens.length; i++) {
    const entry = tokens[i];
    if (!entry || entry.length < 4) continue;
    const xy = entry.slice(0, 2);
    files.push(entry.slice(3));
    if (xy[0] === "R" || xy[0] === "C") {
      const orig = tokens[++i];
      if (orig) files.push(orig);
    }
  }
  return [...new Set(files)];
}

export async function collectGitState(dir: string): Promise<GitState> {
  const rootOut = await git(dir, ["rev-parse", "--show-toplevel"]);
  if (rootOut === null) return { ...EMPTY };
  const repoRoot = rootOut.trim() || null;
  if (!repoRoot) return { ...EMPTY };

  const [branchOut, statusOut, logOut, recentOut] = await Promise.all([
    git(dir, ["symbolic-ref", "--short", "-q", "HEAD"]),
    git(dir, ["status", "--porcelain=v1", "-z"]),
    git(dir, ["log", "-5", "--format=%h%x1f%s%x1f%an%x1f%ct%x00"]),
    git(dir, ["log", "--since=24.hours", "--name-only", "--format="]),
  ]);

  // Current branch; detached HEAD falls back to the short SHA.
  let branch = branchOut?.trim() || null;
  if (!branch) {
    const sha = await git(dir, ["rev-parse", "--short", "HEAD"]);
    branch = sha?.trim() || null;
  }

  const dirtyFiles = statusOut ? parseStatusZ(statusOut) : [];

  const now = Math.floor(Date.now() / 1000);
  const recentCommits: GitState["recentCommits"] = [];
  for (const rec of (logOut ?? "").split("\0")) {
    const line = rec.replace(/^\n/, "");
    if (!line) continue;
    const [sha, subject, author, ct] = line.split("\x1f");
    if (!sha || ct === undefined) continue;
    recentCommits.push({
      sha,
      subject: subject ?? "",
      author: author ?? "",
      ageSec: Math.max(0, now - Number(ct)),
    });
  }

  // Recently-touched files: dirty files first, then files from last-24h
  // commits (newest first), deduped, capped at 20.
  const recent = new Set<string>(dirtyFiles);
  for (const line of (recentOut ?? "").split("\n")) {
    const f = line.trim();
    if (f) recent.add(f);
  }
  const recentFiles = [...recent].slice(0, 20);

  return { repoRoot, branch, dirtyFiles, recentCommits, recentFiles };
}
