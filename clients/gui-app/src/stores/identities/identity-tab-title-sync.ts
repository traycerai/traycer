/**
 * Keeps an identity tab's title in step with the identity's authoritative
 * record, for as long as the tab's session is open.
 *
 * The tab source (`identity-tabs-store.ts`) holds only the LAST KNOWN title -
 * whatever the list row or the deep link carried at open time, which for a
 * deep link is nothing. The authoritative title lives on the open-identity
 * session's index lane, and it moves: a snapshot lands after a cold open, a
 * rename in the settings panel commits a record patch. Without this bridge a
 * deep-linked tab stays labelled "Identity" and a renamed one keeps its old
 * name until the list dialog happens to reopen it (finding 42).
 *
 * `setTitle` is a no-op for an unchanged title and for a tab this store does
 * not hold, so the subscription is safe to run against any session - a second
 * session for the same identity on another host simply agrees.
 */
import { useIdentityTabsStore } from "@/stores/identities/identity-tabs-store";
import type {
  OpenIdentityState,
  OpenIdentityStoreHandle,
} from "@/stores/identities/open-identity/store";

export function syncIdentityTabTitle(
  handle: OpenIdentityStoreHandle,
): () => void {
  const apply = (state: OpenIdentityState): void => {
    // `null` before the first snapshot: there is no title to apply yet, and
    // blanking the tab would show something the host never said.
    if (state.identity === null) return;
    useIdentityTabsStore
      .getState()
      .setTitle(handle.identityId, state.identity.title);
  };
  apply(handle.store.getState());
  return handle.store.subscribe(apply);
}
