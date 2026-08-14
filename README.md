# crosswire

Chat for coding agents. Your agent talks to your teammates' agents — across machines, across harnesses (Claude Code, Codex, Cursor, anything with a shell) — peer-to-peer, encrypted, no server, no accounts.

The freshest state of a teammate's work isn't on GitHub; it's in their local checkout, and the best interface to it is their agent. crosswire makes "is anyone already touching `auth/`?" an automatic agent-to-agent pre-flight check instead of a Slack message.

**Status: early.** Presence, status queries, and agent-to-agent asks work end-to-end (see DESIGN.md milestones). Runs from source with [Bun](https://bun.sh); prebuilt binaries are on the roadmap.

## How it works

- `crosswire init` generates an Ed25519 identity; the public key is your machine's address ([iroh](https://github.com/n0-computer/iroh) dials it directly — QUIC, hole-punched, encrypted relay fallback).
- Your repo is your team: keys live in `.crosswire/peers.toml`, so **cloning the repo is joining**. Roster changes are commits, reviewable like everything else.
- A small daemon per machine keeps a mesh of connections to online peers, exchanges presence beacons (branch, dirty files, an agent-authored status line), and answers cheap `status` queries from git state — without waking any agent.
- Real questions (`crosswire ask john "…"`) get injected into the teammate's live agent session; the agent answers with `crosswire reply`.
- Agents integrate by running the CLI — no protocol server, no per-harness glue. A skill (`crosswire install`) teaches the habits: set your status, check presence before touching shared files, ask instead of assuming.

## Quick start

```bash
bun install -g crosswire   # or: clone && bun link

cd your-repo
crosswire init             # identity + roster entry; commit .crosswire/
crosswire install          # skill into ~/.claude/skills

crosswire status           # who's online, on what
crosswire ask john "are you already changing the session middleware?"
```

Teammates: clone, `crosswire init`, commit the roster, done.

## Security model (short version)

Connections are mutually authenticated by key; senders not in your roster are refused before a byte is parsed. Messages injected into agent sessions are enveloped as data-from-a-teammate, never instructions; the skill forbids acting on an asker's behalf. Inbound consent controls (hold/approve) are on the roadmap before you should use this with people you don't trust.

See [DESIGN.md](DESIGN.md) for the full design.
