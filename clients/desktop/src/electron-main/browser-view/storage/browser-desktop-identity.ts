import { app, safeStorage } from "electron";
import {
  createPrivateKey,
  generateKeyPairSync,
  sign as cryptoSign,
} from "node:crypto";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { z } from "zod";
import { canonicalDesktopIdentityAttestBytes } from "@traycer/protocol/host/browser/contracts";
import { describeLogError, log } from "../../app/logger";
import {
  createJsonFileStore,
  type StrictJsonFileStore,
} from "../../app/json-file-store";
import { isKeystoreEncrypting } from "./browser-saved-logins";

/**
 * This installation's browser identity (browser-security-hardening H09): one
 * Ed25519 keypair whose private half `safeStorage` wraps, and which is the
 * whole basis on which a host decides that the connection in front of it is a
 * master-jar desktop rather than a script holding the CLI credentials file.
 *
 * The private key never leaves this process: the renderer gets one IPC method
 * that returns a signature, never a key. After H10 moves the jar plane into
 * main, even that hop disappears.
 *
 * Minted lazily, on the first challenge, and refused outright when the
 * platform keystore does not actually encrypt - a machine whose keystore is
 * plaintext gets no identity, attests nothing, and leaves the host sealed,
 * which is the same answer the store-key wrap gives for the same cause.
 */
const DESKTOP_IDENTITY_FILE_NAME = "browser-desktop-identity.json";

const recordSchema = z.strictObject({
  version: z.literal(1),
  /**
   * A stable label for this install's keystore slot. It is NOT signed: the host
   * uses it only to replace this machine's entry during a `local-ws`
   * enrollment, a lane that already requires a socket on the host's machine.
   */
  keystoreId: z.string(),
  /** Ed25519 SPKI DER, base64 - what goes on the wire. */
  publicKey: z.string(),
  /** `safeStorage.encryptString(pkcs8 der base64)`, base64. */
  wrappedPrivateKey: z.string(),
});
type DesktopIdentityRecord = z.infer<typeof recordSchema>;

/** What the host's `desktopIdentityAttest` frame carries. */
export type DesktopIdentityAttestation = {
  readonly publicKey: string;
  readonly keystoreId: string;
  readonly signature: string;
};

let store: StrictJsonFileStore<DesktopIdentityRecord | null> | null = null;
/**
 * The load, memoised as a PROMISE rather than as its result: two hosts - a
 * co-located one and a relay one - can challenge this desktop in the same tick,
 * and memoising only the settled record would let both find nothing, both mint,
 * and the second write win. Each host would then hold a different key for one
 * machine, and the loser would be refused over the relay for good.
 */
let identity: Promise<DesktopIdentityRecord | null> | null = null;

export function browserDesktopIdentityFilePath(): string {
  return join(app.getPath("userData"), DESKTOP_IDENTITY_FILE_NAME);
}

function identityStore(): StrictJsonFileStore<DesktopIdentityRecord | null> {
  store ??= createJsonFileStore<DesktopIdentityRecord | null>(
    browserDesktopIdentityFilePath(),
    null,
    (value) => recordSchema.safeParse(value).data ?? null,
  );
  return store;
}

/**
 * The record on disk, minting one on first use. `null` whenever this machine
 * cannot hold a private key safely - the refusal and the wrap refusal are one
 * cause, so there is no second rule to keep in step.
 */
function loadOrMintIdentity(): Promise<DesktopIdentityRecord | null> {
  // A refusal is not memoised: `identity` is only ever set to a mint that got
  // as far as running, and a null answer clears it so a later challenge on a
  // machine whose keystore has come back can still mint.
  identity ??= mintIdentity().then((record) => {
    if (record === null) identity = null;
    return record;
  });
  return identity;
}

async function mintIdentity(): Promise<DesktopIdentityRecord | null> {
  if (!isKeystoreEncrypting()) {
    log.warn(
      "[browser-view] refusing to mint a desktop identity: this machine's keystore does not encrypt",
    );
    return null;
  }
  const existing = await identityStore().load();
  if (existing !== null) return existing;
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const wrappedPrivateKey = wrapPrivateKey(
    privateKey.export({ format: "der", type: "pkcs8" }).toString("base64"),
  );
  if (wrappedPrivateKey === null) return null;
  const record: DesktopIdentityRecord = {
    version: 1,
    keystoreId: randomUUID(),
    publicKey: publicKey
      .export({ format: "der", type: "spki" })
      .toString("base64"),
    wrappedPrivateKey,
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

/**
 * Answers one `desktopIdentityChallenge`. `null` means this machine has no
 * identity and will not get one - the host then leaves this connection off the
 * jar plane, and everything else about the session keeps working.
 */
export async function attestDesktopIdentity(input: {
  readonly hostId: string;
  readonly nonce: string;
}): Promise<DesktopIdentityAttestation | null> {
  const record = await loadOrMintIdentity();
  if (record === null) return null;
  try {
    const pkcs8Base64 = safeStorage.decryptString(
      Buffer.from(record.wrappedPrivateKey, "base64"),
    );
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
