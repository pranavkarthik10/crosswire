// `crosswire install` — teach the installed harnesses.
//
// Two kinds of artifact, both embedded so the compiled binary can install
// them without carrying loose files:
//   - the skill (habits) for harnesses that read skills: Claude Code
//   - inbox shims (live delivery) for harnesses with in-session plugin APIs:
//     opencode (plugin), pi (extension)
// Codex and Cursor have no attach-to-running-session path (Aug 2026), so
// they participate via wake-on-ask and `crosswire inbox`.

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { OPENCODE_PLUGIN, PI_EXTENSION } from "./shims";
// embedded at bundle time; works from source and compiled binary alike
import SKILL_MD from "../skill/SKILL.md" with { type: "text" };

function put(dir: string, file: string, content: string, what: string) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, file), content);
  console.log(`installed ${what} → ${join(dir, file)}`);
}

export function installSkill(opts: { project?: boolean } = {}): void {
  let any = false;

  if (opts.project) {
    put(join(process.cwd(), ".claude", "skills", "crosswire"), "SKILL.md", SKILL_MD, "skill (claude-code, project)");
    return;
  }

  if (existsSync(join(homedir(), ".claude"))) {
    put(join(homedir(), ".claude", "skills", "crosswire"), "SKILL.md", SKILL_MD, "skill (claude-code)");
    any = true;
  }
  if (Bun.which("opencode") || existsSync(join(homedir(), ".config", "opencode"))) {
    put(join(homedir(), ".config", "opencode", "plugins"), "crosswire.ts", OPENCODE_PLUGIN, "inbox shim (opencode plugin)");
    any = true;
  }
  if (Bun.which("pi") || existsSync(join(homedir(), ".pi"))) {
    put(join(homedir(), ".pi", "agent", "extensions"), "crosswire.ts", PI_EXTENSION, "inbox shim (pi extension)");
    any = true;
  }
  if (Bun.which("codex")) {
    console.log("codex detected: no live-injection path exists — codex answers via wake-on-ask (codex exec, read-only sandbox)");
    any = true;
  }
  if (Bun.which("cursor-agent")) {
    console.log("cursor detected: no live-injection path exists — cursor answers via wake-on-ask once the workspace is trusted");
    any = true;
  }

  if (!any) {
    console.log("no supported harness detected. Use --project to install the skill into this repo's .claude/skills/.");
  }
}
