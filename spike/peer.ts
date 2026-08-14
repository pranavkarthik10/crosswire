// M0 spike: prove iroh-on-Bun. Two processes exchange JSON envelopes over a
// bi-directional QUIC stream, dialing by public key (via ticket or bare id).
//
//   bun spike/peer.ts listen
//   bun spike/peer.ts dial <ticket-or-id>
//
// The listener answers a `status?` envelope with fake presence data; the dialer
// prints the reply and reports whether the path ended up direct or relayed.

import {
  Endpoint,
  EndpointAddr,
  EndpointId,
  EndpointTicket,
  type Connection,
  setLogLevel,
  LogLevel,
} from "@number0/iroh";

const ALPN = [...new TextEncoder().encode("agentchat/0")];

setLogLevel(LogLevel.Warn);

type Envelope =
  | { t: "status?" }
  | { t: "status"; from: string; branch: string; note: string };

const enc = (e: Envelope) => [...new TextEncoder().encode(JSON.stringify(e))];
const dec = (bytes: number[]): Envelope =>
  JSON.parse(new TextDecoder().decode(Uint8Array.from(bytes)));

async function describePath(conn: Connection): Promise<string> {
  const paths = conn.paths();
  const sel = paths.find((p) => p.isSelected) ?? paths[0];
  if (!sel) return "no path info";
  return `${sel.isRelay ? "RELAY" : "DIRECT"} via ${sel.remoteAddr} (rtt ${sel.rttMs.toFixed(1)}ms)`;
}

async function listen() {
  const ep = await Endpoint.bind({ alpns: [ALPN] });
  console.log(`id:     ${ep.id().toString()}`);
  await ep.online();
  const ticket = EndpointTicket.fromAddr(ep.addr());
  console.log(`ticket: ${ticket.toString()}`);
  console.log(`\ndial from another terminal/machine:\n  bun spike/peer.ts dial ${ticket.toString()}\n`);

  while (true) {
    const incoming = await ep.acceptNext();
    if (!incoming) break; // endpoint closed
    (async () => {
      const conn = await (await incoming.accept()).connect();
      const remote = conn.remoteId().fmtShort();
      console.log(`[${remote}] connected — ${await describePath(conn)}`);
      const bi = await conn.acceptBi();
      const msg = dec(await bi.recv.readToEnd(1 << 16));
      console.log(`[${remote}] recv:`, msg);
      if (msg.t === "status?") {
        await bi.send.writeAll(
          enc({
            t: "status",
            from: ep.id().fmtShort(),
            branch: "feat/spike",
            note: "answered by daemon, no agent woken",
          }),
        );
      }
      await bi.send.finish();
      await conn.closed();
      console.log(`[${remote}] closed`);
    })().catch((err) => console.error("conn error:", err));
  }
}

async function dial(target: string) {
  const ep = await Endpoint.bind({ alpns: [ALPN] });
  console.log(`id: ${ep.id().toString()} (dialer)`);

  // Accept a full ticket (id + relay + direct addrs) or a bare base32 id —
  // the bare-id path exercises n0 discovery.
  const addr = target.startsWith("endpoint")
    ? EndpointTicket.fromString(target).endpointAddr()
    : new EndpointAddr(EndpointId.fromString(target));

  const t0 = performance.now();
  const conn = await ep.connect(addr, ALPN);
  console.log(`connected in ${(performance.now() - t0).toFixed(0)}ms — ${await describePath(conn)}`);

  const bi = await conn.openBi();
  await bi.send.writeAll(enc({ t: "status?" }));
  await bi.send.finish();
  const reply = dec(await bi.recv.readToEnd(1 << 16));
  console.log("reply:", reply);
  console.log(`path after exchange: ${await describePath(conn)}`);

  conn.close(0n, [...new TextEncoder().encode("done")]);
  await ep.close();
}

const [mode, arg] = process.argv.slice(2);
if (mode === "listen") await listen();
else if (mode === "dial" && arg) await dial(arg);
else {
  console.log("usage: bun spike/peer.ts listen | dial <ticket-or-id>");
  process.exit(1);
}
