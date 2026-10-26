import { useCallback, useSyncExternalStore } from "react";
import {
  readHostDirectoryEntry,
  subscribeHostRowChanged,
} from "@traycer-clients/shared/host-client/host-connection-registry";
import {
  isTeamSandboxHostDirectoryEntry,
  readProcessHostRpcTierPlan,
} from "@traycer-clients/shared/host-client/host-rpc-routing";
import type { EnvironmentListResponse } from "@traycer/protocol/host/environment/contracts";
import { useEnvironmentListQuery } from "@/hooks/bots/use-environment-list-query";
import { useOwnedByViewer } from "@/hooks/chats/use-owned-by-viewer";
import { useOptionalHostClient } from "@/lib/host";
import { usePreviewFeature } from "@/hooks/auth/use-preview-feature";
import {
  authorizesCloudCapability,
  useAuthStore,
} from "@/stores/auth/auth-store";

/**
 * Whether a chat's owner is a team environment: `team` for a team sandbox's
 * environment-owned chat, `other` for a person, `unknown` while that cannot
 * be told yet.
 */
export type TeamEnvironmentOwnership = "team" | "other" | "unknown";

/**
 * Reads the two facts that can say so:
 * - the owner host's directory row is a team's sandbox;
 * - the owner id is one of the viewer's team environments in an answered
 *   `environment.list`.
 *
 * Either one is enough for `team`. `other` needs the list answered without a
 * match, or a build where team environments cannot exist (`listApplies`
 * false: no server pool, or no cloud access). Anything else is `unknown`: a
 * list still loading or failed, with no team row. The caller must not turn
 * `unknown` into "another collaborator's".
 */
export function teamEnvironmentOwnership(input: {
  readonly ownerHostIsTeamSandbox: boolean;
  readonly listApplies: boolean;
  readonly environments: EnvironmentListResponse | undefined;
  readonly ownerUserId: string | null;
}): TeamEnvironmentOwnership {
  if (input.ownerHostIsTeamSandbox) return "team";
  if (!input.listApplies) return "other";
  if (input.environments === undefined) return "unknown";
  if (input.ownerUserId === null) return "other";
  const ownerUserId = input.ownerUserId;
  return input.environments.environments.some(
    (environment) =>
      environment.ownerKind === "organization" &&
      environment.environmentId === ownerUserId,
  )
    ? "team"
    : "other";
}

/**
 * {@link teamEnvironmentOwnership} for a chat's owner user and owner host.
 *
 * The list is the same team list `EnvironmentArmScopeMount` publishes its
 * arms from. The directory row is read through the shared connection registry,
 * as `useOwnerSandboxOpensLive` reads it, because a tile under test or a row
 * outside a host runtime has no `<HostRuntimeProvider>`; the client is
 * optional for the same reason.
 */
export function useTeamEnvironmentOwnership(
  ownerUserId: string | null,
  ownerHostId: string | null,
): TeamEnvironmentOwnership {
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
  );
  const subscribe = useCallback(
    (listener: () => void) =>
      ownerHostId === null
        ? () => undefined
        : subscribeHostRowChanged(ownerHostId, listener),
    [ownerHostId],
  );
  const getSnapshot = useCallback(() => {
    if (ownerHostId === null) return false;
    const entry = readHostDirectoryEntry(ownerHostId);
    return entry !== null && isTeamSandboxHostDirectoryEntry(entry);
  }, [ownerHostId]);
  const ownerHostIsTeamSandbox = useSyncExternalStore(
    subscribe,
    getSnapshot,
    getSnapshot,
  );
  return teamEnvironmentOwnership({
    ownerHostIsTeamSandbox,
    listApplies,
    environments: environments.data,
    ownerUserId,
  });
}

/**
 * The two owner facts a chat's banner and lock sentences choose their copy
 * by, shared so both surfaces read them the same way: `environmentOwned` for
 * a team sandbox's chat, and `ownedByViewer`, which an owner not yet told
 * apart keeps true - it stays on the own-chat sentences, as
 * `useOwnedByViewer` keeps an unresolved owner, and is never called a
 * collaborator's.
 */
export function useChatOwnerCopyFacts(
  ownerUserId: string | null,
  ownerHostId: string | null,
  chatId: string,
): { readonly ownedByViewer: boolean; readonly environmentOwned: boolean } {
  const ownership = useTeamEnvironmentOwnership(ownerUserId, ownerHostId);
  const ownedByViewer = useOwnedByViewer(ownerUserId, chatId);
  return {
    ownedByViewer: ownedByViewer || ownership === "unknown",
    environmentOwned: ownership === "team",
  };
}
