/**
 * Last validated user, renderer-local, so boot can paint before `validateAuthTokenIdentity`.
 * Adopt only a protocol-schema parse whose `schemaVersion` and user id match; otherwise fall through to live validation.
 */

import { z } from "zod";
import { authenticatedUserResponseRecordV100 } from "@traycer/protocol/auth/registry";
import type { AuthenticatedUser } from "@traycer/protocol/auth";
import type { ISecureStorage } from "@traycer-clients/shared/platform/runner-host";
import { appLogger, describeLogError } from "@/lib/logger";

const SNAPSHOT_KEY = "traycer.auth.provisionalSession.v1";

const RECORD = authenticatedUserResponseRecordV100;

/**
 * The envelope, validated separately from its payload so the two refusals stay distinguishable: an old-schema snapshot is expected housekeeping, a payload that fails the protocol's schema at the CURRENT version is not, and they are logged at different levels.
 */
const snapshotEnvelopeSchema = z.object({
  schemaVersion: z.object({ major: z.number(), minor: z.number() }),
  userId: z.string(),
  user: z.unknown(),
});

/** What {@link writeProvisionalSessionSnapshot} emits - the schema's mirror. */
interface PersistedSnapshot {
  readonly schemaVersion: { readonly major: number; readonly minor: number };
  readonly userId: string;
  readonly user: unknown;
}

/**
 * The last validated user for `expectedUserId`, or `null` when there is no usable snapshot - which the caller must read as "await the cloud verdict, as before", never as "signed out".
 */
export async function readProvisionalSessionSnapshot(
  storage: ISecureStorage,
  expectedUserId: string,
): Promise<AuthenticatedUser | null> {
  let raw: string | null;
  try {
    raw = await storage.get(SNAPSHOT_KEY);
  } catch (error) {
    // An unreadable store is not a signed-out user. Fall through to the
    // awaited path and leave the credentials file to say what it says.
    appLogger.warn("[auth] provisional session snapshot unreadable", {
      error: describeLogError(error),
    });
    return null;
  }
  // THE ONLY SILENT RETURN in this function - every other refusal below logs.
  // So if a boot is taking the awaited path with no line in the console, this is where it went, and the question is whether the slot is genuinely empty or whether the storage adapter LOST a value it holds.
  if (raw === null || raw.length === 0) return null;

  let decoded: unknown;
  try {
    decoded = JSON.parse(raw);
  } catch {
    appLogger.warn("[auth] provisional session snapshot is not JSON", {});
    return null;
  }
  const envelope = snapshotEnvelopeSchema.safeParse(decoded);
  if (!envelope.success) {
    appLogger.warn("[auth] provisional session snapshot has no envelope", {});
    return null;
  }
  const parsed = envelope.data;
  if (
    parsed.schemaVersion.major !== RECORD.schemaVersion.major ||
    parsed.schemaVersion.minor !== RECORD.schemaVersion.minor
  ) {
    // Written by a build whose `AuthenticatedUser` was a different shape.
    appLogger.info(
      "[auth] provisional session snapshot is from an older schema",
      {
        snapshot: `${parsed.schemaVersion.major}.${parsed.schemaVersion.minor}`,
        current: `${RECORD.schemaVersion.major}.${RECORD.schemaVersion.minor}`,
      },
    );
    return null;
  }
  if (parsed.userId !== expectedUserId) {
    // A different account owns the credentials on this machine now.
    appLogger.info(
      "[auth] provisional session snapshot names another user",
      {},
    );
    return null;
  }

  const user = RECORD.schema.safeParse(parsed.user);
  if (!user.success) {
    appLogger.warn("[auth] provisional session snapshot failed validation", {});
    return null;
  }
  // The PAYLOAD's own id, against the credentials file - not against the envelope.
  // Read together with the envelope check above it is transitively both (that one already established `parsed.userId === expectedUserId`), but the comparison written here is the one that matters: it is what makes a snapshot whose envelope was hand-edited to.
  if (user.data.user.id !== expectedUserId) {
    appLogger.warn(
      "[auth] provisional session snapshot envelope disagrees",
      {},
    );
    return null;
  }
  return user.data;
}

/**
 * Records `user` as the last validated identity.
 * Called from every path that establishes a session, so the snapshot is never older than the credentials beside it.
 */
export async function writeProvisionalSessionSnapshot(
  storage: ISecureStorage,
  user: AuthenticatedUser,
): Promise<void> {
  const payload: PersistedSnapshot = {
    schemaVersion: RECORD.schemaVersion,
    userId: user.user.id,
    user,
  };
  try {
    await storage.set(SNAPSHOT_KEY, JSON.stringify(payload));
  } catch (error) {
    appLogger.warn("[auth] provisional session snapshot write failed", {
      error: describeLogError(error),
    });
  }
}

/** Drops the snapshot on sign-out. Never throws, for the same reason. */
export async function clearProvisionalSessionSnapshot(
  storage: ISecureStorage,
): Promise<void> {
  try {
    await storage.delete(SNAPSHOT_KEY);
  } catch (error) {
    appLogger.warn("[auth] provisional session snapshot clear failed", {
      error: describeLogError(error),
    });
  }
}
