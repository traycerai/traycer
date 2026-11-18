import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
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
import { useAuthService, useHostBinding } from "@/lib/host";
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

/**
 * The mounted instances of one half below, oldest first; the oldest one acts.
 * One owner however many surfaces mount it (the host list banner and the card
 * share a Settings screen on desktop; a phone shows the card without the
 * banner), so one change is one invalidation, one turn subscription and one
 * poll.
 */
interface OwnerRegistry {
  readonly mounted: symbol[];
  readonly listeners: Set<() => void>;
  /** Runs when the last mounted instance unmounts. */
  readonly onEmptied: (() => void) | null;
}

function createOwnerRegistry(onEmptied: (() => void) | null): OwnerRegistry {
  return { mounted: [], listeners: new Set(), onEmptied };
}

/**
 * The last row-set signature the observer's owner saw. Module-level, not per
 * instance: ownership passes between the banner and the card, and the
 * transition that matters most, the last row disappearing, can be the very
 * moment the card that owned it unmounts. Reset once no observer is mounted,
 * so a later mount starts from its first answer again.
 */
let lastObservedSignature: string | null = null;

const observerOwners = createOwnerRegistry(() => {
  lastObservedSignature = null;
});
const pollOwners = createOwnerRegistry(null);

function useIsOwner(registry: OwnerRegistry, description: string): boolean {
  const [id] = useState(() => Symbol(description));
  useEffect(() => {
    registry.mounted.push(id);
    notifyOwnerChanged(registry);
    return () => {
      const index = registry.mounted.indexOf(id);
      if (index !== -1) registry.mounted.splice(index, 1);
      if (registry.mounted.length === 0) registry.onEmptied?.();
      notifyOwnerChanged(registry);
    };
  }, [registry, id]);
  const subscribe = useCallback(
    (listener: () => void) => {
      registry.listeners.add(listener);
      return () => {
        registry.listeners.delete(listener);
      };
    },
    [registry],
  );
  const currentOwner = useCallback(
    (): symbol | null => registry.mounted[0] ?? null,
    [registry],
  );
  return useSyncExternalStore(subscribe, currentOwner, currentOwner) === id;
}

function notifyOwnerChanged(registry: OwnerRegistry): void {
  for (const listener of registry.listeners) listener();
}

/**
 * The event half of keeping the sandbox cost view and the balance live, on
 * the pattern of `useRefreshCreditsOnTraycerTurn`: it invalidates both when a
 * Traycer turn completes (it spent credits) and when a sandbox appears,
 * changes state, freezes or disappears (the burn moved). Those changes are
 * seen through the sandbox list, which the directory's existing liveness
 * tick already refreshes.
 *
 * It reads no cost itself, so it is mounted where the row set is watched
 * whatever its size: the host list's banner wrapper, which stays mounted
 * when the last sandbox goes, and the card. The cost view and the balance
 * otherwise refetch on window focus, like the credits card.
 */
export function useSandboxCostsObserver(): void {
  const isOwner = useIsOwner(observerOwners, "sandbox-costs-observer");
  const queryClient = useQueryClient();
  // Through the nullable binding, as `useSandboxList` reads it: this half is
  // mounted by the host list whatever its size, including on a surface with
  // no host runtime, where no list can load and there is nothing to observe.
  const binding = useHostBinding();
  const auth = binding === null ? null : binding.auth;
  const signature = burnSignature(useSandboxList().data);

  useEffect(() => {
    if (!isOwner || auth === null) return undefined;
    return subscribeChatTurnCompletions((completion) => {
      if (completion.harnessId !== "traycer") return;
      void queryClient.invalidateQueries({
        queryKey: authQueryKeys.user(auth),
      });
    });
  }, [isOwner, queryClient, auth]);

  useEffect(() => {
    if (!isOwner || auth === null) return;
    const previous = lastObservedSignature;
    lastObservedSignature = signature;
    // The first answer is the queries' own first fetch, not a change; nor is
    // the first sandbox appearing, whose cost view mounts and fetches then.
    // The last one going (non-empty to empty) IS a change.
    if (previous === null || previous === "" || previous === signature) {
      return;
    }
    void queryClient.invalidateQueries({
      queryKey: sandboxQueryKeys.costsAll(),
    });
    void queryClient.invalidateQueries({ queryKey: authQueryKeys.user(auth) });
  }, [isOwner, signature, queryClient, auth]);
}

/**
 * The poll half: the balance polls on the cost view's rule
 * (`sandboxCostsRefetchInterval`), every minute while any sandbox accrues
 * (awake or only its storage) or while the cost read is failing. With
 * nothing changing state and no turn completing, no event would refresh it.
 * An observer of the shared credits query, from the owner only, so there is
 * one poll however many surfaces mount this.
 *
 * It reads the cost view, so it is mounted only where a sandbox exists: a
 * user with no sandboxes reads no cost.
 */
export function useSandboxBalancePoll(): void {
  const isOwner = useIsOwner(pollOwners, "sandbox-balance-poll");
  const auth = useAuthService();
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
}

/**
 * Both halves, for a surface that shows the figures itself (the card, which a
 * phone shows with no banner above it). Safe to mount anywhere: each half
 * acts from its oldest mounted instance only.
 */
export function useRefreshSandboxCosts(): void {
  useSandboxCostsObserver();
  useSandboxBalancePoll();
}
