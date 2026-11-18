import type { DraftKind } from "@traycer/protocol/host";

/**
 * Whether this surface exists only on the host that owns it.
 *
 * A `chat-composer` draft belongs to a chat and an `interview` draft to a
 * block inside one; a chat is bound to a host for life (`<TabHostProvider>`,
 * clone-not-migrate), so a second device can neither open the surface the
 * draft types into nor submit it. `landing`, `new-chat` and `stash-entry`
 * name no host-local surface - they are the ones cross-device backup exists
 * for.
 *
 * The rule is the same on both sides of the cloud drafts feed, which is why
 * it lives here rather than being restated at each: LISTING a host-bound
 * draft offers a row that cannot be opened, and INGESTING one applies it over
 * the owning host's own live draft as `origin: "replica"` - which turned that
 * host's own composer read-only behind a "Read-only. Owned by <itself>"
 * banner on every tab switch.
 */
export function draftKindIsHostBound(kind: DraftKind): boolean {
  return kind === "chat-composer" || kind === "interview";
}
