import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { SandboxListResponse } from "@traycer/protocol/host/sandbox-control";
import { subscribeChatTurnCompletions } from "@/lib/chats/chat-turn-completions";
import { authUserQueryOptions } from "@/hooks/auth/use-auth-user-query";
import {
  sandboxCostsRefetchInterval,
  useSandboxCosts,
} from "@/hooks/sandboxes/use-sandbox-costs-query";
import { useSandboxControlUnavailableReason } from "@/hooks/sandboxes/use-sandbox-control-unavailable-reason";
import { useSandboxList } from "@/hooks/sandboxes/use-sandbox-list-query";
import { useAuthStore } from "@/stores/auth/auth-store";
import { useAuthService } from "@/lib/host";
import { authQueryKeys, sandboxQueryKeys } from "@/lib/query-keys";

/**
 * What the awake burn depends on: which sandboxes exist, their states and
 * their frozen flags. A string, so the effect below depends on it by VALUE -
 * the list query hands out a new object on every refetch, and keying an
 * effect on that identity would invalidate on every liveness tick.
 */
function burnSignature(list: SandboxListResponse | null | undefined): string {
  if (list === null || list === undefined) return "";
  return list.sandboxes
    .map((s) => `${s.id}:${s.state}:${s.frozen ? "f" : "t"}`)
    .sort()
    .join("|");
}

// The mounted instances, oldest first; the oldest one does the refreshing.
// One owner however many surfaces mount the hook (the host list banner and
// the card share a Settings screen on desktop; a phone shows the card without
// the banner), so one change is one invalidation and one turn subscription.
const mounted: symbol[] = [];
const ownerListeners = new Set<() => void>();

function subscribeOwner(listener: () => void): () => void {
  ownerListeners.add(listener);
  return () => ownerListeners.delete(listener);
}

function currentOwner(): symbol | null {
  return mounted[0] ?? null;
}

function notifyOwnerChanged(): void {
  for (const listener of ownerListeners) listener();
}

/**
 * While mounted, keeps the sandbox cost view and the balance it is divided
 * into live, on the pattern of `useRefreshCreditsOnTraycerTurn`: invalidation
 * on events, plus a one-minute poll of both while any sandbox accrues, awake
 * or only its storage (`sandboxCostsRefetchInterval`), since accrual moves the
 * balance with no event at all.
 *
 * The events: a Traycer turn completing (it spent credits), and a sandbox
 * changing state or freezing (the burn moved), seen through the sandbox list
 * that the directory's existing liveness tick already refreshes. Both
 * queries otherwise refetch on window focus, like the credits card.
 *
 * Safe to mount on every surface that shows the figures: only the oldest
 * mounted instance acts, and ownership passes on when it unmounts.
 */
export function useRefreshSandboxCosts(): void {
  const [id] = useState(() => Symbol("sandbox-costs-refresh"));
  useEffect(() => {
    mounted.push(id);
    notifyOwnerChanged();
    return () => {
      const index = mounted.indexOf(id);
      if (index !== -1) mounted.splice(index, 1);
      notifyOwnerChanged();
    };
  }, [id]);
  const isOwner =
    useSyncExternalStore(subscribeOwner, currentOwner, currentOwner) === id;

  const queryClient = useQueryClient();
  const auth = useAuthService();
  const signature = burnSignature(useSandboxList().data);
  const previousRef = useRef<string | null>(null);

  // The balance polls on the cost view's rule while a sandbox accrues: with
  // nothing changing state and no turn completing, no event above would
  // refresh it. An observer of the shared credits query, from the owner only,
  // so one poll however many surfaces mount this.
  const signedIn = useAuthStore((s) => s.status === "signed-in");
  const costsQuery = useSandboxCosts();
  const costsUnavailable = useSandboxControlUnavailableReason() !== null;
  useQuery({
    ...authUserQueryOptions(auth, signedIn && isOwner),
    refetchInterval: sandboxCostsRefetchInterval(
      costsQuery.data ?? null,
      costsQuery.isError && !costsUnavailable,
    ),
    refetchIntervalInBackground: false,
  });

  useEffect(() => {
    if (!isOwner) return undefined;
    return subscribeChatTurnCompletions((completion) => {
      if (completion.harnessId !== "traycer") return;
      void queryClient.invalidateQueries({
        queryKey: authQueryKeys.user(auth),
      });
    });
  }, [isOwner, queryClient, auth]);

  useEffect(() => {
    if (!isOwner) {
      previousRef.current = null;
      return;
    }
    const previous = previousRef.current;
    previousRef.current = signature;
    // The first answer is the queries' own first fetch, not a change.
    if (previous === null || previous === "" || previous === signature) {
      return;
    }
    void queryClient.invalidateQueries({
      queryKey: sandboxQueryKeys.costsAll(),
    });
    void queryClient.invalidateQueries({ queryKey: authQueryKeys.user(auth) });
  }, [isOwner, signature, queryClient, auth]);
}
