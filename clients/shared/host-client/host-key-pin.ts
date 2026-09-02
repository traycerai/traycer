import type { HostListItem } from "@traycer/protocol/host/host-status";

/**
 * Trust-on-first-use pinning of a host's Noise static key
 * (browser-security-hardening H11).
 *
 * The key a client runs its Noise-NK handshake against is whatever
 * `GET /api/v3/hosts` said it is. That makes the control plane a MITM position
 * by construction: a compromised (or compelled) registry can answer with its
 * own key, terminate the E2E channel, and read every RPC and stream the client
 * believed only its host could see. Nothing in the transport can notice - the
 * handshake succeeds, because it succeeds against whatever key it was handed.
 *
 * The deterministic upgrade is to remember the FIRST key seen for a `hostId`
 * and refuse a later different one. It does not protect the first sight of a
 * host - nothing local can - but it turns a silent, repeatable interception
 * into a one-shot that has to win the enrolment race and is visible forever
 * after.
 *
 * Placement: this runs where the key ENTERS the client, in the registry read,
 * rather than at the handshake. Every consumer - the renderer's directory, the
 * desktop's own browser-sessions transport - takes its key from that one read,
 * so one gate here covers all of them, and a refused host never reaches a
 * surface that could offer to dial it.
 */

/** The store a shell backs the pins with; see `installHostKeyPinStore`. */
export interface HostKeyPinStore {
  /** The key pinned for `hostId`, or `null` when this host has never been seen. */
  read(hostId: string): Promise<string | null>;
  /** Records `publicKey` as `hostId`'s pin. First sight only. */
  pin(hostId: string, publicKey: string): Promise<void>;
  /**
   * Where the pins live, for the recovery instruction. There is no UI for
   * un-pinning a host and this deliberately does not invent one: a key change
   * is either a host that was rebuilt or an interception, and only the person
   * can tell those apart. The honest remedy is to delete the record by hand.
   */
  describeLocation(): string;
}

/**
 * A host answered with a different static key than the one this client pinned.
 *
 * Carries the host it names and both keys - a public key is public, and the
 * pair is exactly what a person needs to decide whether they rebuilt that
 * machine or someone is standing in the middle of it.
 */
export class HostKeyPinMismatchError extends Error {
  readonly hostId: string;
  readonly pinnedKey: string;
  readonly offeredKey: string;

  constructor(input: {
    readonly hostId: string;
    readonly pinnedKey: string;
    readonly offeredKey: string;
    readonly pinLocation: string;
  }) {
    super(
      `Host ${input.hostId} presented Noise static key ${input.offeredKey} where ${input.pinnedKey} was pinned. ` +
        `The host is being refused rather than dialed. If you rebuilt or re-enrolled that machine, remove its entry from ${input.pinLocation} and reconnect; ` +
        `if you did not, the key change is not the host's.`,
    );
    this.name = "HostKeyPinMismatchError";
    this.hostId = input.hostId;
    this.pinnedKey = input.pinnedKey;
    this.offeredKey = input.offeredKey;
  }
}

interface InstalledPinning {
  readonly store: HostKeyPinStore;
  readonly onMismatch: (error: HostKeyPinMismatchError) => void;
  /**
   * A first-sight pin the store could not write. Reported rather than thrown,
   * because the caller is a registry read whose contract is a `{ kind }` union
   * and one unwritable pin must not fail every host in the answer.
   */
  readonly onPinWriteFailed: (hostId: string, cause: unknown) => void;
}

let installed: InstalledPinning | null = null;

/**
 * Backs pinning with a shell's durable store. Until a shell installs one,
 * {@link applyHostKeyPins} is a pass-through: a shell with nowhere durable to
 * write (a browser dev shell) cannot pin, and pretending otherwise in memory
 * would give a security answer that resets on every reload.
 */
export function installHostKeyPinStore(pinning: InstalledPinning): void {
  installed = pinning;
}

/** Drops the installed store. Test seam. */
export function clearHostKeyPinStore(): void {
  installed = null;
}

/**
 * The rows of a registry answer this client is willing to act on.
 *
 * A host whose key changed is REMOVED rather than flagged: the whole point is
 * that no consumer may dial it, and every consumer downstream of here reads
 * the list, not a flag. It reappears the moment the registry answers with the
 * pinned key again, or once the person removes the pin.
 */
export async function applyHostKeyPins(
  hosts: readonly HostListItem[],
): Promise<HostListItem[]> {
  const pinning = installed;
  if (pinning === null) {
    return [...hosts];
  }
  const admitted: HostListItem[] = [];
  for (const host of hosts) {
    // A READ that fails is not the same as a write that fails, and it is the
    // one direction that must not admit: something may be pinned and this
    // process cannot see it, so admitting would accept a changed key on the
    // strength of not having looked. Refused per host rather than thrown,
    // because the caller's contract is a `{ kind }` union and a rejection here
    // failed the whole registry read.
    let pinned: string | null;
    try {
      pinned = await pinning.store.read(host.hostId);
    } catch (cause) {
      pinning.onPinWriteFailed(host.hostId, cause);
      continue;
    }
    if (pinned === null) {
      // A first-sight pin that cannot be WRITTEN still admits the host. The
      // caller is a registry read whose contract is a `{ kind }` union, so a
      // rejection here - a read-only userData, ENOSPC - escaped it as a throw
      // and failed the whole host list rather than one pin. Admitting is also
      // the right answer on its own terms: nothing is pinned, so nothing
      // disagrees, and the pin is retried on the next read.
      try {
        await pinning.store.pin(host.hostId, host.publicKey);
      } catch (cause) {
        pinning.onPinWriteFailed(host.hostId, cause);
      }
      admitted.push(host);
      continue;
    }
    if (pinned === host.publicKey) {
      admitted.push(host);
      continue;
    }
    pinning.onMismatch(
      new HostKeyPinMismatchError({
        hostId: host.hostId,
        pinnedKey: pinned,
        offeredKey: host.publicKey,
        pinLocation: pinning.store.describeLocation(),
      }),
    );
  }
  return admitted;
}
