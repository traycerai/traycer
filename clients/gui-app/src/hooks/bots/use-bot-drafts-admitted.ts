import { admitsLocalPlane, useAuthStore } from "@/stores/auth/auth-store";
import { useBotDraftsStore } from "@/stores/bots/bot-drafts-store";

/**
 * Whether the drafts store holds the drafts of the identity signed in now.
 * The store changes owner as the outgoing account retires, in an effect that
 * runs after the account changed (`BotDraftsPersistLifecycleBridge`); until
 * then it holds the outgoing account's, and the bot tab shows none of it
 * (`BotTabSurface`). A sign-in attempt in flight, or one that failed, keeps
 * the identity it started from, as the bridge does
 * (`useAuthIdentityTransition`).
 */
export function useBotDraftsAdmitted(): boolean {
  const status = useAuthStore((state) => state.status);
  const userId = useAuthStore((state) => state.profile?.userId ?? null);
  const signedOutCause = useAuthStore((state) => state.signedOutCause);
  const owner = useBotDraftsStore((state) => state.owner);
  if (status === "signing-in") return true;
  if (status === "signed-out" && signedOutCause === "attempt-failed") {
    return true;
  }
  if (!admitsLocalPlane(status)) return owner === null;
  return owner !== null && owner.userId === userId;
}
