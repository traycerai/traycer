import { useCallback, useMemo } from "react";
import {
  queryOptions,
  skipToken,
  useQueries,
  useQuery,
  useQueryClient,
  type QueryClient,
} from "@tanstack/react-query";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type { AuthnItemRow } from "@traycer-clients/shared/environment/authn-environment-schemas";
import type { EnvironmentCloudSource } from "@traycer-clients/shared/environment/environment-cloud";
import {
  readSettingsItemRows,
  readSettingsSaveHost,
} from "@traycer-clients/shared/environment/settings-save-target";
import type { EnvironmentOs } from "@traycer/protocol/host/environment-schemas";
import {
  settingsSaveBaseAddress,
  settingsSaveItemEdit,
  type SettingsSave,
} from "@traycer/protocol/host/environment/settings-save-mapping";
import { useEnvironmentHostReadQuery } from "@/hooks/bots/use-environment-host-read-query";
import { useCloudChatViewerId } from "@/hooks/chats/use-cloud-chat-queries";
import { useEnvironmentCloud } from "@/hooks/environment/use-environment-cloud";
import { useRequesterHostId } from "@/hooks/host/use-requester-host-id";
import type { HostRpcRegistry } from "@/lib/host";
import type { SettingsSaveCoordinator } from "@/lib/environment/settings-save-coordinator";
import { environmentQueryKeys } from "@/lib/query-keys";
import { useSettingsSaveCoordinator } from "@/providers/settings-save-coordinator-context";

/** One save sent to a host, as the coordinator follows it. */
export interface PendingSettingsSave {
  /** The host answered the save. */
  readonly answered: () => void;
  /** The save failed, or nothing answered it. */
  readonly failed: () => void;
}

/**
 * Called just before a save is sent, with the host it is sent on: remembers
 * what the save will propose, so the app applies its own hold. A save sent
 * on any host but the requester's own is not followed.
 */
export type PrepareSettingsSave = (
  save: SettingsSave,
  sentOn: string | null,
) => Promise<PendingSettingsSave>;

/** Sends a followed save and tells `pending` whether the host answered it. */
export async function sendFollowedSave<T>(
  pending: PendingSettingsSave,
  send: () => Promise<T>,
): Promise<T> {
  let answer: T;
  try {
    answer = await send();
  } catch (cause) {
    pending.failed();
    throw cause;
  }
  pending.answered();
  return answer;
}

const NOTHING_TO_FOLLOW: PendingSettingsSave = {
  answered: () => undefined,
  failed: () => undefined,
};

/**
 * Read once per open editor and kept: the revision the person edits over is
 * the one read when the editor opened, so a newer value from another device
 * makes the hold a conflict that waits in the review list.
 */
const EDIT_BASE_READ = {
  staleTime: Number.POSITIVE_INFINITY,
  refetchOnWindowFocus: false,
  refetchOnReconnect: false,
  retry: false,
} as const;

/** authn's listing of the host a save is made on. */
function saveHostQuery(
  source: EnvironmentCloudSource | null,
  environmentId: string,
  hostId: string,
  viewerId: string,
) {
  // `source` is the sign-in of the viewer the key already names; adding it
  // would refetch on its identity alone.
  // eslint-disable-next-line @tanstack/query/exhaustive-deps
  return queryOptions({
    ...EDIT_BASE_READ,
    queryKey: environmentQueryKeys.settingsSaveHost(
      environmentId,
      hostId,
      viewerId,
    ),
    queryFn:
      source === null
        ? skipToken
        : () => readSettingsSaveHost(source(), environmentId, hostId),
  });
}

/** authn's rows of `kind`, as the person's edit is made over them. */
function saveItemsQuery(
  source: EnvironmentCloudSource | null,
  environmentId: string,
  kind: string,
  viewerId: string,
) {
  // `source` is the sign-in of the viewer the key already names.
  // eslint-disable-next-line @tanstack/query/exhaustive-deps
  return queryOptions({
    ...EDIT_BASE_READ,
    queryKey: environmentQueryKeys.settingsSaveItems(
      environmentId,
      kind,
      viewerId,
    ),
    queryFn:
      source === null
        ? skipToken
        : () => readSettingsItemRows(source(), environmentId, kind),
  });
}

