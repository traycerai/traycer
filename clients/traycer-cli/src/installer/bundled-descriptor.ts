import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod";
import { config } from "../config";
import { currentHostPlatformKey } from "../registry/platform-key";
import { loadTrustedKeys } from "../registry/trusted-keys";
import { verifyMinisignArchive } from "../registry/minisign";
import { verifyLocalAsset } from "../registry/verify-local-asset";
import {
  evaluateHostClientFloor,
  hostClientFloorRefusalMessage,
  isHostClientFloorRefusal,
} from "../registry/client-floor";
import { resolveCliVersion } from "../cli-version";
import { CLI_ERROR_CODES, CliError, cliError } from "../runner/errors";

const descriptorSchema = z
  .object({
    version: z.string().min(1),
    platformKey: z.enum([
      "darwin-arm64",
      "darwin-x64",
      "linux-arm64",
      "linux-x64",
      "win32-x64",
      "win32-arm64",
    ]),
    sha256: z.string().regex(/^[a-f0-9]{64}$/i),
    sizeBytes: z.number().int().positive().safe(),
    publicKeyId: z.string().regex(/^[a-f0-9]{16}$/i),
    requiredCliVersion: z.string().min(1).nullable(),
    minimumEpoch: z.number().int().positive().safe().nullable(),
    storeFormats: z.object({ chatDb: z.number().int().positive().safe() }),
    canonicalUrl: z.string().url(),
  })
  .strict();

export type BundledHostDescriptor = z.infer<typeof descriptorSchema>;

export async function readBundledHostDescriptor(
  archivePath: string,
): Promise<BundledHostDescriptor> {
  const platformKey = currentHostPlatformKey();
  const descriptorPath = join(
    dirname(archivePath),
    `host-runtime-${platformKey}.descriptor.json`,
  );
  try {
    const trusted = await loadTrustedKeys();
    const signature = await verifyMinisignArchive({
      archivePath: descriptorPath,
      signatureText: await readFile(`${descriptorPath}.minisig`, "utf8"),
      signatureSourceLabel: `${descriptorPath}.minisig`,
      trustedKeys: trusted.keys,
    });
    const raw: unknown = JSON.parse(await readFile(descriptorPath, "utf8"));
    const descriptor = descriptorSchema.parse(raw);
    if (
      descriptor.publicKeyId.toLowerCase() !== signature.keyId.toLowerCase()
    ) {
      throw new Error("publicKeyId does not match descriptor signature");
    }
    if (descriptor.platformKey !== platformKey)
      throw new Error("platformKey does not match this platform");
    if (
      config.supportedHostVersion !== null &&
      descriptor.version !== config.supportedHostVersion
    ) {
      throw new Error("version does not match the bundled CLI host pin");
    }
    return descriptor;
  } catch (cause) {
    throw cliError({
      code: CLI_ERROR_CODES.HOST_VERIFY_FAILED,
      message: `bundled host descriptor: ${cause instanceof Error ? cause.message : String(cause)}`,
      details: { descriptorPath },
      exitCode: 1,
    });
  }
}

export async function verifyBundledHostArchive(
  archivePath: string,
  descriptor: BundledHostDescriptor,
): Promise<{
  readonly archiveSha256: string;
  readonly signatureKeyId: string;
  readonly signatureVerifiedAt: string;
}> {
  const floor = evaluateHostClientFloor({
    cliVersion: resolveCliVersion(process.env),
    requiredCliVersion: descriptor.requiredCliVersion,
  });
  if (isHostClientFloorRefusal(floor)) {
    throw cliError({
      code: CLI_ERROR_CODES.HOST_CLIENT_FLOOR_UNMET,
      message: hostClientFloorRefusalMessage(floor, descriptor.version),
      details: null,
      exitCode: 1,
    });
  }
  try {
    const trusted = await loadTrustedKeys();
    return await verifyLocalAsset({
      archivePath,
      ...descriptor,
      signatureText: await readFile(`${archivePath}.minisig`, "utf8"),
      signatureSourceLabel: `${archivePath}.minisig`,
      trustedKeys: trusted.keys,
    });
  } catch (cause) {
    if (cause instanceof CliError) throw cause;
    throw cliError({
      code: CLI_ERROR_CODES.HOST_VERIFY_FAILED,
      message: `bundled host archive: ${cause instanceof Error ? cause.message : String(cause)}`,
      details: { archivePath },
      exitCode: 1,
    });
  }
}
