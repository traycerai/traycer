import { useCallback, useMemo, useSyncExternalStore } from "react";
import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  isTeamSandboxHostDirectoryEntry,
  readProcessHostRpcTierPlan,
} from "@traycer-clients/shared/host-client/host-rpc-routing";
import { isRemoteHostDirectoryEntry } from "@traycer-clients/shared/host-client/remote-fetcher";
import type { HostDirectoryEntry } from "@traycer-clients/shared/host-client/host-directory";
import {
  getNegotiatedHostMethods,
  subscribeNegotiatedManifests,
} from "@traycer-clients/shared/host-transport/negotiated-manifest-registry";
import type { EnvironmentListResponse } from "@traycer/protocol/host/environment/contracts";
import { useEnvironmentListQuery } from "@/hooks/bots/use-environment-list-query";
import { useHostClientForHostId } from "@/hooks/host/use-host-client-for-host-id";
import { useHostDirectoryEntry } from "@/hooks/host/use-host-directory-entry";
import { useHostDirectoryList } from "@/hooks/host/use-host-directory-list-query";
import { useHostMutation } from "@/hooks/host/use-host-query";
import { useEpicTileNavigation } from "@/hooks/epic/use-epic-tile-navigation";
import { useOptionalHostClient } from "@/lib/host";
import { usePreviewFeature } from "@/hooks/auth/use-preview-feature";
import { toastFromHostError } from "@/lib/host-error-toast";
import { chatContinueMutationKeys, hostQueryKeys } from "@/lib/query-keys";
import {
  authorizesCloudCapability,
  useAuthStore,
} from "@/stores/auth/auth-store";

const CONTINUE_METHOD = "chat.continueHere";

/** The task lists that place a chat under its owning host. */
const TASK_LIST_METHODS = ["epic.listCloudChats", "epic.listTaskHosts"];

const NO_ENTRIES: readonly HostDirectoryEntry[] = [];

/**
 * Whether the chat's own host is gone for good, as far as this device can
 * tell: no longer in the directory at all (a destroyed sandbox's host is
 * revoked), or a sandbox the server has destroyed or failed. The server's own
 * row is what the continue is decided on; this only chooses which action the
 * dead tile offers.
 */
function sourceIsRemoved(entry: HostDirectoryEntry | null): boolean {
  if (entry === null) return true;
  if (!isRemoteHostDirectoryEntry(entry) || entry.sandbox === null) {
    return false;
  }
  return (
    entry.sandbox.state === "destroyed" || entry.sandbox.state === "failed"
  );
}

/** The team that owns the environment `ownerUserId` names, or `null`. */
function environmentTeamId(
  environments: EnvironmentListResponse | undefined,
  ownerUserId: string | null,
): string | null {
  if (environments === undefined || ownerUserId === null) return null;
  const environment = environments.environments.find(
    (candidate) =>
      candidate.ownerKind === "organization" &&
      candidate.environmentId === ownerUserId,
  );
  return environment === undefined ? null : environment.ownerId;
}

/**
 * Where a removed team sandbox's chat continues: the first awake sandbox of
 * the same team, in directory order, other than the source, that is not
 * known to lack the method. A host never dialed has no manifest yet, and
 * counts: the press dials it, and a refusal falls back to the clone.
 */
function continueTargetHostId(
  directory: readonly HostDirectoryEntry[],
  teamId: string | null,
  sourceHostId: string,
): string | null {
  if (teamId === null) return null;
  const target = directory.find((entry) => {
    if (
      entry.hostId === sourceHostId ||
      !isTeamSandboxHostDirectoryEntry(entry) ||
      !isRemoteHostDirectoryEntry(entry) ||
      entry.sandbox === null ||
      entry.sandbox.ownerTeamId !== teamId ||
      entry.sandbox.state !== "awake" ||
      entry.sandbox.frozen
    ) {
      return false;
    }
    const methods = getNegotiatedHostMethods(entry.hostId);
    return methods === null || methods.has(CONTINUE_METHOD);
  });
  return target === undefined ? null : target.hostId;
}

/**
 * Re-reads the task's lists, so the chat is grouped under its new host.
 * Cancels first: `invalidateQueries` joins an initial read still in flight
 * (no data yet), and that read's pre-move answer would land after the move,
 * clear the invalidation and keep the chat under its old host - the lists
 * are not polled. See `useCloudChatPayloadList` for the same rule.
 */
function invalidateTaskLists(queryClient: QueryClient, epicId: string): void {
  const filters = {
    predicate: (query: { readonly queryKey: readonly unknown[] }) => {
      const key = query.queryKey;
      const method = TASK_LIST_METHODS.find((candidate) =>
        hostQueryKeys.matchesMethodOnAnyHost(key, candidate),
      );
      if (method === undefined) return false;
      const params = key[key[1] === method ? 2 : 3];
      return (
        typeof params === "object" &&
        params !== null &&
        "taskId" in params &&
        params.taskId === epicId
      );
    },
  };
  void queryClient
    .cancelQueries(filters)
    .then(() => queryClient.invalidateQueries(filters));
}

