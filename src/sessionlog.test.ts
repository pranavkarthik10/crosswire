import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claudeSlug, collectRecap, formatRecap } from "./sessionlog";

function tmp() {
  return mkdtempSync(join(tmpdir(), "cw-sessionlog-"));
}

const jl = (recs: unknown[]) => recs.map((r) => JSON.stringify(r)).join("\n") + "\n";

describe("claude reader", () => {
  test("extracts prompts and touched files, skips meta", () => {
    const repo = tmp();
    const projects = tmp();
    const dir = join(projects, claudeSlug(repo));
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "s1.jsonl"),
      jl([
        { type: "user", message: { role: "user", content: "fix the auth bug" } },
        { type: "user", message: { role: "user", content: "<system-reminder>ignore me</system-reminder>" } },
        { type: "assistant", message: { content: [{ type: "tool_use", name: "Edit", input: { file_path: join(repo, "src/auth.ts") } }] } },
        { type: "user", message: { role: "user", content: [{ type: "text", text: "now add tests" }, { type: "tool_result", content: "x" }] } },
        "not json at all",
      ].map((r) => (typeof r === "string" ? r : r)) as unknown[]),
    );
    const recaps = collectRecap(repo, { claudeProjectsDir: projects, codexSessionsDir: tmp() });
    expect(recaps.length).toBe(1);
    expect(recaps[0].harness).toBe("claude");
    expect(recaps[0].prompts).toEqual(["fix the auth bug", "now add tests"]);
    expect(recaps[0].filesTouched).toEqual(["src/auth.ts"]); // repo-relative
    expect(formatRecap(recaps)).toContain("fix the auth bug");
  });

  test("empty when no sessions for repo", () => {
    expect(collectRecap(tmp(), { claudeProjectsDir: tmp(), codexSessionsDir: tmp() })).toEqual([]);
  });
});

describe("codex reader", () => {
  test("matches sessions by cwd from session_meta and extracts user prompts", () => {
    const repo = tmp();
    const sessions = tmp();
    const day = join(sessions, "2026", "08", "14");
    mkdirSync(day, { recursive: true });
    writeFileSync(
      join(day, "rollout-1.jsonl"),
      jl([
        { timestamp: "t", type: "session_meta", payload: { cwd: repo } },
        { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "<environment_context>x</environment_context>" }] } },
        { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "refactor the parser" }] } },
      ]),
    );
    writeFileSync(
      join(day, "rollout-2.jsonl"),
      jl([
        { timestamp: "t", type: "session_meta", payload: { cwd: "/somewhere/else" } },
        { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "unrelated repo" }] } },
      ]),
    );
    const recaps = collectRecap(repo, { claudeProjectsDir: tmp(), codexSessionsDir: sessions });
    expect(recaps.length).toBe(1);
    expect(recaps[0].harness).toBe("codex");
    expect(recaps[0].prompts).toEqual(["refactor the parser"]);
  });
});
