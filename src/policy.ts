// Per-peer inbound policy: what a peer's messages may do on this machine.
//
//   inbound: accept — inject/wake as normal (default for roster peers)
//            hold   — queue to inbox only; never injected, never wakes
//            refuse — drop, asker told nothing beyond "refused"
//   wake:    whether an ask from this peer may wake a read-only agent
//            (wake spends this machine's usage, so it's per-peer consent)
//
// Stored in <cfgDir>/policy.json keyed by peer public key.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface PeerPolicy {
  inbound: "accept" | "hold" | "refuse";
  wake: boolean;
}

export const DEFAULT_POLICY: PeerPolicy = { inbound: "accept", wake: true };

interface PolicyFile {
  defaults?: Partial<PeerPolicy>;
  peers?: Record<string, Partial<PeerPolicy>>;
}

function policyPath(cfgDir: string) {
  return join(cfgDir, "policy.json");
}

function loadFile(cfgDir: string): PolicyFile {
  try {
    if (!existsSync(policyPath(cfgDir))) return {};
    return JSON.parse(readFileSync(policyPath(cfgDir), "utf8"));
  } catch {
    return {};
  }
}

export function policyFor(cfgDir: string, peerKey: string): PeerPolicy {
  const file = loadFile(cfgDir);
  return { ...DEFAULT_POLICY, ...file.defaults, ...file.peers?.[peerKey] };
}

export function setPolicy(cfgDir: string, peerKey: string, patch: Partial<PeerPolicy>): PeerPolicy {
  const file = loadFile(cfgDir);
  file.peers ??= {};
  file.peers[peerKey] = { ...file.peers[peerKey], ...patch };
  mkdirSync(cfgDir, { recursive: true });
  const tmp = policyPath(cfgDir) + ".tmp";
  writeFileSync(tmp, JSON.stringify(file, null, 2) + "\n");
  renameSync(tmp, policyPath(cfgDir));
  return { ...DEFAULT_POLICY, ...file.defaults, ...file.peers[peerKey] };
}
