import { readFile } from "node:fs/promises";
import { readPidMetadata } from "./host-lifecycle";

/**
 * This machine's durable host identity, read from the two files that can name
 * it. Extracted from `ipc/host-ipc.ts` (the `lastKnownLocalHostId` handler)
 * so the selection authority's fleet port answers "which host is local" from
 * exactly the same source, in the same order, as the renderer's seed - two
 * different answers would put the authority's `local` classification at odds
 * with the renderer's.
 */
export interface LocalHostIdentityFiles {
  readonly identityEnrollmentFile: string;
  readonly pidMetadataFile: string;
}

type EnrollmentRead =
  | { readonly kind: "enrolled"; readonly hostId: string }
  /** No file (ENOENT): a legacy install that predates the enrollment record. */
  | { readonly kind: "absent" }
  /**
   * The record EXISTS but cannot answer - unreadable, unparseable, or missing
   * its `hostId`. Not the same fact as absent: an existing record proves this
   * install HAS enrollment machinery, so its content being momentarily
   * unusable must not hand the decision to a lower-trust source.
   */
  | { readonly kind: "unusable" };

/** The `hostId` from the host's durable enrollment record. */
export async function readEnrolledHostId(
  path: string,
): Promise<EnrollmentRead> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error: unknown) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return { kind: "absent" };
    }
    return { kind: "unusable" };
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object") {
      return { kind: "unusable" };
    }
    const hostId = (parsed as Record<string, unknown>).hostId;
    return typeof hostId === "string" && hostId.length > 0
      ? { kind: "enrolled", hostId }
      : { kind: "unusable" };
  } catch {
    return { kind: "unusable" };
  }
}

/**
 * What this machine's identity files can say about which host lives here.
 *
 * `named` carries the id. The two anonymous cases are DIFFERENT facts and are
 * kept apart because a caller enforcing an identity fence must treat them
 * differently:
 *
 *  - `unverifiable` — the enrollment record EXISTS but cannot answer. This
 *    install has enrollment machinery, so an unreadable record is exactly what
 *    a re-enrollment or a replacement mid-write looks like; a fence that
 *    treats it as "no change" fails open onto whichever host lands next.
 *  - `unenrolled` — nothing on disk names a host at all (no enrollment record,
 *    no pid file): a legacy install that predates the record. There is no
 *    identity machinery here for a replacement to have gone through, so a
 *    fence has nothing to compare and nothing contradicting the caller.
 */
export type LocalHostIdentity =
  | { readonly kind: "named"; readonly hostId: string }
  | { readonly kind: "unverifiable" }
  | { readonly kind: "unenrolled" };

/**
 * The last known local host identity, classified.
 *
 * The ENROLLMENT record decides, and `pid.json` is only the fallback. Which
 * is the reverse of what "the file describing the running host" suggests, and
 * the reversal is the point:
 *
 *  - The launch this seed exists for is a reinstall, where the host is down.
 *    The host unlinks `pid.json` on graceful shutdown, so the live file is
 *    already gone and enrollment is the only thing left that identifies this
 *    machine. Enrollment carries that case either way.
 *  - `pid.json` does NOT survive only while the host runs. An ungraceful stop
 *    leaves it behind, and `readPidMetadata` accepts it structurally - no
 *    liveness or reachability check. Re-enroll while the host is down and that
 *    stale file names the PREVIOUS id, which the renderer would then persist,
 *    neutralize the wrong registry row with, and leave this machine's real
 *    twin remote-kind and relay-dialable: the exact lockout the seed was added
 *    to prevent, reached from the other direction.
 *
 * A running host's `pid.json` agrees with enrollment, so preferring enrollment
 * costs nothing when both answer. The pid fallback is reserved for `absent`
 * alone. An `unusable` record answers `unverifiable` WITHOUT consulting pid:
 * the record existing proves this install enrolls, so its content being
 * unreadable right now must not hand the decision to the very source whose
 * staleness this ordering exists to outrank.
 */
export async function classifyLocalHostIdentity(
  files: LocalHostIdentityFiles,
): Promise<LocalHostIdentity> {
  const enrollment = await readEnrolledHostId(files.identityEnrollmentFile);
  if (enrollment.kind === "enrolled") {
    return { kind: "named", hostId: enrollment.hostId };
  }
  if (enrollment.kind === "unusable") return { kind: "unverifiable" };
  const metadata = await readPidMetadata(files.pidMetadataFile);
  return metadata === null
    ? { kind: "unenrolled" }
    : { kind: "named", hostId: metadata.hostId };
}

/**
 * The last known local `hostId`, or null when nothing on disk can answer.
 * A projection of `classifyLocalHostIdentity` for the callers (the renderer
 * seed, the fleet port) that only need the id — the same source in the same
 * order, so the two can never disagree about which host is local.
 */
export async function readLastKnownLocalHostId(
  files: LocalHostIdentityFiles,
): Promise<string | null> {
  const identity = await classifyLocalHostIdentity(files);
  return identity.kind === "named" ? identity.hostId : null;
}