/**
 * Continue a removed team sandbox's chat on another sandbox of its team
 * (`chat.continueHere`), keeping the chat id: the server moves the chat's
 * authority there and the new host hydrates it from its published copy.
 *
 * The target is found from the chat's environment, not from the app-wide
 * host, which is never a team's. The tab stays bound to its host for life,
 * so a continue opens a NEW tab on the new host, which says it is catching up
 * until the chat is live there; this tab stays as it is. A refusal for
 * another environment, a target without the method, or a chat that never was
 * a team sandbox's falls back to `fallback`, the dead tile's Clone.
 */
export function useChatContinueHere(args: {
  readonly epicId: string;
  readonly chatId: string;
  readonly sourceHostId: string;
  /** The chat's owner: for a team sandbox's chat, its environment. */
  readonly ownerUserId: string | null;
  readonly name: string;
  readonly fallback: () => void;
}): {
  readonly eligible: boolean;
  /** The target sandbox's name, `null` when there is none. */
  readonly targetLabel: string | null;
  readonly continueHere: () => void;
  readonly continuing: boolean;
} {
  const authorized = useAuthStore((state) =>
    authorizesCloudCapability(state.status),
  );
  // Without environments (unread included) there is no team to look up.
  const environmentsOn = usePreviewFeature("environments") === "on";
  const listApplies =
    authorized && environmentsOn && readProcessHostRpcTierPlan().pool !== null;
  const environments = useEnvironmentListQuery(
    useOptionalHostClient(),
    listApplies,
  ).data;
  const teamId = environmentTeamId(environments, args.ownerUserId);
  const directory = useHostDirectoryList().data ?? NO_ENTRIES;
  const readTarget = useCallback(
    () => continueTargetHostId(directory, teamId, args.sourceHostId),
    [directory, teamId, args.sourceHostId],
  );
  const targetHostId = useSyncExternalStore(
    subscribeNegotiatedManifests,
    readTarget,
    readTarget,
  );
  const targetLabel = useMemo(
    () =>
      directory.find((entry) => entry.hostId === targetHostId)?.label ?? null,
    [directory, targetHostId],
  );
  const sourceEntry = useHostDirectoryEntry(args.sourceHostId);
  const namedClient = useHostClientForHostId(targetHostId);
  const targetClient = targetHostId === null ? null : namedClient;
  const { openTile } = useEpicTileNavigation();
  const queryClient = useQueryClient();
  const eligible = targetHostId !== null && sourceIsRemoved(sourceEntry);
  const { epicId, chatId, name, fallback } = args;
  const mutation = useHostMutation({
    client: targetClient,
    method: "chat.continueHere",
    mapVariables: (variables: { readonly operationId: string }) => ({
      epicId,
      chatId,
      operationId: variables.operationId,
    }),
    options: {
      mutationKey: chatContinueMutationKeys.continueHere(chatId),
      onError: (error) => {
        if (error.code === "E_HOST_UNSUPPORTED") {
          fallback();
          return;
        }
        toastFromHostError(error, "Couldn't continue this agent here.");
      },
    },
  });
  const { mutate, isPending } = mutation;
  const continueHere = useCallback(() => {
    if (targetHostId === null) return;
    // One id per press: the mutation's own retry (and a lost answer) reuses
    // it, so the server moves the chat at most once for this press.
    mutate(
      { operationId: crypto.randomUUID() },
      {
        onSuccess: (answer) => {
          if (answer.kind === "refused") {
            if (answer.reason === "other-environment") {
              fallback();
              return;
            }
            if (answer.reason === "source-live") {
              toast("This agent's sandbox still exists. Resume it instead.");
              return;
            }
            if (answer.reason === "never-published") {
              toast("This agent has nothing saved to continue from.");
              return;
            }
          }
          // Accepted, ready, or already moved by another press: open the
          // chat where it now belongs.
          const ownerHostId = answer.ownerHostId;
          if (ownerHostId === null) return;
          invalidateTaskLists(queryClient, epicId);
          openTile({
            node: {
              id: chatId,
              instanceId: crypto.randomUUID(),
              type: "chat",
              name,
              hostId: ownerHostId,
            },
            target: { epicId },
            gesture: "explicit",
            modifiers: null,
            placement: null,
            // Dedupe is per host: the dead tab on the old host never matches,
            // and a second press focuses the tab the first one opened.
            dedupe: true,
            source: "direct_ui",
          });
        },
      },
    );
  }, [
    targetHostId,
    mutate,
    fallback,
    openTile,
    queryClient,
    epicId,
    chatId,
    name,
  ]);
  return { eligible, targetLabel, continueHere, continuing: isPending };
}
