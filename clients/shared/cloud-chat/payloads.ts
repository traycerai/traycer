import type {
  ChatPayloadRef,
  ChatPayloadResolver,
} from "@traycer/protocol/persistence/chat-sync/presentation";
import type { CloudChatPayloadRef } from "@traycer/protocol/host/epic/cloud-chat";

/**
 * The bridge between "which payloads may I fetch" (a wire answer) and "is this
 * ref resolvable" (a synchronous question `presentChat` asks once per ref).
 *
 * `presentChat`'s resolver is synchronous by design - it is called while the
 * transcript is being built, and the fidelity count it feeds has to be complete
 * by the time the transcript exists. So the fetchable set is materialized ONCE,
 * up front, from the payload list, and every ref is answered out of it.
 *
 * A reader that has no list - because the host predates the method, or the call
 * failed - installs {@link NO_PAYLOADS_RESOLVABLE} instead and gets exactly the
 * markers this surface rendered before the channel existed. That is the right
 * degrade: under-promising an attachment is a marker the user can act on, while
 * over-promising one is a spinner that never resolves.
 */

/**
 * The key a payload is identified by on both sides of the bridge.
 *
 * `kind` is compared as a plain string rather than mapped through an enum. The
 * two vocabularies happen to agree today (`file-snapshot`, `plan-content`), and
 * a mapping table would be a third place for them to disagree; a kind neither
 * side knows simply never matches, which is the correct answer for it.
 */
function payloadKey(kind: string, sha256: string): string {
  // `\0` as the SOURCE escape, never a literal NUL: a raw 0x00 in a .ts file
  // makes Git classify it as binary, which silently removes the module from
  // diffs, blame and patch review. The separator itself has to be a byte
  // neither a kind nor a hex digest can contain, so that "a\0b" and "a" + "\0b"
  // cannot collide.
  return `${kind}\0${sha256}`;
}

/** The presentation-side ref's key. */
function presentedPayloadKey(ref: ChatPayloadRef): string {
  return payloadKey(ref.kind, ref.hash);
}

/**
 * Builds the resolver `presentChat` takes, from the refs the cloud says this
 * reader may fetch.
 *
 * Membership, not existence: a ref the chat names but the list omits is
 * `missing`, which is the ordinary state for content that only ever lived on the
 * originating device.
 */
export function resolverFromPayloadRefs(
  refs: readonly CloudChatPayloadRef[],
): ChatPayloadResolver {
  const fetchable = new Set(
    refs.map((ref) => payloadKey(ref.kind, ref.sha256)),
  );
  return (ref) =>
    fetchable.has(presentedPayloadKey(ref)) ? "resolvable" : "missing";
}

/**
 * The wire ref for a presented one, so a UI that decided to fetch a payload can
 * name it without re-deriving the mapping.
 */
export function payloadRefToWire(ref: ChatPayloadRef): CloudChatPayloadRef {
  return { kind: ref.kind, sha256: ref.hash };
}
