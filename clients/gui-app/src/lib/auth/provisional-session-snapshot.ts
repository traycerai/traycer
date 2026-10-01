/**
 * The last VALIDATED user, cached beside the credentials so boot can paint
 * before it validates.
 *
 * `AuthService.start()` used to await `validateAuthTokenIdentity` - a cloud
 * round trip - before a session existed, and the app shell renders
 * `HostRuntimeBootFallback` until it does. That was 616 ms of the 968 ms to
 * first paint on a LAN, and a cold launch measured 8.0 s when the authn
 * service answered 700 ms late. The token store holds the bearer, but
 * `applySignedIn` needs an `AuthenticatedUser`, and the credentials file's own
 * `user` block is only `{ id, email, name }` - not enough, and widening it is
 * not an option: that file is parsed by the CLI, the desktop main process and
 * the HOST, and its reader treats a payload that fails the shape check as "no
 * session at all".
 *
 * So the snapshot lives here instead: renderer-local, in the shell's encrypted
 * storage, read by nothing but `AuthService`.
 *
 * ## Fail closed, and let the protocol say when
 *
 * A malformed or stale-shaped payload reaching `applySignedIn` would produce
 * `undefined` reads INSIDE a signed-in session, which is the worst failure
 * available on this path. Three things prevent it, and none of them is a
 * hand-maintained field list:
 *
 * 1. The validator is the protocol's OWN schema for this type
 *    (`authenticatedUserResponseRecordV100.schema`) - the same one a frozen
 *    `/api/v3/user` response is parsed with. What reaches `applySignedIn` is
 *    the PARSED, then UPGRADED value, never the raw JSON.
 * 2. The stamp is the protocol's own `schemaVersion` for the MAJOR-1 record,
 *    so a minor bump inside major 1 still invalidates every snapshot an older
 *    build wrote. There is deliberately no constant here to remember to bump:
 *    the version that matters is the one the record already carries.
 * 3. The snapshot names the user it describes, and the caller only accepts it
 *    when that id matches the credentials file's. That is also what retires a
 *    snapshot belonging to an account the CLI has since replaced on this
 *    machine - the stale one is simply never adopted, and the next
 *    `applySignedIn` overwrites it.
 *
 * Every refusal falls through to today's awaited validation. The worst case is
 * a boot exactly as slow as it is now, never a session built from a payload
 * nobody checked.
 *
 * ## Why this file is pinned to record major 1
 *
 * `AuthenticatedUser` is at major 2 (`APPLE`), but the snapshot deliberately
 * does NOT follow it. The RELEASED reader rejects any stamp other than 1.0
 * before it parses anything, and both builds write the same storage key - so
 * a major-2 snapshot would cost every user who downgrades the desktop app
 * their offline bootstrap, not only the Apple ones. Instead the value is
 * downgraded through the registry's bridge on the way in and upgraded back on
 * the way out. Nothing offline needs to tell an Apple account from an email
 * one, so the bridge's `APPLE` -> `EMAIL` stand-in costs this file nothing.
 */

import { z } from "zod";
import {
  authenticatedUserResponseRecordV100,
  authRecordRegistry,
} from "@traycer/protocol/auth/registry";
import {
  downgradeRecordAcrossMajors,
  getLatestRecordContract,
  loadRecord,
} from "@traycer/protocol/framework/index";
import type { AuthenticatedUser } from "@traycer/protocol/auth";
import type { ISecureStorage } from "@traycer-clients/shared/platform/runner-host";
import { appLogger, describeLogError } from "@/lib/logger";

const SNAPSHOT_KEY = "traycer.auth.provisionalSession.v1";

/** The version this file persists at, and the only stamp it accepts. */
const RECORD = authenticatedUserResponseRecordV100;

const RECORD_REGISTRY = authRecordRegistry["authenticated-user-response"];

/**
 * Read off the registry rather than restated, so the two majors this file
 * bridges between move with the protocol instead of with a literal here.
 */
const LATEST_RECORD_MAJOR = getLatestRecordContract(RECORD_REGISTRY, undefined)
  .schemaVersion.major;

