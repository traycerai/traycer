import { createHash, createPublicKey, verify } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { CLI_ERROR_CODES, cliError } from "../runner/errors";
import type { ParsedMinisignPublicKey } from "./trusted-keys";

// Hard ceiling for the `pure` (non-prehashed) signature algorithm where
// the whole archive is buffered in memory. Production hosts publish
// in `prehashed` mode (streaming BLAKE2b) so this only kicks in for the
// rare test-fixture / legacy archive that ships `Ed` instead of `ED`.
const PURE_ALGORITHM_MAX_BYTES = 500 * 1024 * 1024;

// Minisign signature verification using Node's built-in Ed25519 +
// BLAKE2b-512 primitives. We deliberately depend on no third-party
// crypto package - both algorithms ship with Node 24, and shrinking the
// trust surface is exactly what the registry signature chain is for.
//
// Signature file format (text):
//
//   untrusted comment: <free text>
//   <base64: 2-byte algo || 8-byte keyId || 64-byte signature>
//   trusted comment: <free text>
//   <base64: 64-byte global signature over (signature || trusted_comment_bytes)>
//
// Algorithm tag:
//   "Ed" = pure Ed25519 (signs the file bytes directly; supported but
//          unusual for large archives).
//   "ED" = pre-hashed Ed25519: the file is hashed with BLAKE2b-512 and
//          the 64-byte digest is the signed message. This is the mode
//          modern `minisign -S` uses by default and the only mode we
//          publish host archives in.
//
// Global signature: signs `signature_bytes || trusted_comment_utf8` so
// the trusted comment can't be tampered with independently. The
// returned `trustedComment` is therefore a safe field to record on the
// install record / surface to the user.

// SPKI prefix for an Ed25519 public key. Concat with the 32-byte raw
// key to get a DER blob Node's `createPublicKey({ format: "der" })`
// will accept. The bytes are the fixed AlgorithmIdentifier + BIT STRING
// envelope from RFC 8410 §4.
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

export interface ParsedMinisignSignature {
  readonly algorithm: "pure" | "prehashed";
  readonly keyId: string;
  readonly signature: Uint8Array;
  readonly globalSignature: Uint8Array;
  readonly trustedComment: string;
  readonly untrustedComment: string;
}

export function parseMinisignSignatureFile(
  raw: string,
  sourceLabel: string,
): ParsedMinisignSignature {
  // Tolerate trailing whitespace/blank lines but be strict about the
  // 4 required lines we care about. Order is fixed by the minisign spec.
  const allLines = raw.split(/\r?\n/);
  // Drop trailing empty lines so we can detect missing fields cleanly.
  while (allLines.length > 0 && allLines[allLines.length - 1] === "") {
    allLines.pop();
  }
  if (allLines.length < 4) {
    throw signatureMalformed(
      sourceLabel,
      `expected 4 lines, got ${allLines.length}`,
    );
  }
  const untrustedHeader = allLines[0] ?? "";
  const signatureLine = allLines[1] ?? "";
  const trustedHeader = allLines[2] ?? "";
  const globalLine = allLines[3] ?? "";
  const untrustedPrefix = "untrusted comment: ";
  const trustedPrefix = "trusted comment: ";
  if (!untrustedHeader.startsWith(untrustedPrefix)) {
    throw signatureMalformed(
      sourceLabel,
      "line 1 must start with 'untrusted comment: '",
    );
  }
  if (!trustedHeader.startsWith(trustedPrefix)) {
    throw signatureMalformed(
      sourceLabel,
      "line 3 must start with 'trusted comment: '",
    );
  }
  const untrustedComment = untrustedHeader.slice(untrustedPrefix.length);
  const trustedComment = trustedHeader.slice(trustedPrefix.length);

  const sigPayload = decodeBase64(
    signatureLine,
    sourceLabel,
    "signature payload",
  );
  if (sigPayload.length !== 74) {
    throw signatureMalformed(
      sourceLabel,
      `signature payload length=${sigPayload.length}, expected 74 (2 algo + 8 keyId + 64 sig)`,
    );
  }
  const algoTag = sigPayload.subarray(0, 2).toString("ascii");
  let algorithm: "pure" | "prehashed";
  if (algoTag === "Ed") {
    algorithm = "pure";
  } else if (algoTag === "ED") {
    algorithm = "prehashed";
  } else {
    throw signatureMalformed(
      sourceLabel,
      `unsupported algorithm tag '${algoTag}' (expected 'Ed' or 'ED')`,
    );
  }
  const keyId = sigPayload.subarray(2, 10).toString("hex");
  const signature = new Uint8Array(sigPayload.subarray(10, 74));

  const globalPayload = decodeBase64(
    globalLine,
    sourceLabel,
    "global signature payload",
  );
  if (globalPayload.length !== 64) {
    throw signatureMalformed(
      sourceLabel,
      `global signature length=${globalPayload.length}, expected 64`,
    );
  }
  const globalSignature = new Uint8Array(globalPayload);

  return {
    algorithm,
    keyId,
    signature,
    globalSignature,
    trustedComment,
    untrustedComment,
  };
}

export interface VerifyMinisignArchiveOptions {
  readonly archivePath: string;
  readonly signatureText: string;
  readonly signatureSourceLabel: string;
  readonly trustedKeys: readonly ParsedMinisignPublicKey[];
}

export interface VerifyMinisignArchiveResult {
  readonly keyId: string;
  readonly trustedComment: string;
  readonly algorithm: "pure" | "prehashed";
}

