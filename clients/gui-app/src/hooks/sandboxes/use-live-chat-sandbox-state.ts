import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { AuthService } from "@/lib/auth/auth-service";
import { useHostBinding } from "@/lib/host";
import { useChatServing } from "@/lib/chats/chat-serving-witness";
import { useChatStreamSyncState } from "@/hooks/chats/use-chat-stream-sync-state";
import { useChatSandboxState } from "@/hooks/sandboxes/use-chat-sandbox-state";
import {
  sandboxListQueryOptions,
  useSandboxList,
} from "@/hooks/sandboxes/use-sandbox-list-query";
import { useSandboxControlUnavailableReason } from "@/hooks/sandboxes/use-sandbox-control-unavailable-reason";
import type { ChatSandboxState } from "@/lib/sandboxes/chat-sandbox-state";
import { authQueryKeys, sandboxQueryKeys } from "@/lib/query-keys";
import { hostQueryKeys } from "@/lib/query-keys/host-query-keys";
import { useAuthStore } from "@/stores/auth/auth-store";

interface LifecycleActivity {
  readonly hostId: string;
  readonly known: boolean;
  /** Whether the sandbox list holds the row. */
  readonly listed: boolean;
  readonly disconnected: boolean;
  readonly serving: string | null;
}

interface LifecycleSignal extends LifecycleActivity {
  readonly auth: AuthService | null;
  readonly userId: string | null;
}

interface LifecycleObservation {
  readonly signal: LifecycleSignal;
  readonly revision: number;
}

/** Only an owner lifecycle edge starts a read, never a pool transcript retry. */
function lifecycleReadRequired(
  before: LifecycleSignal,
  after: LifecycleSignal,
  atRest: boolean,
): boolean {
  if (!after.known) return false;
  const rebound =
    before.auth !== after.auth ||
    before.userId !== after.userId ||
    before.hostId !== after.hostId;
  if (rebound || !before.known) return after.disconnected || atRest;
  if (after.disconnected && !before.disconnected) return true;
  // The row leaves at `destroyed`, when the task's end record exists.
  if (before.listed && !after.listed) return true;
  return (
    after.serving !== null &&
    before.serving !== after.serving &&
    (before.serving !== null || atRest)
  );
}

/** Record the edge before children can paint stale awake availability. */
function useLifecycleRevision(
  signal: LifecycleSignal,
  atRest: boolean,
): number {
  const [observation, setObservation] = useState<LifecycleObservation>(() => ({
    signal,
    revision: signal.known && (signal.disconnected || atRest) ? 1 : 0,
  }));
  const before = observation.signal;
  if (
    before.auth === signal.auth &&
    before.userId === signal.userId &&
    before.hostId === signal.hostId &&
    before.known === signal.known &&
    before.listed === signal.listed &&
    before.disconnected === signal.disconnected &&
    before.serving === signal.serving
  ) {
    return observation.revision;
  }
  const revision =
    observation.revision +
    (lifecycleReadRequired(before, signal, atRest) ? 1 : 0);
  setObservation({ signal, revision });
  return revision;
}

/**
 * A live tile's sandbox state follows its owner's stream, not the pool's
 * reachability. A stream loss or serving change refreshes the shared lists
 * once; the ordinary directory tick remains the only polling timer.
 */
export function useLiveChatSandboxState(
  epicId: string,
  chatId: string,
  hostId: string,
  ownerReachable: boolean,
): { readonly state: ChatSandboxState; readonly reachable: boolean } {
  const list = useSandboxList();
  const serving = useChatServing({ hostId, epicId, chatId });
  const stream = useChatStreamSyncState(epicId, chatId, hostId);
  const atRest =
    serving !== null &&
    (serving.state !== "live" || serving.ownerHostId !== hostId);
  // A pool transcript reconnect does not mean the sandbox changed state.
  const disconnected =
    !atRest &&
    (!ownerReachable || (stream.hasContent && stream.status !== "open"));
  const reachable = !atRest && !disconnected;
  const state = useChatSandboxState(epicId, hostId, reachable);
  const sandbox = list.data?.sandboxes.find((row) => row.hostId === hostId);
  const known =
    state.kind === "none" ? sandbox !== undefined : state.kind !== "destroyed";
  const servingKey =
    serving === null
      ? null
      : JSON.stringify([
          serving.ownerHostId,
          serving.state,
          serving.catchingUp,
        ]);
  const reading = useSandboxLifecycleRead(
    {
      hostId,
      known,
      listed: sandbox !== undefined,
      disconnected,
      serving: servingKey,
    },
    atRest,
  );

  if (state.kind === "unreachable" && (atRest || reading)) {
    return {
      state: { kind: "pending", name: state.sandbox.displayName },
      reachable: false,
    };
  }
  // The read in flight says what became of it: no line before its answer.
  if (state.kind === "pending" && reading) return { state, reachable: true };
  return { state, reachable };
}

/** Reconcile each lifecycle edge with a read sent after it, under its account. */
function useSandboxLifecycleRead(
  activity: LifecycleActivity,
  atRest: boolean,
): boolean {
  const binding = useHostBinding();
  const auth = binding === null ? null : binding.auth;
  const userId = useAuthStore((state) => state.contextMetadata?.userId ?? null);
  const signedIn = useAuthStore((state) => state.status === "signed-in");
  const available = useSandboxControlUnavailableReason() === null;
  const queryClient = useQueryClient();
  const revision = useLifecycleRevision({ ...activity, auth, userId }, atRest);
  const [completedRevision, setCompletedRevision] = useState(0);
  const directory = binding === null ? null : binding.directory;
  useEffect(() => {
    if (revision === 0 || auth === null || !signedIn || !available) return;
    let active = true;
    const isActive = (): boolean => active;
    const refresh = async (): Promise<void> => {
      // Neither list can reconcile this edge with a request sent before it.
      // Cancel both before starting the event's reads under this account.
      await Promise.all([
        queryClient.cancelQueries({
          queryKey: sandboxQueryKeys.list(auth, userId),
          exact: true,
        }),
        queryClient.cancelQueries({
          queryKey: authQueryKeys.registeredHosts(auth, userId),
          exact: true,
        }),
      ]);
      // The live tile may be replaced by its published copy while the
      // cancellation settles. That copy still needs this shared read;
      // only an account change prevents it from starting.
      const account = useAuthStore.getState();
      if (
        account.status !== "signed-in" ||
        (account.contextMetadata?.userId ?? null) !== userId
      )
        return;
      // Host chips read the registry as well as the directory and sandbox list.
      void queryClient.invalidateQueries({
        queryKey: authQueryKeys.registeredHosts(auth, userId),
        exact: true,
        refetchType: "all",
      });
      void directory?.refresh();
      try {
        await queryClient.fetchQuery({
          ...sandboxListQueryOptions(auth, userId, true),
          staleTime: 0,
        });
        // A row gone from the list is an end the task's hosts now carry.
        await queryClient.refetchQueries({
          type: "active",
          predicate: (query) =>
            hostQueryKeys.matchesMethodOnAnyHost(
              query.queryKey,
              "epic.listTaskHosts",
            ),
        });
      } catch {
        // The shared query retains its error and last good answer.
      }
      if (isActive()) setCompletedRevision(revision);
    };
    void refresh();
    return () => {
      active = false;
    };
  }, [auth, userId, revision, directory, queryClient, signedIn, available]);

  return auth !== null && signedIn && available && completedRevision < revision;
}