/**
 * The envelope, validated separately from its payload so the two refusals stay
 * distinguishable: an old-schema snapshot is expected housekeeping, a payload
 * that fails the protocol's schema at the CURRENT version is not, and they are
 * logged at different levels for that reason. `user` rides through as
 * `unknown` and is validated below by the only thing entitled to judge it.
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
 * The last validated user for `expectedUserId`, or `null` when there is no
 * usable snapshot - which the caller must read as "await the cloud verdict, as
 * before", never as "signed out".
 *
 * `expectedUserId` is the id the CREDENTIALS FILE names. Passing it is what
 * makes this safe across accounts: a snapshot left by a different user (the
 * CLI signed a new one in on this machine) fails the comparison and is never
 * adopted.
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
  // So if a boot is taking the awaited path with no line in the console, this
  // is where it went, and the question is whether the slot is genuinely empty
  // or whether the storage adapter LOST a value it holds.
  //
  // It has happened: the desktop adapter's encrypt-storage back-end parses
  // JSON on read by default, so this envelope came back as an object and was
  // reported as `null` for every launch. Nothing in this package could catch
  // it - `MockRunnerHost.secureStorageEntries` is a `Map`, which honours the
  // string contract by construction. `clients/desktop/src/renderer-shell/
  // __tests__/secure-local-storage.test.ts` is what guards it now, against
  // the real module.
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

  // Parsed against the stamped major-1 schema and then migrated forward
  // through the registry's upgrade chain, so what leaves here is the same
  // latest-major shape a live validation produces. `loadRecord` throws on a
  // payload the historical schema refuses, which is the refusal this branch
  // has always reported.
  let user: AuthenticatedUser;
  try {
    user = loadRecord(
      authRecordRegistry,
      "authenticated-user-response",
      parsed.user,
      RECORD.schemaVersion,
    );
  } catch {
    appLogger.warn("[auth] provisional session snapshot failed validation", {});
    return null;
  }
  // The PAYLOAD's own id, against the credentials file - not against the
  // envelope. Read together with the envelope check above it is transitively
  // both (that one already established `parsed.userId === expectedUserId`),
  // but the comparison written here is the one that matters: it is what makes
  // a snapshot whose envelope was hand-edited to match unable to hand back a
  // different user than the one it claims.
  if (user.user.id !== expectedUserId) {
    appLogger.warn(
      "[auth] provisional session snapshot envelope disagrees",
      {},
    );
    return null;
  }
  return user;
}

/**
 * Records `user` as the last validated identity. Called from every path that
 * establishes a session, so the snapshot is never older than the credentials
 * beside it.
 *
 * The value is DOWNGRADED to major 1 first - see the file header. The bridge
 * re-parses through the frozen schema, so what lands in storage is exactly
 * what a released build's reader would accept, rather than a latest-major
 * value wearing a 1.0 stamp.
 *
 * Never throws: failing to cache an identity must not fail the sign-in that
 * produced it. The cost of a lost write is one slow boot.
 */
export async function writeProvisionalSessionSnapshot(
  storage: ISecureStorage,
  user: AuthenticatedUser,
): Promise<void> {
  const downgraded = downgradeRecordAcrossMajors(
    RECORD_REGISTRY,
    LATEST_RECORD_MAJOR,
    RECORD.schemaVersion.major,
    user,
  );
  if (!downgraded.ok) {
    // Unreachable today - major 2's only addition maps onto `EMAIL` - but a
    // later major may hold something major 1 genuinely cannot say. CLEARING
    // rather than leaving the previous snapshot in place is deliberate: a
    // skipped write would leave a snapshot for this same user id describing
    // an OLDER session, and the one invariant this file has is that the
    // snapshot is never older than the credentials beside it.
    appLogger.warn("[auth] provisional session snapshot cannot be downgraded", {
      code: downgraded.error.code,
    });
    await clearProvisionalSessionSnapshot(storage);
    return;
  }
  const payload: PersistedSnapshot = {
    schemaVersion: RECORD.schemaVersion,
    userId: downgraded.value.user.id,
    user: downgraded.value,
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
