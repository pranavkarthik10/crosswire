import { describe, expect, test } from "bun:test";
import {
  formatAge,
  formatHeader,
  formatInboxRow,
  formatPresenceRow,
  stripAnsi,
  truncate,
  type TuiInboxItem,
  type TuiPresenceRow,
} from "./tui";

const peer = (over: Partial<TuiPresenceRow> = {}): TuiPresenceRow => ({
  name: "bob",
  device: "thinkpad",
  key: "k1",
  online: true,
  lastSeenSec: null,
  beacon: { branch: "feat/refunds", repo: "repo-b", dirtyCount: 2, statusLine: "refactoring auth", ts: 0 },
  ...over,
});

const item = (over: Partial<TuiInboxItem> = {}): TuiInboxItem => ({
  id: "19a242c0",
  kind: "ask",
  from: "alice@mba",
  text: "hello there",
  ts: 1_000_000,
  read: false,
  answered: false,
  ...over,
});

describe("truncate", () => {
  test("leaves short strings alone", () => {
    expect(truncate("abc", 5)).toBe("abc");
    expect(truncate("abcde", 5)).toBe("abcde");
  });
  test("ellipsizes long strings to exactly width", () => {
    expect(truncate("abcdef", 5)).toBe("abcd…");
    expect(truncate("abcdef", 1)).toBe("…");
  });
  test("width <= 0 yields empty", () => {
    expect(truncate("abc", 0)).toBe("");
  });
});

describe("formatAge", () => {
  test("null is never", () => expect(formatAge(null)).toBe("never"));
  test("seconds, minutes, hours", () => {
    expect(formatAge(5)).toBe("5s ago");
    expect(formatAge(180)).toBe("3m ago");
    expect(formatAge(7200)).toBe("2h ago");
  });
});

describe("formatHeader", () => {
  test("right-aligns the repo count", () => {
    const h = formatHeader("alice", "mba", 2, 60);
    expect(h.length).toBe(60);
    expect(h.startsWith("crosswire — alice@mba")).toBe(true);
    expect(h.endsWith("2 repos")).toBe(true);
  });
  test("singular repo", () => {
    expect(formatHeader("a", "b", 1, 60).endsWith("1 repo")).toBe(true);
  });
  test("truncates when too narrow", () => {
    expect(formatHeader("alice", "mba", 2, 10).length).toBeLessThanOrEqual(10);
  });
});

describe("formatPresenceRow", () => {
  test("online with full beacon", () => {
    const row = formatPresenceRow(peer(), 80);
    expect(stripAnsi(row)).toBe('● bob@thinkpad  repo-b@feat/refunds  (2 dirty)  — "refactoring auth"');
    expect(row).toContain("\x1b[32m"); // green dot
  });
  test("offline shows dim ○ and seen age", () => {
    const row = formatPresenceRow(peer({ online: false, lastSeenSec: 180, beacon: null }), 80);
    expect(stripAnsi(row)).toBe("○ bob@thinkpad  seen 3m ago");
    expect(row.startsWith("\x1b[2m")).toBe(true);
  });
  test("offline never seen", () => {
    expect(stripAnsi(formatPresenceRow(peer({ online: false, beacon: null }), 80))).toBe("○ bob@thinkpad  never");
  });
  test("clean beacon omits dirty count", () => {
    const b = { branch: "main", repo: "r", dirtyCount: 0, statusLine: null, ts: 0 };
    expect(stripAnsi(formatPresenceRow(peer({ beacon: b }), 80))).toBe("● bob@thinkpad  r@main");
  });
  test("truncates to width", () => {
    expect(stripAnsi(formatPresenceRow(peer(), 20)).length).toBeLessThanOrEqual(20);
  });
});

describe("formatInboxRow", () => {
  const now = 1_000_000 + 120_000; // 2m after ts
  test("unread ask is bold with a bullet", () => {
    const row = formatInboxRow(item(), 80, now);
    expect(stripAnsi(row)).toBe("• [ask?] 19a242c0 alice@mba (2m ago): hello there");
    expect(row).toContain("\x1b[1m");
  });
  test("answered ask gets a check", () => {
    expect(stripAnsi(formatInboxRow(item({ answered: true, read: true }), 80, now))).toBe(
      "  [ask✓] 19a242c0 alice@mba (2m ago): hello there",
    );
  });
  test("sends are [msg] and read rows are not bold", () => {
    const row = formatInboxRow(item({ kind: "send", read: true }), 80, now);
    expect(stripAnsi(row)).toBe("  [msg] 19a242c0 alice@mba (2m ago): hello there");
    expect(row).not.toContain("\x1b[1m");
  });
  test("newlines collapse and long text truncates", () => {
    const row = stripAnsi(formatInboxRow(item({ text: "a\nb ".repeat(50) }), 60, now));
    expect(row.length).toBeLessThanOrEqual(60);
    expect(row).not.toContain("\n");
    expect(row.endsWith("…")).toBe(true);
  });
});
