// Machine identity: an Ed25519 secret key plus human labels, stored in the
// crosswire config dir. The derived public key is the machine's address —
// iroh dials it directly, so identity == encryption == addressing.

import { SecretKey } from "@number0/iroh";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir, hostname, userInfo } from "node:os";
import { join } from "node:path";

export interface Identity {
  name: string; // person, e.g. "pranav"
  device: string; // device label, e.g. "mbp"
  secretKey: number[]; // 32 bytes
  publicKey: string; // derived EndpointId, base32/hex string form
}

/** Config dir: $CROSSWIRE_HOME if set (tests, multi-daemon), else ~/.crosswire */
export function configDir(): string {
  return process.env.CROSSWIRE_HOME ?? join(homedir(), ".crosswire");
}

const identityPath = (dir: string) => join(dir, "identity.json");

export function loadIdentity(dir: string = configDir()): Identity | null {
  const path = identityPath(dir);
  if (!existsSync(path)) return null;
  const raw = JSON.parse(readFileSync(path, "utf8"));
  if (!Array.isArray(raw.secretKey) || raw.secretKey.length !== 32)
    throw new Error(`corrupt identity file: ${path}`);
  const publicKey = SecretKey.fromBytes(raw.secretKey).public().toString();
  return { name: raw.name, device: raw.device, secretKey: raw.secretKey, publicKey };
}

export function createIdentity(
  dir: string = configDir(),
  opts: { name?: string; device?: string } = {},
): Identity {
  const existing = loadIdentity(dir);
  if (existing) return existing;
  const secret = SecretKey.generate();
  const identity: Identity = {
    name: opts.name ?? userInfo().username,
    device: opts.device ?? hostname().replace(/\.local$/, "").toLowerCase(),
    secretKey: secret.toBytes(),
    publicKey: secret.public().toString(),
  };
  mkdirSync(dir, { recursive: true });
  const path = identityPath(dir);
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(identity, null, 2) + "\n");
  chmodSync(tmp, 0o600); // holds a private key
  renameSync(tmp, path);
  return identity;
}
