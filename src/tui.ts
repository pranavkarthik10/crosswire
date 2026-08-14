// The `crosswire` TUI — what running `crosswire` with no subcommand opens.
//
// A live dashboard of team presence + inbox in the Discord-sidebar spirit:
// who's around, what they're on, what's waiting for you. Full-screen on the
// alternate buffer, redrawn every 2s from the daemon's control socket (one
// JSON request line -> one JSON reply line, fresh connection per request —
// same protocol as the CLI).

// ---- protocol shapes (mirror the daemon's replies) ----

export interface TuiBeacon {
  statusLine: string | null;
  ts: number;
}

export interface TuiPresenceRow {
  name: string;
  device: string;
  key: string;
  online: boolean;
  lastSeenSec: number | null;
  beacon: TuiBeacon | null;
}

export interface TuiInboxItem {
  id: string;
  kind: "ask" | "send";
  from: string;
  text: string;
  ts: number;
  read: boolean;
  answered: boolean;
}

interface TuiState {
  reachable: boolean;
  me: { name: string; device: string; repos: string[] } | null;
  presence: TuiPresenceRow[];
  inbox: TuiInboxItem[];
}

// ---- control socket client (one request per connection) ----

function request(sockPath: string, req: object, timeoutMs = 3_000): Promise<any> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("daemon did not respond")), timeoutMs);
    let buf = "";
    Bun.connect({
      unix: sockPath,
      socket: {
        open(socket) {
          socket.write(JSON.stringify(req) + "\n");
          socket.flush();
        },
        data(_socket, chunk) {
          buf += chunk.toString();
          const nl = buf.indexOf("\n");
          if (nl !== -1) {
            clearTimeout(timer);
            try {
              resolve(JSON.parse(buf.slice(0, nl)));
            } catch (err) {
              reject(err as Error);
            }
          }
        },
        error(_socket, err) {
          clearTimeout(timer);
          reject(err);
        },
        connectError(_socket, err) {
          clearTimeout(timer);
          reject(err);
        },
      },
    }).catch((err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

// ---- pure render helpers (exported for tests) ----

const green = (s: string) => `\x1b[32m${s}\x1b[39m`;
const dim = (s: string) => `\x1b[2m${s}\x1b[22m`;
const bold = (s: string) => `\x1b[1m${s}\x1b[22m`;
export const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");

/** Clamp a plain (ANSI-free) string to `width` cells, ellipsizing. */
export function truncate(s: string, width: number): string {
  if (width <= 0) return "";
  if (s.length <= width) return s;
  return width === 1 ? "…" : s.slice(0, width - 1) + "…";
}

/** "5s ago" / "3m ago" / "2h ago"; null → "never". */
export function formatAge(sec: number | null): string {
  if (sec === null) return "never";
  if (sec < 60) return `${sec}s ago`;
  if (sec < 3600) return `${Math.round(sec / 60)}m ago`;
  return `${Math.round(sec / 3600)}h ago`;
}

/** Header line: name@device left, repo count right-aligned, exactly `width` wide when it fits. */
export function formatHeader(name: string, device: string, repoCount: number, width: number): string {
  const left = `crosswire — ${name}@${device}`;
  const right = `${repoCount} repo${repoCount === 1 ? "" : "s"}`;
  const gap = width - left.length - right.length;
  return gap > 0 ? left + " ".repeat(gap) + right : truncate(`${left}  ${right}`, width);
}

/** One peer row: green ● online / dim ○ offline, truncated to `width`. */
export function formatPresenceRow(r: TuiPresenceRow, width: number): string {
  const b = r.beacon;
  const where = "";
  const dirty = "";
  const status = b?.statusLine ? `  — "${b.statusLine}"` : "";
  const seen = r.online ? "" : r.lastSeenSec === null ? "  never" : `  seen ${formatAge(r.lastSeenSec)}`;
  const body = truncate(`${r.name}@${r.device}${where}${dirty}${status}${seen}`, Math.max(0, width - 2));
  return r.online ? `${green("●")} ${body}` : dim(`○ ${body}`);
}

/** One inbox row: bold • when unread, [ask?]/[ask✓]/[msg], truncated to `width`. */
export function formatInboxRow(m: TuiInboxItem, width: number, nowMs = Date.now()): string {
  const flag = m.kind === "ask" ? (m.answered ? "ask✓" : "ask?") : "msg";
  const when = formatAge(Math.max(0, Math.round((nowMs - m.ts) / 1000)));
  const body = truncate(`[${flag}] ${m.id} ${m.from} (${when}): ${m.text.replace(/\s+/g, " ")}`, Math.max(0, width - 2));
  return m.read ? `  ${body}` : bold(`• ${body}`);
}

// ---- frame assembly ----

const center = (s: string, w: number) => " ".repeat(Math.max(0, Math.floor((w - s.length) / 2))) + s;

function screenLines(state: TuiState, cols: number, rows: number): string[] {
  const lines: string[] = [];
  if (!state.reachable || !state.me) {
    for (let i = 0; i < Math.max(1, Math.floor(rows / 2) - 1); i++) lines.push("");
    lines.push(center(truncate("daemon not running — start with: crosswire daemon", cols), cols));
    while (lines.length < rows - 1) lines.push("");
    return lines.slice(0, rows - 1).concat(dim(truncate("q quit · retrying…", cols)));
  }
  lines.push(formatHeader(state.me.name, state.me.device, state.me.repos.length, cols));
  lines.push("");
  lines.push(bold("PEERS"));
  if (state.presence.length === 0) lines.push(dim("  no peers — add teammates to .crosswire/peers.toml"));
  for (const r of state.presence) lines.push(formatPresenceRow(r, cols));
  lines.push("");
  lines.push(bold("INBOX"));
  const items = state.inbox.slice(0, 6); // daemon sends newest first
  if (items.length === 0) lines.push(dim("  empty"));
  for (const m of items) lines.push(formatInboxRow(m, cols));
  while (lines.length < rows - 1) lines.push("");
  return lines.slice(0, rows - 1).concat(dim(truncate("q quit · r refresh", cols)));
}

// ---- main loop ----

export async function runTui(opts: { sockPath: string }): Promise<void> {
  const { sockPath } = opts;
  const out = process.stdout;
  const stdin = process.stdin as NodeJS.ReadStream & { setRawMode?: (b: boolean) => void };
  const interactive = stdin.isTTY === true && typeof stdin.setRawMode === "function";
  const state: TuiState = { reachable: false, me: null, presence: [], inbox: [] };

  const paint = () => {
    const cols = out.columns || 80;
    const rows = out.rows || 24;
    const lines = screenLines(state, cols, rows);
    // one write per frame: home the cursor, clear each line's tail, clear the rest
    if (interactive) out.write("\x1b[H" + lines.map((l) => l + "\x1b[K").join("\r\n") + "\x1b[J");
    else out.write(lines.join("\n") + "\n");
  };

  const refresh = async () => {
    try {
      const pong = await request(sockPath, { cmd: "ping" });
      if (!pong?.ok) throw new Error("bad ping reply");
      const [pres, inbox] = await Promise.all([
        request(sockPath, { cmd: "presence" }),
        request(sockPath, { cmd: "inbox" }), // no markRead — the TUI only observes
      ]);
      state.reachable = true;
      state.me = { name: pong.name, device: pong.device, repos: pong.repos ?? [] };
      state.presence = pres?.ok ? pres.presence : [];
      state.inbox = inbox?.ok ? inbox.inbox : [];
    } catch {
      state.reachable = false; // keep retrying every interval
    }
    paint();
  };

  if (!interactive) {
    await refresh(); // scriptable/testable: one paint, then done
    return;
  }

  let resolveQuit!: () => void;
  const quit = new Promise<void>((r) => (resolveQuit = r));
  const onKey = (data: string) => {
    if (data === "q" || data === "\x03") resolveQuit();
    else if (data === "r") void refresh();
  };
  const onSigint = () => resolveQuit();

  out.write("\x1b[?1049h\x1b[?25l"); // alt screen, hide cursor
  stdin.setRawMode!(true);
  stdin.resume();
  stdin.setEncoding("utf8");
  stdin.on("data", onKey);
  process.on("SIGINT", onSigint);
  const timer = setInterval(() => void refresh(), 2_000);
  try {
    await refresh();
    await quit;
  } finally {
    clearInterval(timer);
    stdin.off("data", onKey);
    process.off("SIGINT", onSigint);
    stdin.setRawMode!(false);
    stdin.pause();
    out.write("\x1b[?25h\x1b[?1049l"); // restore cursor + main screen
  }
}
