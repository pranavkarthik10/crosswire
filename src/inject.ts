// Injection into a live Claude Code session via its documented inbox socket:
// newline-delimited JSON — an auth frame, then a user message frame.
//
//   {"type":"auth","token":"<CLAUDE_CODE_MESSAGING_TOKEN>"}
//   {"type":"user","message":{"role":"user","content":"<text>"}}
//
// The socket+token pair is captured by the CLI when an agent session runs any
// crosswire command (the env vars are exported to its Bash tool), and
// registered with the daemon. Injection is best-effort: on failure the
// message stays in the inbox and the skill has agents check `crosswire inbox`.

export interface RegisteredSession {
  harness: "claude-code";
  socket: string;
  token: string | null; // null → no auth frame; delivery subject to the session's inbound controls
  registeredAt: number;
}

export async function injectClaude(session: RegisteredSession, text: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("inject timed out")), 5_000);
    Bun.connect({
      unix: session.socket,
      socket: {
        open(socket) {
          if (session.token) socket.write(JSON.stringify({ type: "auth", token: session.token }) + "\n");
          socket.write(JSON.stringify({ type: "user", message: { role: "user", content: text } }) + "\n");
          socket.flush();
          socket.end();
          clearTimeout(timer);
          resolve();
        },
        data() {},
        error(_s, err) {
          clearTimeout(timer);
          reject(err);
        },
        connectError(_s, err) {
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
