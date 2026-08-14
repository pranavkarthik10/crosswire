// Wire protocol: one ALPN, JSON envelopes.
//
// - presence beacons: one envelope per uni stream, sent periodically on
//   outbound mesh connections
// - requests (status?): one envelope per bi stream, reply on the same stream
//
// Senders are authenticated by the QUIC connection itself (remoteId is the
// peer's public key); the daemon drops anything from keys not in a roster.

import type { GitState } from "./gitstate";

export const ALPN = [...new TextEncoder().encode("crosswire/0")];
export const MAX_ENVELOPE = 64 * 1024;

export interface PresenceBeacon {
  t: "presence";
  name: string;
  device: string;
  ts: number; // sender clock, ms epoch
  branch: string | null;
  repo: string | null; // repo dir basename, not full path
  dirtyCount: number;
  statusLine: string | null; // agent-authored, null until M2's set_status
}

export interface StatusRequest {
  t: "status?";
}

/** A question routed to the peer's live agent session; replied on the same stream. */
export interface AskRequest {
  t: "ask";
  id: string;
  from: string; // "name@device"
  question: string;
}

export interface AskReply {
  t: "ask-reply";
  id: string;
  ok: boolean;
  answer: string | null;
  error?: string;
}

/** Fire-and-forget message; acked on the same stream. */
export interface SendMsg {
  t: "send";
  id: string;
  from: string;
  text: string;
}

export interface SendAck {
  t: "send-ack";
  id: string;
  queued: boolean;
  note?: string;
}

export interface StatusReply {
  t: "status";
  name: string;
  device: string;
  ts: number;
  statusLine: string | null;
  git: GitState;
}

export type Envelope = PresenceBeacon | StatusRequest | StatusReply | AskRequest | AskReply | SendMsg | SendAck;

export function encode(e: Envelope): number[] {
  const bytes = [...new TextEncoder().encode(JSON.stringify(e))];
  if (bytes.length > MAX_ENVELOPE) throw new Error(`envelope too large: ${bytes.length}`);
  return bytes;
}

export function decode(bytes: number[]): Envelope {
  if (bytes.length > MAX_ENVELOPE) throw new Error(`envelope too large: ${bytes.length}`);
  const parsed = JSON.parse(new TextDecoder().decode(Uint8Array.from(bytes)));
  if (typeof parsed !== "object" || parsed === null || typeof parsed.t !== "string")
    throw new Error("malformed envelope");
  return parsed as Envelope;
}
