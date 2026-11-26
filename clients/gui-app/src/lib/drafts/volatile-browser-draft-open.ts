import { createStore } from "zustand/vanilla";
import {
  draftAuthorityActorIsCurrent,
  subscribeToDraftAuthoritySessionChanges,
} from "@/lib/drafts/draft-authority-session";
import type {
  DraftAuthorityActor,
  DraftAuthorityVersion,
} from "@/lib/drafts/draft-authority-types";

interface RecoveryOpen {
  readonly actor: DraftAuthorityActor;
  readonly draft: DraftAuthorityVersion;
  readonly onOpened: () => void;
}

export const browserDraftOpenStore = createStore<{ request: RecoveryOpen | null }>(
  () => ({ request: null }),
);
subscribeToDraftAuthoritySessionChanges(() => {
  browserDraftOpenStore.setState({ request: null });
});

export function requestBrowserDraftOpen(
  actor: DraftAuthorityActor,
  draft: DraftAuthorityVersion,
  navigateHome: () => void,
  onOpened: () => void,
): void {
  if (draft.slot.kind !== "landing" || !draftAuthorityActorIsCurrent(actor)) return;
  browserDraftOpenStore.setState({ request: { actor, draft, onOpened } });
  navigateHome();
}
