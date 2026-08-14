// `crosswire install` — copy the skill into detected harnesses.
//
// That is all install does: the CLI is the only integration surface, so
// "integrating" a harness means teaching its agent the habits. Claude Code
// reads skills from ~/.claude/skills/ (user) or <repo>/.claude/skills/
// (project, shared via git). Other harnesses land here as they standardize
// skill/instruction locations.

import { cpSync, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const SKILL_SRC = join(import.meta.dir, "..", "skill");

export function installSkill(opts: { project?: boolean } = {}): void {
  const targets: { harness: string; dir: string }[] = [];

  if (opts.project) {
    targets.push({ harness: "claude-code (project)", dir: join(process.cwd(), ".claude", "skills", "crosswire") });
  } else if (existsSync(join(homedir(), ".claude"))) {
    targets.push({ harness: "claude-code", dir: join(homedir(), ".claude", "skills", "crosswire") });
  }

  if (targets.length === 0) {
    console.log("no supported harness detected (looked for ~/.claude). Use --project to install into this repo's .claude/skills/.");
    return;
  }
  for (const t of targets) {
    mkdirSync(t.dir, { recursive: true });
    cpSync(join(SKILL_SRC, "SKILL.md"), join(t.dir, "SKILL.md"));
    console.log(`installed skill → ${t.dir} (${t.harness})`);
  }
}
