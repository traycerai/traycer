import { stat } from "node:fs/promises";
import { hashFileSha256 } from "../installer/sha256";
import { CLI_ERROR_CODES, cliError } from "../runner/errors";
import { verifyMinisignArchive } from "./minisign";
import type { ParsedMinisignPublicKey } from "./trusted-keys";

// Both acquisition paths prove the bytes on disk before extraction. This does
// not own the file: a bundle stays application-owned, a download stays cached.
export async function verifyLocalAsset(opts: {
  readonly archivePath: string;
  readonly sizeBytes: number;
  readonly sha256: string;
  readonly publicKeyId: string;
  readonly signatureText: string;
  readonly signatureSourceLabel: string;
  readonly trustedKeys: readonly ParsedMinisignPublicKey[];
}): Promise<{
  readonly archiveSha256: string;
  readonly signatureKeyId: string;
  readonly signatureVerifiedAt: string;
}> {
  const size = (await stat(opts.archivePath)).size;
  const digest = await hashFileSha256(opts.archivePath, null);
  if (size !== opts.sizeBytes || digest !== opts.sha256.toLowerCase()) {
    throw cliError({
      code: CLI_ERROR_CODES.HOST_VERIFY_FAILED,
      message: "host archive: size or sha256 does not match the signed asset",
      details: { archivePath: opts.archivePath },
      exitCode: 1,
    });
  }
  const verified = await verifyMinisignArchive(opts);
  if (verified.keyId.toLowerCase() !== opts.publicKeyId.toLowerCase()) {
    throw cliError({
      code: CLI_ERROR_CODES.HOST_VERIFY_FAILED,
      message: "host archive: signature key id does not match publicKeyId",
      details: {
        signatureKeyId: verified.keyId,
        publicKeyId: opts.publicKeyId,
      },
      exitCode: 1,
    });
  }
  return {
    archiveSha256: digest,
    signatureKeyId: verified.keyId,
    signatureVerifiedAt: new Date().toISOString(),
  };
}
