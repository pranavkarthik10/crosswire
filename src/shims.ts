// Harness shims, embedded as source strings so the compiled binary can
// install them. Each is a tiny in-session module for a harness that has a
// plugin/extension API: it tails the crosswire spool (~/.crosswire/
// spool.ndjson, NDJSON records appended by the daemon when no Claude session
// took an injection) and pushes new records into the running session. The
// receiving agent answers with `crosswire reply <id> "..."` like any other.
//
// Modeled on agent-talk's inbox monitors (MIT, github.com/xhluca/agent-talk):
// per-spool byte offset + delivered-id set for dedup, fs.watch backed by a
// 1s poll, truncation-safe.

const SPOOL_TAIL = `
const SPOOL = (process.env.CROSSWIRE_HOME ?? (process.env.HOME + "/.crosswire")) + "/spool.ndjson";
function makeTailer(deliver) {
  const seen = new Set();
  let offset = -1, carry = "";
  function drain() {
    let stat;
    try { stat = fs.statSync(SPOOL); } catch { return; }
    if (offset === -1) { offset = stat.size; return; } // first sight: skip backlog
    if (stat.size < offset) { offset = 0; carry = ""; }
    if (stat.size === offset) return;
    let chunk = "";
    try {
      const fd = fs.openSync(SPOOL, "r");
      try {
        const len = stat.size - offset;
        const buf = Buffer.alloc(len);
        const read = fs.readSync(fd, buf, 0, len, offset);
        chunk = buf.subarray(0, read).toString("utf-8");
        offset += read;
      } finally { fs.closeSync(fd); }
    } catch { return; }
    const parts = (carry + chunk).split("\\n");
    carry = parts.pop() ?? "";
    for (const line of parts) {
      if (!line.trim()) continue;
      let rec;
      try { rec = JSON.parse(line); } catch { continue; }
      if (!rec.prompt || (rec.id && seen.has(rec.id))) continue;
      if (rec.id) seen.add(rec.id);
      deliver(rec);
    }
  }
  drain();
  let watcher;
  try { watcher = fs.watch(SPOOL, drain); } catch {}
  const poll = setInterval(drain, 1000);
  return () => { try { watcher?.close(); } catch {} clearInterval(poll); };
}
`;

/** opencode plugin -> ~/.config/opencode/plugins/crosswire.ts */
export const OPENCODE_PLUGIN = `// crosswire inbox shim for opencode (installed by \`crosswire install\`).
// Tails ~/.crosswire/spool.ndjson and admits new records into the running
// session; the agent answers with \`crosswire reply <id> "..."\`.
import * as fs from "node:fs";

export const CrosswireInbox = async ({ client }) => {
  ${SPOOL_TAIL}
  let activeSession;
  const pending = [];
  async function inject(rec) {
    if (!activeSession) { pending.push(rec); return; }
    try {
      await client.session.promptAsync({
        path: { id: activeSession },
        body: { parts: [{ type: "text", text: rec.prompt }] },
      });
    } catch { activeSession = undefined; pending.push(rec); }
  }
  makeTailer((rec) => { void inject(rec); });
  return {
    async event({ event }) {
      const props = event?.properties;
      const id = props?.sessionID ?? props?.info?.id;
      if (id && id !== activeSession) {
        activeSession = id;
        const batch = pending.splice(0, pending.length);
        for (const rec of batch) await inject(rec);
      }
    },
  };
};

export default CrosswireInbox;
`;

/** pi extension -> ~/.pi/agent/extensions/crosswire.ts */
export const PI_EXTENSION = `// crosswire inbox shim for pi (installed by \`crosswire install\`).
// Tails ~/.crosswire/spool.ndjson and pushes new records into the active
// session; the agent answers with \`crosswire reply <id> "..."\`.
import * as fs from "node:fs";

export default function (pi) {
  ${SPOOL_TAIL}
  let stop;
  pi.on("session_start", async () => {
    stop = makeTailer((rec) => {
      pi.sendMessage(
        { customType: "crosswire-inbox", content: rec.prompt, display: true, details: { from: rec.from, id: rec.id } },
        { triggerTurn: true },
      );
    });
  });
  pi.on("session_shutdown", async () => { stop?.(); });
}
`;
