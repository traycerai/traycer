import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { CLI_ERROR_CODES, cliError } from "../runner/errors";
import { config } from "../config";

// Trusted minisign public keys the CLI accepts when verifying host
// archive signatures. Keys come from two sources:
//
//   1. The source-controlled `config.hostTrustedPubkeys` - the root of
//      trust baked into this CLI build. Empty for dev/source builds; the
//      deploy script (the CLI's scripts/set-deploy-target.cjs) bakes the
//      staging / production key(s) here before packaging. Because it lives
//      in source
//      (not env), a hostile runtime environment cannot replace the trust
//      root, and the SEA cannot be downgraded to "no embedded keys".
//   2. Disk overlay at ~/.traycer/cli/host-trusted-pubkeys - an operator
//      escape hatch to pin extra keys without rebuilding. ADDS to the trust
//      set; cannot remove the baked keys.
//
// If neither yields a key, `createRegistryClient` (see ./client.ts) raises
// `HOST_VERIFY_FAILED` at construction time, so an accidentally-shipped
// build without a trust root fails loud and early instead of trusting
// whatever signature arrives over the wire.
//
// Each entry is a base64 string encoding the standard minisign public key
// payload: `Ed` algorithm tag (2 bytes), 8-byte key id, 32-byte Ed25519
// public key.

export interface ParsedMinisignPublicKey {
  readonly raw: string;
  // 8-byte key id, hex-encoded (lowercase, 16 chars). Matches the
  // identifier embedded in the signature.
  readonly keyId: string;
  // 32-byte Ed25519 public key.
  readonly publicKey: Uint8Array;
}

export interface TrustedKeySet {
  readonly keys: readonly ParsedMinisignPublicKey[];
  readonly sources: readonly string[];
}

export async function loadTrustedKeys(): Promise<TrustedKeySet> {
  const raws: { value: string; source: string }[] = [];
  // Baked keys (config.hostTrustedPubkeys) are the trust root and the
  // first source to register so they appear before the disk overlay in the
  // resulting key list.
  for (const baked of config.hostTrustedPubkeys) {
    const trimmed = baked.trim();
    if (trimmed.length === 0 || trimmed.startsWith("#")) continue;
    raws.push({ value: trimmed, source: "embedded" });
  }
  // Disk overlay: operator escape hatch for pinning extra keys without
  // rebuilding. ADDS to the trust set; cannot replace baked.
  const overlayPath = join(
    homedir(),
    ".traycer",
    "cli",
    "host-trusted-pubkeys",
  );
  try {
    const contents = await readFile(overlayPath, "utf8");
    for (const line of contents.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (trimmed.length === 0 || trimmed.startsWith("#")) continue;
      raws.push({ value: trimmed, source: `file:${overlayPath}` });
    }
  } catch {
    // Overlay is optional.
  }
  const keys: ParsedMinisignPublicKey[] = [];
  const sources: string[] = [];
  // Baked keys must parse - failure is a build-pipeline bug worth
  // aborting (the build was published with a corrupt trust root and would
  // refuse every verify anyway). The disk overlay is operator-supplied; a
  // single malformed line must not brick the load and therefore drop the
  // baked production trust root. Skip-and-warn on overlay parse failures
  // keeps the install path resilient to operator typos without
  // compromising the baked trust root that ships with every CLI binary.
  for (const { value, source } of raws) {
    if (source === "embedded") {
      const parsed = parseMinisignPublicKey(value, source);
      keys.push(parsed);
      if (!sources.includes(source)) sources.push(source);
      continue;
    }
    try {
      const parsed = parseMinisignPublicKey(value, source);
      keys.push(parsed);
      if (!sources.includes(source)) sources.push(source);
    } catch (err) {
      // Best-effort warn: stderr is the right stream because the
      // runner already routes its NDJSON to stdout. Don't surface a
      // CliError - overlay parse failures are operator-actionable but
      // should not abort the install path that the baked keys can
      // service on their own.
      const message = err instanceof Error ? err.message : String(err);
      console.warn(
        `host trusted pubkey overlay (${source}) skipped: ${message}`,
      );
    }
  }
  return { keys, sources };
}

// Parse a minisign public key string. Accepts either a bare base64
// payload (one line) or the standard `minisign -G` two-line format:
//
//   untrusted comment: minisign public key XXXX
//   <base64 payload>
//
// We tolerate either form so operators can paste straight from
// `minisign.pub` or stash just the payload in env vars.
export function parseMinisignPublicKey(
  raw: string,
  sourceLabel: string,
): ParsedMinisignPublicKey {
  const lines = raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const payloadLine =
    lines.find((line) => !line.startsWith("untrusted comment:")) ?? "";
  if (payloadLine.length === 0) {
    throw cliError({
      code: CLI_ERROR_CODES.CONFIG_INVALID,
      message: `host trusted pubkey (${sourceLabel}): payload line is empty`,
      details: { sourceLabel },
      exitCode: 1,
    });
  }
  let decoded: Buffer;
  try {
    decoded = Buffer.from(payloadLine, "base64");
  } catch (err) {
    throw cliError({
      code: CLI_ERROR_CODES.CONFIG_INVALID,
      message: `host trusted pubkey (${sourceLabel}): payload is not valid base64`,
      details: {
        sourceLabel,
        error: err instanceof Error ? err.message : String(err),
      },
      exitCode: 1,
    });
  }
  if (decoded.length !== 42) {
    throw cliError({
      code: CLI_ERROR_CODES.CONFIG_INVALID,
      message: `host trusted pubkey (${sourceLabel}): decoded length=${decoded.length}, expected 42 (2 algo + 8 keyId + 32 pubkey)`,
      details: { sourceLabel, length: decoded.length },
      exitCode: 1,
    });
  }
  const algo = decoded.subarray(0, 2).toString("ascii");
  if (algo !== "Ed") {
    throw cliError({
      code: CLI_ERROR_CODES.CONFIG_INVALID,
      message: `host trusted pubkey (${sourceLabel}): unsupported algorithm tag '${algo}' (expected 'Ed')`,
      details: { sourceLabel, algo },
      exitCode: 1,
    });
  }
  const keyId = decoded.subarray(2, 10).toString("hex");
  const publicKey = new Uint8Array(decoded.subarray(10, 42));
  return { raw: payloadLine, keyId, publicKey };
}