/** The row a per-OS edit writes, or a kind's one row. */
function liveRowAt(
  rows: readonly AuthnItemRow[],
  os: EnvironmentOs | null,
): AuthnItemRow | undefined {
  return os === null
    ? rows.find((row) => row.os === null || row.os === "any")
    : rows.find((row) => row.os === os);
}

interface SaveScope {
  readonly coordinator: SettingsSaveCoordinator;
  readonly queryClient: QueryClient;
  readonly source: EnvironmentCloudSource;
  readonly environmentId: string;
  readonly hostId: string;
  readonly viewerId: string;
}

/** Remembers `save` if it maps to a proposal; answers how to follow it. */
async function followSave(
  scope: SaveScope,
  save: SettingsSave,
): Promise<PendingSettingsSave> {
  const { coordinator, queryClient, source, environmentId, hostId } = scope;
  const rowsOf = async (kind: string, key: string) =>
    (
      await queryClient.fetchQuery(
        saveItemsQuery(source, environmentId, kind, scope.viewerId),
      )
    ).filter((row) => row.key === key);
  const host = await queryClient.fetchQuery(
    saveHostQuery(source, environmentId, hostId, scope.viewerId),
  );
  if (host === null) return NOTHING_TO_FOLLOW;
  const address = settingsSaveBaseAddress(save);
  const baseRows =
    address === null ? [] : await rowsOf(address.kind, address.key);
  const mapping = settingsSaveItemEdit(save, {
    rows: baseRows.map((row) => ({ os: row.os, value: row.value })),
    hostOs: host.hostOs,
  });
  if (mapping.kind !== "proposal") return NOTHING_TO_FOLLOW;
  const { edit } = mapping;
  const editRows =
    address?.kind === edit.kind && address.key === edit.key
      ? baseRows
      : await rowsOf(edit.kind, edit.key);
  const ticket = await coordinator.begin(mapping, {
    environmentId,
    hostId,
    sharingGeneration: host.sharingGeneration,
    expectedLiveRevision: liveRowAt(editRows, edit.os)?.revision ?? null,
  });
  if (ticket === null) return NOTHING_TO_FOLLOW;
  return {
    answered: () => {
      void coordinator.settle(ticket, true);
    },
    failed: () => {
      void coordinator.settle(ticket, false);
    },
  };
}

/**
 * The save preparation for the host behind `client`, the requester the
 * caller sends its saves on. `kinds` are the item kinds the caller's saves
 * write, a constant of the caller's module; their rows are read from authn
 * when the editor opens. A host in no environment, a host authn does not
 * list, or a read that fails remembers nothing: the save still goes to the
 * host, and its hold waits for one click.
 */
export function useSettingsSave(
  client: HostClient<HostRpcRegistry> | null,
  kinds: readonly string[],
): PrepareSettingsSave {
  const coordinator = useSettingsSaveCoordinator();
  const hostId = useRequesterHostId(client);
  const environmentRead = useEnvironmentHostReadQuery(
    client,
    hostId,
    coordinator !== null && client !== null,
  );
  const environmentId =
    environmentRead.kind === "binding"
      ? (environmentRead.query.data?.environment.environmentId ?? null)
      : null;
  const viewerId = useCloudChatViewerId();
  const source = useEnvironmentCloud();
  const queryClient = useQueryClient();
  const scope = useMemo<SaveScope | null>(
    () =>
      coordinator === null ||
      source === null ||
      environmentId === null ||
      hostId === null ||
      viewerId.length === 0
        ? null
        : { coordinator, queryClient, source, environmentId, hostId, viewerId },
    [coordinator, queryClient, source, environmentId, hostId, viewerId],
  );

  useQuery({
    ...saveHostQuery(
      scope?.source ?? null,
      environmentId ?? "",
      hostId ?? "",
      viewerId,
    ),
    enabled: scope !== null,
  });
  useQueries({
    queries: kinds.map((kind) => ({
      ...saveItemsQuery(
        scope?.source ?? null,
        environmentId ?? "",
        kind,
        viewerId,
      ),
      enabled: scope !== null,
    })),
  });

  return useCallback(
    async (save: SettingsSave, sentOn: string | null) => {
      if (scope === null || sentOn !== scope.hostId) return NOTHING_TO_FOLLOW;
      try {
        return await followSave(scope, save);
      } catch {
        return NOTHING_TO_FOLLOW;
      }
    },
    [scope],
  );
}
