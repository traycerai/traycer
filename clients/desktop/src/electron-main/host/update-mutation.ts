import { mkdir, open, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  createUpdateMutationCapabilityAdoption,
  verifyUpdateMutationCapability,
  writeAdoptionProof,
  type UpdateMutationCapability,
} from "@traycer-clients/shared/host-update";
import {
  registerHostLoginItem,
  retireCompetingCliRegistrationAtLaunchGuarded,
  unregisterHostLoginItemGuarded,
  type LaunchCompetingRegistrationRepair,
  type RegisterHostLoginItemResult,
} from "../app/host-login-item";
import {
  hostStopIntentPath,
  type StopIntent,
} from "@traycer/protocol/config/host-stop-intent";
import type { HostServiceSubstrate } from "./host-owner";
import type { HostFsLayout } from "./host-paths";
import { SUBSTRATE_RECORD_WRITE_VERSION } from "@traycer-clients/shared/host-lifecycle";

export class DesktopAttemptCapabilityError extends Error {
  readonly verdict: string;

  constructor(verdict: string) {
    super("desktop update attempt capability is not live");
    this.verdict = verdict;
  }
}

async function requireLiveCapability(
  capability: UpdateMutationCapability,
  hostHomeDir: string,
): Promise<void> {
  const verdict = await verifyUpdateMutationCapability(capability, hostHomeDir);
  if (verdict.kind !== "live") {
    throw new DesktopAttemptCapabilityError(verdict.kind);
  }
}

/** The existing registration function invokes our predicate immediately before its bootout, so a stale capability cannot get as far as the destructive side of the cycle. */
export async function registerHostLoginItemWithAttempt(
  capability: UpdateMutationCapability,
  hostHomeDir: string,
  revalidateBeforeBootout: () => Promise<boolean>,
): Promise<RegisterHostLoginItemResult> {
  await requireLiveCapability(capability, hostHomeDir);
  const result = await registerHostLoginItem(async () => {
    const verdict = await verifyUpdateMutationCapability(
      capability,
      hostHomeDir,
    );
    return verdict.kind === "live" && (await revalidateBeforeBootout());
  });
  await requireLiveCapability(capability, hostHomeDir);
  return result;
}

/** Capability-consuming SMAppService deregistration/bootout. */
export async function unregisterHostLoginItemWithAttempt(
  capability: UpdateMutationCapability,
  hostHomeDir: string,
): Promise<void> {
  await requireLiveCapability(capability, hostHomeDir);
  const ran = await unregisterHostLoginItemGuarded(async () => {
    const verdict = await verifyUpdateMutationCapability(
      capability,
      hostHomeDir,
    );
    return verdict.kind === "live";
  });
  if (!ran) {
    const verdict = await verifyUpdateMutationCapability(
      capability,
      hostHomeDir,
    );
    throw new DesktopAttemptCapabilityError(
      verdict.kind === "live" ? "indeterminate" : verdict.kind,
    );
  }
  await requireLiveCapability(capability, hostHomeDir);
}

const SUBSTRATE_RECORD_VERSION = SUBSTRATE_RECORD_WRITE_VERSION;

/**
 * The record shape and its path both come from `@traycer/protocol/config`, never from a literal here.
 * That module exists precisely because two repos must resolve the same file and agree on the same bytes: the host reads this record with its own parser, and a filename duplicated on.
 */
const STOP_INTENT_VERSION = 1;

export type RestartTombstoneOutcome =
  | { readonly kind: "published" }
  /** The caller MUST NOT boot out: without it the host cannot tell this teardown from death, and every other client fails over on an outage that was going to last seconds. */
  | { readonly kind: "not-published"; readonly cause: string };

const TOMBSTONE_FLUSH_DEADLINE_MS = 5_000;

type FlushOutcome =
  | { readonly kind: "flushed" }
  /** `sync()` rejected - `cause` is the real error, never a fabricated one. */
  | { readonly kind: "rejected"; readonly cause: string }
  /** Still pending at the deadline. The only arm that may claim a timeout. */
  | { readonly kind: "expired" };

