// Session-history reader: what have agents worked on in this repo, per
// harness, extracted deterministically from the transcript files every
// harness already writes. No agent involved, no tokens spent.
//
// Used two ways: locally (`crosswire recap` — your Claude reads what your
// Codex did, and vice versa) and remotely (a peer's ask with no live session
// is answered from this instead of waking an agent; the asker's agent
// interprets the facts).
//
// Extraction is deliberately conservative — user prompts, timestamps, edited
// file paths — and per-harness failures degrade to "no data", never errors.

import { existsSync, readdirSync, readFileSync, statSync, openSync, readSync, closeSync } from "node:fs";
import { homedir } from "node:os";
import { join, relative, sep } from "node:path";

export interface SessionRecap {
  harness: "claude" | "codex";
  lastActiveAt: number; // ms epoch (file mtime)
  live: boolean; // still being written to recently (< 5 min)
  prompts: string[]; // recent user prompts, oldest first, truncated
  filesTouched: string[]; // repo-relative where possible, deduped
}

const PROMPT_CAP = 5;
const PROMPT_LEN = 200;
const SESSIONS_PER_HARNESS = 3;
const LIVE_WINDOW_MS = 5 * 60_000;
const CODEX_LOOKBACK_MS = 14 * 24 * 3_600_000;

const clean = (s: string) => s.replace(/\s+/g, " ").trim().slice(0, PROMPT_LEN);
/** Injected/meta content (reminders, command wrappers) starts with a tag. */
const isHumanText = (s: string) => s.trim().length > 0 && !s.trim().startsWith("<") && !s.startsWith("[Request interrupted");

// ---- Claude Code: ~/.claude/projects/<slug>/<sessionId>.jsonl ----

/** Claude's project slug: every non-alphanumeric path char becomes "-". */
export function claudeSlug(repoRoot: string): string {
  return repoRoot.replace(/[^a-zA-Z0-9]/g, "-");
}

function readClaudeSessions(repoRoot: string, projectsDir: string): SessionRecap[] {
  const dir = join(projectsDir, claudeSlug(repoRoot));
  if (!existsSync(dir)) return [];
  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".jsonl"))
    .map((f) => ({ path: join(dir, f), mtime: statSync(join(dir, f)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime)
    .slice(0, SESSIONS_PER_HARNESS);
  const out: SessionRecap[] = [];
  for (const { path, mtime } of files) {
    try {
      const prompts: string[] = [];
      const filesTouched = new Set<string>();
      for (const line of readFileSync(path, "utf8").split("\n")) {
        if (!line) continue;
        let rec: any;
        try {
          rec = JSON.parse(line);
        } catch {
          continue;
        }
        if (rec.type === "user" && rec.message?.role === "user") {
          const c = rec.message.content;
          const text = typeof c === "string" ? c : Array.isArray(c) ? c.filter((b: any) => b?.type === "text").map((b: any) => b.text).join(" ") : "";
          if (isHumanText(text)) prompts.push(clean(text));
        } else if (rec.type === "assistant" && Array.isArray(rec.message?.content)) {
          for (const b of rec.message.content)
            if (b?.type === "tool_use" && typeof b.input?.file_path === "string") filesTouched.add(b.input.file_path);
        }
      }
      if (prompts.length === 0 && filesTouched.size === 0) continue;
      out.push({
        harness: "claude",
        lastActiveAt: mtime,
        live: Date.now() - mtime < LIVE_WINDOW_MS,
        prompts: prompts.slice(-PROMPT_CAP),
        filesTouched: [...filesTouched].map((f) => relativize(f, repoRoot)).slice(0, 20),
      });
    } catch {
      /* skip unreadable session */
    }
  }
  return out;
}

// ---- Codex: ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl ----

function walkJsonl(dir: string, since: number, acc: string[] = []): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return acc;
  }
  for (const e of entries) {
    const p = join(dir, e);
    try {
      const st = statSync(p);
      if (st.isDirectory()) walkJsonl(p, since, acc);
      else if (e.endsWith(".jsonl") && st.mtimeMs >= since) acc.push(p);
    } catch {
      /* skip */
    }
  }
  return acc;
}

