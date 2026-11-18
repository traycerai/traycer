import type { NegotiatedMethodVersion } from "@/lib/host/read-negotiated-method-version";
import { readNegotiatedMethodVersion } from "@/lib/host/read-negotiated-method-version";

/**
 * Whether a host's simulator verbs are `@1.1`: instances, session ids, the
 * catalog and the host-wide verbs. `simulator.open` stands for the family,
 * since every `@1.1` method shipped together. Null while no handshake with
 * the host has completed.
 */
export function simulatorVerbsAreV11(
  version: NegotiatedMethodVersion,
): boolean | null {
  if (version === null) return null;
  if (version === false) return false;
  return version.major > 1 || (version.major === 1 && version.minor >= 1);
}

/** {@link simulatorVerbsAreV11} read at dispatch time, for a click handler. */
export function simulatorHostSpeaksV11(hostId: string): boolean | null {
  return simulatorVerbsAreV11(
    readNegotiatedMethodVersion(hostId, "simulator.open"),
  );
}