/**
 * The losing `sync()` is deliberately left unawaited rather than cancelled.
 * CAVEAT THE CALLER MUST HONOUR, and the reason this is spelled out here: a deadline on the sync alone bounds NOTHING if the caller then awaits `handle.close()`.
 */
async function withFlushDeadline(flush: Promise<void>): Promise<FlushOutcome> {
  let timer: NodeJS.Timeout | null = null;
  const expiry = new Promise<FlushOutcome>((resolve) => {
    timer = setTimeout(
      () => resolve({ kind: "expired" }),
      TOMBSTONE_FLUSH_DEADLINE_MS,
    );
  });
  try {
    return await Promise.race([
      // The handler is attached BEFORE the race, so a rejection that arrives
      // after the deadline already won is still consumed here rather than
      // surfacing as an unhandled rejection.
      flush
        .then((): FlushOutcome => ({ kind: "flushed" }))
        .catch((err: unknown): FlushOutcome => ({
          kind: "rejected",
          cause: describeFlushError(err),
        })),
      expiry,
    ]);
  } finally {
    if (timer !== null) clearTimeout(timer);
  }
}

/** The error's own message, never a substitute for it. */
function describeFlushError(err: unknown): string {
  if (err instanceof Error) {
    const code = Reflect.get(err, "code");
    return typeof code === "string" ? `${code}: ${err.message}` : err.message;
  }
  return String(err);
}

/**
 * Desktop's bootout never has: it goes through `launchctl bootout` and Electron's `setLoginItemSettings`, with no CLI leg to carry the intent.
 * And an unflushed record is indistinguishable from an absent one to the reader, so a write this function could not confirm is reported as `not-published` rather than shrugged off.
 */
export async function publishRestartTombstoneWithAttempt(
  capability: UpdateMutationCapability,
  layout: HostFsLayout,
): Promise<RestartTombstoneOutcome> {
  await requireLiveCapability(capability, layout.rootDir);
  const target = hostStopIntentPath(layout.rootDir);
  const temp = join(
    layout.rootDir,
    `.stop-intent.${process.pid}.${Date.now()}.tmp`,
  );
  // Stamped ONCE, before the write, and reused by the post-flush freshness
  // check so the two cannot drift.
  const requestedAtMs = Date.now();
  try {
    await mkdir(layout.rootDir, { recursive: true });
    const handle = await open(temp, "w", 0o600);
    // Tracks whether the deadline arm already detached the close.
    let closed = false;
    try {
      // Typed against the protocol contract, so a field the host's parser
      // requires cannot be dropped here without a compile error.
      const intent: StopIntent = {
        v: STOP_INTENT_VERSION,
        requestedAt: new Date(requestedAtMs).toISOString(),
        requestedByPid: process.pid,
        reason: "restart",
      };
      await handle.writeFile(`${JSON.stringify(intent)}\n`, "utf8");
      // BOUNDED, and both halves of the bound are load-bearing.
      // - A slow-but-successful sync is just as wrong in the other direction: `requestedAt` was stamped before the flush, so a sync that outlives the reader's freshness window publishes.
      const flush = await withFlushDeadline(handle.sync());
      if (flush.kind !== "flushed") {
        // So the previous shape - race the sync, then `finally { await handle.close() }`.
        // - The freshness re-check and the capability re-check both sit after this return, so a late success cannot re-enter the publish path.
        void handle.close().catch(() => undefined);
        closed = true;
        // Finding 6: this arm returns past the outer `catch`, so it must do
        // its own cleanup or it leaks a `.stop-intent.<pid>.<time>.tmp` on
        // every flush failure - which the reviewer reproduced.
        await rm(temp, { force: true }).catch(() => undefined);
        return {
          kind: "not-published",
          // Only the `expired` arm may claim a timeout. A rejection reports
          // what the filesystem actually said, because this string is what a
          // terminal attempt record persists and an operator reads.
          cause:
            flush.kind === "rejected"
              ? `restart tombstone flush failed: ${flush.cause}`
              : `restart tombstone flush exceeded ${TOMBSTONE_FLUSH_DEADLINE_MS}ms`,
        };
      }
    } finally {
      // Only when the deadline did NOT expire. On the detached arm the handle
      // is already closing and awaiting it here would restore the hold.
      if (!closed) await handle.close();
    }
    // Re-check freshness AFTER the flush resolved.
    // Publishing a marker the reader will discard is worse than not publishing: the caller would treat it as a kept promise and proceed to bootout.
    const ageMs = Math.abs(Date.now() - requestedAtMs);
    if (ageMs > TOMBSTONE_FLUSH_DEADLINE_MS) {
      await rm(temp, { force: true }).catch(() => undefined);
      return {
        kind: "not-published",
        cause: `restart tombstone went stale during flush (${ageMs}ms)`,
      };
    }
    await requireLiveCapability(capability, layout.rootDir);
    await rename(temp, target);
  } catch (err) {
    await rm(temp, { force: true }).catch(() => undefined);
    return {
      kind: "not-published",
      cause: err instanceof Error ? err.message : String(err),
    };
  }
  return { kind: "published" };
}