/** cwd from the session_meta line, reading only the head of the file. */
function codexCwd(path: string): string | null {
  try {
    const fd = openSync(path, "r");
    const buf = Buffer.alloc(8192);
    const n = readSync(fd, buf, 0, buf.length, 0);
    closeSync(fd);
    const firstLine = buf.subarray(0, n).toString("utf8").split("\n")[0];
    const rec = JSON.parse(firstLine);
    return rec?.payload?.cwd ?? null;
  } catch {
    return null;
  }
}

function readCodexSessions(repoRoot: string, sessionsDir: string): SessionRecap[] {
  if (!existsSync(sessionsDir)) return [];
  const candidates = walkJsonl(sessionsDir, Date.now() - CODEX_LOOKBACK_MS)
    .map((path) => ({ path, mtime: statSync(path).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
  const out: SessionRecap[] = [];
  for (const { path, mtime } of candidates) {
    if (out.length >= SESSIONS_PER_HARNESS) break;
    const cwd = codexCwd(path);
    if (!cwd || !(cwd === repoRoot || cwd.startsWith(repoRoot + sep))) continue;
    try {
      const prompts: string[] = [];
      for (const line of readFileSync(path, "utf8").split("\n")) {
        if (!line.includes('"role":"user"')) continue;
        let rec: any;
        try {
          rec = JSON.parse(line);
        } catch {
          continue;
        }
        const payload = rec?.payload;
        if (rec.type === "response_item" && payload?.type === "message" && payload.role === "user") {
          const text = (payload.content ?? [])
            .filter((b: any) => b?.type === "input_text")
            .map((b: any) => b.text)
            .join(" ");
          if (isHumanText(text)) prompts.push(clean(text));
        }
      }
      if (prompts.length === 0) continue;
      out.push({
        harness: "codex",
        lastActiveAt: mtime,
        live: Date.now() - mtime < LIVE_WINDOW_MS,
        prompts: prompts.slice(-PROMPT_CAP),
        filesTouched: [],
      });
    } catch {
      /* skip */
    }
  }
  return out;
}

function relativize(file: string, repoRoot: string): string {
  if (file.startsWith(repoRoot + sep)) return relative(repoRoot, file);
  return file;
}

// ---- entry point ----

export function collectRecap(
  repoRoot: string,
  opts: { claudeProjectsDir?: string; codexSessionsDir?: string } = {},
): SessionRecap[] {
  const claudeDir = opts.claudeProjectsDir ?? process.env.CROSSWIRE_CLAUDE_PROJECTS_DIR ?? join(homedir(), ".claude", "projects");
  const codexDir = opts.codexSessionsDir ?? process.env.CROSSWIRE_CODEX_SESSIONS_DIR ?? join(homedir(), ".codex", "sessions");
  return [...readClaudeSessions(repoRoot, claudeDir), ...readCodexSessions(repoRoot, codexDir)].sort(
    (a, b) => b.lastActiveAt - a.lastActiveAt,
  );
}

/** Plain-text digest, e.g. for answering a peer's ask without waking anyone. */
export function formatRecap(recaps: SessionRecap[]): string {
  if (recaps.length === 0) return "";
  const age = (ms: number) => {
    const m = Math.round((Date.now() - ms) / 60_000);
    return m < 1 ? "just now" : m < 60 ? `${m}m ago` : m < 60 * 24 ? `${Math.round(m / 60)}h ago` : `${Math.round(m / 1440)}d ago`;
  };
  return recaps
    .map((r) => {
      const lines = [`${r.harness} session, last active ${age(r.lastActiveAt)}${r.live ? " (live)" : ""}:`];
      for (const p of r.prompts) lines.push(`  > ${p}`);
      if (r.filesTouched.length) lines.push(`  files touched: ${r.filesTouched.join(", ")}`);
      return lines.join("\n");
    })
    .join("\n");
}
