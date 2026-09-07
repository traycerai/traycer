import type { HostListItem } from "@traycer/protocol/host/host-status";

/**
 * Trust-on-first-use pinning of a host's Noise static key (browser-security-hardening H11).
 * The deterministic upgrade is to remember the first key seen for a `hostId` and refuse a later different one.
 */

export interface HostKeyPinStore {
  /** The key pinned for `hostId`, or `null` when this host has never been seen. */
  read(hostId: string): Promise<string | null>;
  /**
   * Records `publicKey` as `hostId`'s pin on first sight, and answers with the key that is pinned once it returns - which is `publicKey` only when this call is the one that established it.
   * Read-and-first-write in one store operation, rather than a `read` here and a `pin` there, because two registry reads run concurrently (the renderer's directory poll and main's own jar-stream resolve).
   */
  pin(hostId: string, publicKey: string): Promise<string>;
  /**
   * Where the pins live, for the recovery instruction.
   * There is no UI for un-pinning a host and this deliberately does not invent one: a key change is either a host that was rebuilt or an interception, and only the person can tell those apart.
   */
  describeLocation(): string;
}

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
   * A first-sight pin the store could not write.
   * Reported rather than thrown, because the caller is a registry read whose contract is a `{ kind }` union and one unwritable pin must not fail every host in the answer.
   */
  readonly onPinWriteFailed: (hostId: string, cause: unknown) => void;
}

let installed: InstalledPinning | null = null;

export function installHostKeyPinStore(pinning: InstalledPinning): void {
  installed = pinning;
}

export function clearHostKeyPinStore(): void {
  installed = null;
}

/**
 * The rows of a registry answer this client is willing to act on.
 * A host whose key changed is removed rather than flagged: the whole point is that no consumer may dial it, and every consumer downstream of here reads the list, not a flag.
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
    // Refused per host rather than thrown, because the caller's contract is a `{ kind }` union and a rejection here failed the whole registry read.
    let pinned: string | null;
    try {
      pinned = await pinning.store.read(host.hostId);
    } catch (cause) {
      pinning.onPinWriteFailed(host.hostId, cause);
      continue;
    }
    if (pinned === null) {
      // A first-sight pin that cannot be written still admits the host.
      // The caller is a registry read whose contract is a `{ kind }` union, so a rejection here - a read-only userData, enospc - escaped it as a throw and failed the whole host list rather than one pin.
      let effective: string;
      try {
        effective = await pinning.store.pin(host.hostId, host.publicKey);
      } catch (cause) {
        pinning.onPinWriteFailed(host.hostId, cause);
        admitted.push(host);
        continue;
      }
      if (effective !== host.publicKey) {
        // Another first-sight pin for this same host won the race and pinned a different key.
        // That is a mismatch, not a write failure: a write failure admits (nothing is pinned, so nothing disagrees) and this host does disagree with what is now pinned.
        pinning.onMismatch(
          new HostKeyPinMismatchError({
            hostId: host.hostId,
            pinnedKey: effective,
            offeredKey: host.publicKey,
            pinLocation: pinning.store.describeLocation(),
          }),
        );
        continue;
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
