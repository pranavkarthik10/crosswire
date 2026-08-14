// M0 spike, part 2: full-mesh presence between N peers who share only a
// roster of public keys (a file standing in for .agentchat/peers.toml).
//
//   bun spike/presence.ts <name> <roster-file>
//
// Each peer binds an endpoint, appends `name id` to the roster, dials every
// other id it sees (bare key, discovery does the rest), and sends a presence
// beacon on each outbound connection every 2s over a uni stream. Beacons
// received on inbound connections are printed. Exits after ~20s.

import { Endpoint, EndpointAddr, EndpointId, setLogLevel, LogLevel } from "@number0/iroh";
import { appendFileSync, readFileSync } from "node:fs";

const ALPN = [...new TextEncoder().encode("agentchat/presence/0")];
setLogLevel(LogLevel.Off);

const [name, rosterFile] = process.argv.slice(2);
if (!name || !rosterFile) {
  console.log("usage: bun spike/presence.ts <name> <roster-file>");
  process.exit(1);
}

interface Beacon {
  name: string;
  branch: string;
  status: string;
  seq: number;
}

const ep = await Endpoint.bind({ alpns: [ALPN] });
const myId = ep.id().toString();
appendFileSync(rosterFile, `${name} ${myId}\n`);
console.log(`[${name}] up, id ${ep.id().fmtShort()}`);

const seen = new Map<string, Beacon>(); // peer name -> latest beacon
const dialed = new Set<string>();

// Accept inbound connections; read one beacon per uni stream.
(async () => {
  while (true) {
    const incoming = await ep.acceptNext();
    if (!incoming) return;
    (async () => {
      const conn = await (await incoming.accept()).connect();
      while (true) {
        const recv = await conn.acceptUni();
        const beacon: Beacon = JSON.parse(
          new TextDecoder().decode(Uint8Array.from(await recv.readToEnd(4096))),
        );
        const first = !seen.has(beacon.name);
        seen.set(beacon.name, beacon);
        if (first || beacon.seq % 5 === 0)
          console.log(`[${name}] sees ${beacon.name}: on ${beacon.branch} — "${beacon.status}" (seq ${beacon.seq})`);
      }
    })().catch(() => {});
  }
})();

// Dial every roster peer once; send beacons on each open connection.
let seq = 0;
const conns: { peer: string; send: (b: Beacon) => Promise<void> }[] = [];

const tick = setInterval(async () => {
  seq++;
  // pick up roster additions
  for (const line of readFileSync(rosterFile, "utf8").trim().split("\n")) {
    const [peerName, id] = line.split(" ");
    if (!peerName || !id || id === myId || dialed.has(id)) continue;
    dialed.add(id);
    (async () => {
      const conn = await ep.connect(new EndpointAddr(EndpointId.fromString(id)), ALPN);
      conns.push({
        peer: peerName,
        send: async (b: Beacon) => {
          const uni = await conn.openUni();
          await uni.writeAll([...new TextEncoder().encode(JSON.stringify(b))]);
          await uni.finish();
        },
      });
      console.log(`[${name}] connected out to ${peerName}`);
    })().catch((e) => console.error(`[${name}] dial ${peerName} failed:`, e.message));
  }
  const beacon: Beacon = { name, branch: `feat/${name}`, status: `${name} hacking, beat ${seq}`, seq };
  for (const c of conns) c.send(beacon).catch(() => {});
}, 2000);

setTimeout(async () => {
  clearInterval(tick);
  const peers = [...seen.keys()].sort();
  console.log(`[${name}] RESULT saw ${peers.length} peers: ${peers.join(", ")}`);
  await ep.close();
  process.exit(0);
}, 20_000);
