import { useAuthStore, type AuthState } from "@/stores/auth/auth-store";
import { mintDraftId } from "./draft-ids";
import type { DraftAuthorityActor } from "./draft-authority-types";

function activeAccount(state: AuthState): string | null {
  return state.status === "signed-in" ? (state.contextMetadata?.userId ?? null) : null;
}

let sessionGeneration: string | undefined;
const sessionListeners = new Set<() => void>();
useAuthStore.subscribe((next, previous) => {
  if (activeAccount(next) === activeAccount(previous)) return;
  sessionGeneration = undefined;
  for (const listener of sessionListeners) listener();
});

export function subscribeToDraftAuthoritySessionChanges(listener: () => void): () => void {
  sessionListeners.add(listener);
  return () => {
    sessionListeners.delete(listener);
  };
}

export function captureDraftAuthorityActor(): DraftAuthorityActor | null {
  const accountId = activeAccount(useAuthStore.getState());
  if (accountId === null) return null;
  sessionGeneration ??= mintDraftId();
  return { accountId, sessionGeneration };
}

export function draftAuthorityActorIsCurrent(actor: DraftAuthorityActor): boolean {
  return (
    activeAccount(useAuthStore.getState()) === actor.accountId &&
    sessionGeneration === actor.sessionGeneration
  );
}

export function draftAuthorityOptionalActorIsCurrent(actor: DraftAuthorityActor | null): boolean {
  return actor === null
    ? activeAccount(useAuthStore.getState()) === null
    : draftAuthorityActorIsCurrent(actor);
}