export async function withMintedAdoption<T>(
  capability: UpdateMutationCapability,
  layout: HostFsLayout,
  run: (adoptionArgs: readonly string[]) => Promise<T>,
): Promise<T> {
  await requireLiveCapability(capability, layout.rootDir);
  const adoption = await createUpdateMutationCapabilityAdoption(
    capability,
    layout.rootDir,
  );
  const proof = await writeAdoptionProof(adoption, layout.rootDir, Date.now());
  try {
    return await run(["--attempt-adoption", proof.nonce]);
  } finally {
    await proof.cancel();
  }
}

export async function clearRestartTombstoneWithAttempt(
  capability: UpdateMutationCapability,
  layout: HostFsLayout,
): Promise<void> {
  await requireLiveCapability(capability, layout.rootDir);
  await rm(hostStopIntentPath(layout.rootDir), { force: true }).catch(
    () => undefined,
  );
}

/**
 * The write is temp+rename so a reader never observes a half-record.
 * Ownership is a durable fact about the machine, so the capability is re-verified immediately before the rename that publishes it and again after.
 */
export async function writeSubstrateOwnerWithAttempt(
  capability: UpdateMutationCapability,
  layout: HostFsLayout,
  active: HostServiceSubstrate,
  reason: string,
): Promise<void> {
  await requireLiveCapability(capability, layout.rootDir);
  const target = layout.substrateFile;
  const temp = join(
    dirname(target),
    `.substrate.${process.pid}.${Date.now()}.tmp`,
  );
  await mkdir(dirname(target), { recursive: true });
  try {
    await writeFile(
      temp,
      `${JSON.stringify({
        v: SUBSTRATE_RECORD_VERSION,
        active,
        since: new Date().toISOString(),
        reason,
        attestation: null,
      })}\n`,
      { encoding: "utf8", mode: 0o600 },
    );
    await requireLiveCapability(capability, layout.rootDir);
    await rename(temp, target);
  } catch (error) {
    await rm(temp, { force: true }).catch(() => undefined);
    throw error;
  }
  await requireLiveCapability(capability, layout.rootDir);
}

/** Capability-consuming launch-time CLI-registration retirement. */
export async function retireCompetingCliRegistrationWithAttempt(
  capability: UpdateMutationCapability,
  hostHomeDir: string,
): Promise<LaunchCompetingRegistrationRepair> {
  await requireLiveCapability(capability, hostHomeDir);
  const result = await retireCompetingCliRegistrationAtLaunchGuarded(
    async () => {
      const verdict = await verifyUpdateMutationCapability(
        capability,
        hostHomeDir,
      );
      return verdict.kind === "live";
    },
  );
  if (result === null) {
    const verdict = await verifyUpdateMutationCapability(
      capability,
      hostHomeDir,
    );
    throw new DesktopAttemptCapabilityError(
      verdict.kind === "live" ? "indeterminate" : verdict.kind,
    );
  }
  await requireLiveCapability(capability, hostHomeDir);
  return result;
}
