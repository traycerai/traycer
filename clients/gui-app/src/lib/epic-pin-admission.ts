import type { SchemaVersion } from "@traycer/protocol/framework/index";

/**
 * The `epic.setPinned` minor whose response states the pinned epic's
 * durability `home`.
 *
 * That key is the whole negotiation. A host serving it is a host whose pin
 * write has a local arm - the two shipped together and there is no release
 * with one and not the other - so the marker doubles as the answer to "can
 * this host pin an epic it holds on disk?", which nothing else on the wire
 * asks.
 */
export const SET_PINNED_LOCAL_HOME_MINOR = 1;

/**
 * Whether the negotiated host can pin a LOCAL-HOMED epic.
 *
 * The released `@1.0` line is cloud-only by construction: the host's only arm
 * writes to the cloud, so a pin on an epic that exists only on this machine
 * comes back a 404 the user reads as a bug. `historyPinUnavailableReason`
 * therefore refuses a `local-home` row outright, and that refusal is CORRECT
 * against every host on the released line.
 *
 * It stops being correct the moment a host grows the local arm, and nothing in
 * a `@1.0` response distinguishes the two - which is exactly the shape of
 * `negotiatedListTasksServesLocalFirst`, and this predicate is deliberately
 * its twin rather than a second mechanism.
 *
 * FAILS CLOSED on both non-version answers, which are different facts that
 * warrant the same answer here:
 *  - `false` - the host handshook and does not advertise `epic.setPinned` at
 *    all (it is an optional, non-floor capability, so this is a real state).
 *  - `null` - unknown: no handshake yet, no bound host, or a name-only legacy
 *    manifest record.
 *
 * Refusing on `null` strands nothing: the manifest arriving re-renders the
 * hook, and the control enables itself the moment the host says `1.1`. A
 * cloud-homed row does not consult this at all - its pin is admitted on the
 * released line exactly as before.
 *
 * This is a UI gate - what to ENABLE - and not the safety boundary. It answers
 * from the negotiated-manifest registry, which retains a host's last handshake
 * until traffic replaces it, so between this read and the request it enables
 * the host can restart or roll back under the same id. A dispatch that must
 * not reach an older process carries the floor ON the request
 * (`HostRequestOptions.requiredHostMethodVersion`), which both transports
 * refuse pre-send against their own handshake. The cost of being wrong here is
 * a refused write and a toast, never a lost pin.
 */
export function negotiatedSetPinnedServesLocalHome(
  version: SchemaVersion | null | false,
): boolean {
  if (version === null || version === false) return false;
  return version.major === 1 && version.minor >= SET_PINNED_LOCAL_HOME_MINOR;
}
