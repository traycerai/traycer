import { app, safeStorage } from "electron";
import {
  createPrivateKey,
  generateKeyPairSync,
  sign as cryptoSign,
} from "node:crypto";
import { randomUUID } from "node:crypto";
import { stat } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { canonicalDesktopIdentityAttestBytes } from "@traycer/protocol/host/browser/contracts";
import { describeLogError, log } from "../../app/logger";
import {
  createJsonFileStore,
  type StrictJsonFileStore,
} from "../../app/json-file-store";
import { isKeystoreEncrypting } from "./browser-saved-logins";

/** The private key never leaves this process: the renderer gets one IPC method that returns a signature, never a key. */
const DESKTOP_IDENTITY_FILE_NAME = "browser-desktop-identity.json";

const recordSchema = z.strictObject({
  version: z.literal(1),
  keystoreId: z.string(),
  /** Ed25519 SPKI DER, base64 - what goes on the wire. */
  publicKey: z.string(),
  /** `safeStorage.encryptString(pkcs8 der base64)`, base64. */
  wrappedPrivateKey: z.string(),
  encrypted: z.boolean().default(true),
});
type DesktopIdentityRecord = z.infer<typeof recordSchema>;

/** What the host's `desktopIdentityAttest` frame carries. */
export type DesktopIdentityAttestation = {
  readonly publicKey: string;
  readonly keystoreId: string;
  readonly signature: string;
  /** It is CLIENT-DECLARED and can only ever downgrade the declarer: the host reads it as an extra condition on the jar grant, never as one that grants anything. */
  readonly jarEligible: boolean;
};

let store: StrictJsonFileStore<DesktopIdentityRecord | null> | null = null;
let identity: Promise<DesktopIdentityRecord | null> | null = null;

export function browserDesktopIdentityFilePath(): string {
  return join(app.getPath("userData"), DESKTOP_IDENTITY_FILE_NAME);
}

/**
 * See {@link mintIdentity} for why the question cannot be answered from `load()`.
 * Any other errno means the path is there and this process could not look at it, which is not a reason to mint over it, so it answers `true` and fails closed.
 */
async function identityFileExists(): Promise<boolean> {
  try {
    await stat(browserDesktopIdentityFilePath());
    return true;
  } catch (cause) {
    const code: unknown =
      typeof cause === "object" && cause !== null && "code" in cause
        ? (cause as { readonly code: unknown }).code
        : null;
    return code !== "ENOENT";
  }
}

function identityStore(): StrictJsonFileStore<DesktopIdentityRecord | null> {
  store ??= createJsonFileStore<DesktopIdentityRecord | null>(
    browserDesktopIdentityFilePath(),
    null,
    (value) => recordSchema.safeParse(value).data ?? null,
  );
  return store;
}

/** `null` whenever this machine cannot hold a private key safely - the refusal and the wrap refusal are one cause, so there is no second rule to keep in step. */
function loadOrMintIdentity(): Promise<DesktopIdentityRecord | null> {
  identity ??= mintIdentity().then(
    (record) => {
      if (record === null) identity = null;
      return record;
    },
    (cause: unknown) => {
      identity = null;
      throw cause;
    },
  );
  return identity;
}

/** What the plaintext key buys is exactly placement; the attestation says `jarEligible: false`, so the host still never hands it the encrypted slice. */
async function mintIdentity(): Promise<DesktopIdentityRecord | null> {
  const existing = await identityStore().load();
  if (existing !== null) return existing;
  // `load()` cannot tell "no identity yet" from "the identity file could not be read": `createJsonFileStore.load()` catches every error and answers the fallback.
  // Minting on that answer would write a NEW keypair over an existing one on a transient EACCES/EBUSY/EMFILE, and every host that had pinned the old public key would then refuse this.
  if (await identityFileExists()) {
    log.warn(
      "[browser-view] a desktop identity file exists but could not be read; refusing to mint over it",
    );
    return null;
  }
  const encrypted = isKeystoreEncrypting();
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const pkcs8Base64 = privateKey
    .export({ format: "der", type: "pkcs8" })
    .toString("base64");
  const wrappedPrivateKey = encrypted
    ? wrapPrivateKey(pkcs8Base64)
    : pkcs8Base64;
  if (wrappedPrivateKey === null) return null;
  if (!encrypted) {
    log.warn(
      "[browser-view] minting a desktop identity with its key in the clear: this machine's keystore does not encrypt",
    );
  }
  const record: DesktopIdentityRecord = {
    version: 1,
    keystoreId: randomUUID(),
    publicKey: publicKey
      .export({ format: "der", type: "spki" })
      .toString("base64"),
    wrappedPrivateKey,
    encrypted,
  };
  // Durable first: an identity that attested but was never written would be
  // re-minted on the next launch, and the host would refuse the new key over
  // the relay for the rest of that host's life.
  await identityStore().saveStrict(record);
  log.info("[browser-view] minted this installation's browser identity");
  return record;
}

function wrapPrivateKey(pkcs8Base64: string): string | null {
  try {
    return safeStorage.encryptString(pkcs8Base64).toString("base64");
  } catch (error) {
    log.warn("[browser-view] desktop identity key wrap failed", {
      error: describeLogError(error),
    });
    return null;
  }
}

export async function attestDesktopIdentity(input: {
  readonly hostId: string;
  readonly nonce: string;
}): Promise<DesktopIdentityAttestation | null> {
  const record = await loadOrMintIdentity();
  if (record === null) return null;
  try {
    const pkcs8Base64 = record.encrypted
      ? safeStorage.decryptString(
          Buffer.from(record.wrappedPrivateKey, "base64"),
        )
      : record.wrappedPrivateKey;
    const signature = cryptoSign(
      null,
      canonicalDesktopIdentityAttestBytes({
        hostId: input.hostId,
        nonce: input.nonce,
        publicKey: record.publicKey,
      }),
      createPrivateKey({
        key: Buffer.from(pkcs8Base64, "base64"),
        format: "der",
        type: "pkcs8",
      }),
    ).toString("base64");
    return {
      publicKey: record.publicKey,
      keystoreId: record.keystoreId,
      signature,
      jarEligible: record.encrypted,
    };
  } catch (error) {
    log.warn("[browser-view] desktop identity attestation failed", {
      error: describeLogError(error),
    });
    return null;
  }
}

/** TEST-TEARDOWN ONLY: the memo above is module-global state. */
export function resetDesktopIdentityForTests(): void {
  store = null;
  identity = null;
}