// Verify a detached minisign signature against a local archive on
// disk. Streams the archive through BLAKE2b-512 so we never load the
// full file into memory. Fails closed (HOST_VERIFY_FAILED) if either
// the file or the trusted-comment signature doesn't verify.
export async function verifyMinisignArchive(
  opts: VerifyMinisignArchiveOptions,
): Promise<VerifyMinisignArchiveResult> {
  if (opts.trustedKeys.length === 0) {
    throw cliError({
      code: CLI_ERROR_CODES.HOST_VERIFY_FAILED,
      message:
        "minisign verify: no trusted public keys are configured; set TRAYCER_HOST_TRUSTED_PUBKEYS or populate ~/.traycer/cli/host-trusted-pubkeys",
      details: null,
      exitCode: 1,
    });
  }
  const parsed = parseMinisignSignatureFile(
    opts.signatureText,
    opts.signatureSourceLabel,
  );
  const trustedKey = opts.trustedKeys.find((key) => key.keyId === parsed.keyId);
  if (trustedKey === undefined) {
    throw cliError({
      code: CLI_ERROR_CODES.HOST_VERIFY_FAILED,
      message: `minisign verify: signature key id '${parsed.keyId}' is not in the trusted key set (configured ids: ${opts.trustedKeys.map((k) => k.keyId).join(", ")})`,
      details: { signatureKeyId: parsed.keyId },
      exitCode: 1,
    });
  }
  const publicKey = createPublicKey({
    key: Buffer.concat([
      ED25519_SPKI_PREFIX,
      Buffer.from(trustedKey.publicKey),
    ]),
    format: "der",
    type: "spki",
  });
  let archiveMessage: Buffer;
  if (parsed.algorithm === "prehashed") {
    archiveMessage = await hashFileBlake2b512(opts.archivePath);
  } else {
    // Pure-Ed25519 verifies against the full archive bytes. Gate the
    // memory cost with a clear assertion before we buffer - a hostile
    // multi-GB archive should never silently exhaust the heap.
    const archiveStat = await stat(opts.archivePath);
    if (archiveStat.size > PURE_ALGORITHM_MAX_BYTES) {
      throw cliError({
        code: CLI_ERROR_CODES.HOST_VERIFY_FAILED,
        message: `minisign verify: archive at ${opts.archivePath} is ${archiveStat.size} bytes; refusing to buffer for the pure-Ed25519 algorithm (cap=${PURE_ALGORITHM_MAX_BYTES}). Re-sign with the prehashed algorithm.`,
        details: {
          archiveSize: archiveStat.size,
          cap: PURE_ALGORITHM_MAX_BYTES,
          algorithm: parsed.algorithm,
        },
        exitCode: 1,
      });
    }
    archiveMessage = await readFileBuffer(opts.archivePath);
  }
  const archiveOk = verify(null, archiveMessage, publicKey, parsed.signature);
  if (!archiveOk) {
    throw cliError({
      code: CLI_ERROR_CODES.HOST_VERIFY_FAILED,
      message: `minisign verify: archive signature did not verify against trusted key id '${parsed.keyId}'`,
      details: {
        signatureKeyId: parsed.keyId,
        signatureSource: opts.signatureSourceLabel,
        algorithm: parsed.algorithm,
      },
      exitCode: 1,
    });
  }
  const globalMessage = Buffer.concat([
    Buffer.from(parsed.signature),
    Buffer.from(parsed.trustedComment, "utf8"),
  ]);
  const globalOk = verify(
    null,
    globalMessage,
    publicKey,
    parsed.globalSignature,
  );
  if (!globalOk) {
    throw cliError({
      code: CLI_ERROR_CODES.HOST_VERIFY_FAILED,
      message: `minisign verify: trusted-comment global signature did not verify against trusted key id '${parsed.keyId}'`,
      details: {
        signatureKeyId: parsed.keyId,
        signatureSource: opts.signatureSourceLabel,
      },
      exitCode: 1,
    });
  }
  return {
    keyId: parsed.keyId,
    trustedComment: parsed.trustedComment,
    algorithm: parsed.algorithm,
  };
}

function decodeBase64(
  line: string,
  sourceLabel: string,
  fieldName: string,
): Buffer {
  const trimmed = line.trim();
  if (trimmed.length === 0) {
    throw signatureMalformed(sourceLabel, `${fieldName} line is empty`);
  }
  // Buffer.from with base64 silently drops invalid chars, so do a round-
  // trip check to surface malformed payloads loudly.
  const decoded = Buffer.from(trimmed, "base64");
  const reencoded = decoded.toString("base64");
  // Tolerate trailing padding differences only.
  const stripPad = (s: string): string => s.replace(/=+$/, "");
  if (stripPad(reencoded) !== stripPad(trimmed)) {
    throw signatureMalformed(sourceLabel, `${fieldName} is not valid base64`);
  }
  return decoded;
}

function hashFileBlake2b512(path: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const hash = createHash("blake2b512");
    const stream = createReadStream(path);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest()));
    stream.on("error", (err) => reject(err));
  });
}

function readFileBuffer(path: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    const stream = createReadStream(path);
    stream.on("data", (chunk) => {
      chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
    });
    stream.on("end", () => resolve(Buffer.concat(chunks)));
    stream.on("error", (err) => reject(err));
  });
}

function signatureMalformed(sourceLabel: string, detail: string): Error {
  return cliError({
    code: CLI_ERROR_CODES.HOST_VERIFY_FAILED,
    message: `minisign signature at ${sourceLabel}: ${detail}`,
    details: { sourceLabel, detail },
    exitCode: 1,
  });
}
