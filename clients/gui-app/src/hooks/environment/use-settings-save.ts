import { useCallback, useMemo, useState } from "react";
import {
  queryOptions,
  skipToken,
  useQueries,
  useQuery,
  useQueryClient,
  type QueryClient,
} from "@tanstack/react-query";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import { HostRequestAbortedError } from "@traycer-clients/shared/host-transport/host-messenger";
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

/** One save about to be sent to a host, as the coordinator follows it. */
export type PendingSettingsSave =
  | {
      readonly kind: "send";
      /** The host answered the save. */
      readonly answered: () => void;
      /** The save failed, or nothing answered it. */
      readonly failed: () => void;
    }
  /**
   * The account changed while the save was prepared: it is not sent, and
   * ends as an aborted request, which no notice reports.
   */
  | { readonly kind: "abandoned"; readonly method: string };

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
  if (pending.kind === "abandoned") {
    throw new HostRequestAbortedError({
      message: "The account changed before the save was sent",
      requestId: crypto.randomUUID(),
      method: pending.method,
      mayHaveDispatched: false,
    });
  }
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
  kind: "send",
  answered: () => undefined,
  failed: () => undefined,
};

/**
 * Read once per editor session and kept: the revision the person edits over
 * is the one read when the session began, so a newer value from another
 * device makes the hold a conflict that waits in the review list. A session
 * begins when the editor opens, and again once a save it sent has settled,
 * so the next edit is made over what that save left.
 */
const EDIT_BASE_READ = {
  staleTime: Number.POSITIVE_INFINITY,
  refetchOnWindowFocus: false,
  refetchOnReconnect: false,
  retry: false,
} as const;

/** Whose base reads, in which environment and editor session. */
interface EditBaseScope {
  readonly source: EnvironmentCloudSource | null;
  readonly environmentId: string;
  readonly viewerId: string;
  readonly session: string;
}

/** authn's listing of the host a save is made on. */
function saveHostQuery(base: EditBaseScope, hostId: string) {
  const { source, environmentId } = base;
  // `source` is the sign-in of the viewer the key already names; adding it
  // would refetch on its identity alone.
  // eslint-disable-next-line @tanstack/query/exhaustive-deps
  return queryOptions({
    ...EDIT_BASE_READ,
    queryKey: environmentQueryKeys.settingsSaveHost(
      environmentId,
      hostId,
      base.viewerId,
      base.session,
    ),
    queryFn:
      source === null
        ? skipToken
        : () => readSettingsSaveHost(source(), environmentId, hostId),
  });
}

/** authn's rows of `kind`, as the person's edit is made over them. */
function saveItemsQuery(base: EditBaseScope, kind: string) {
  const { source, environmentId } = base;
  // `source` is the sign-in of the viewer the key already names.
  // eslint-disable-next-line @tanstack/query/exhaustive-deps
  return queryOptions({
    ...EDIT_BASE_READ,
    queryKey: environmentQueryKeys.settingsSaveItems(
      environmentId,
      kind,
      base.viewerId,
      base.session,
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
  /** The editor session whose base reads a save is made over. */
  readonly session: string;
  /** Begins a new editor session, with fresh base reads. */
  readonly renewSession: () => void;
}

/**
 * Remembers `save`, made for `accountId`, if it maps to a proposal; answers
 * how to follow it.
 */
async function followSave(
  scope: SaveScope,
  save: SettingsSave,
  accountId: string,
): Promise<PendingSettingsSave> {
  const { coordinator, queryClient, environmentId, hostId } = scope;
  const rowsOf = async (kind: string, key: string) =>
    (await queryClient.fetchQuery(saveItemsQuery(scope, kind))).filter(
      (row) => row.key === key,
    );
  const host = await queryClient.fetchQuery(saveHostQuery(scope, hostId));
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
  const beginning = await coordinator.begin(mapping, {
    accountId,
    environmentId,
    hostId,
    sharingGeneration: host.sharingGeneration,
    expectedLiveRevision: liveRowAt(editRows, edit.os)?.revision ?? null,
  });
  if (beginning.kind === "account_changed") {
    return { kind: "abandoned", method: save.method };
  }
  if (beginning.kind === "nothing_to_remember") return NOTHING_TO_FOLLOW;
  const { ticket } = beginning;
  return {
    kind: "send",
    answered: () => {
      // Settling applies the save's hold, which moves the live revision the
      // next edit is made over.
      void coordinator.settle(ticket, true).finally(scope.renewSession);
    },
    failed: () => {
      void coordinator.settle(ticket, false);
    },
  };
}

/**
 * Where the saves on `client`'s host are remembered, with authn's rows of
 * `kinds` read when each editor session begins; null while that is not known.
 */
function useSaveScope(
  client: HostClient<HostRpcRegistry> | null,
  kinds: readonly string[],
): SaveScope | null {
  const [session, setSession] = useState(() => crypto.randomUUID());
  const renewSession = useCallback(() => {
    setSession(crypto.randomUUID());
  }, []);
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
        : {
            coordinator,
            queryClient,
            source,
            environmentId,
            hostId,
            viewerId,
            session,
            renewSession,
          },
    [
      coordinator,
      queryClient,
      source,
      environmentId,
      hostId,
      viewerId,
      session,
      renewSession,
    ],
  );

  const base: EditBaseScope = {
    source: scope?.source ?? null,
    environmentId: environmentId ?? "",
    viewerId,
    session,
  };
  useQuery({
    ...saveHostQuery(base, hostId ?? ""),
    enabled: scope !== null,
  });
  useQueries({
    queries: kinds.map((kind) => ({
      ...saveItemsQuery(base, kind),
      enabled: scope !== null,
    })),
  });
  return scope;
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
  const scope = useSaveScope(client, kinds);
  return useCallback(
    async (
      save: SettingsSave,
      sentOn: string | null,
    ): Promise<PendingSettingsSave> => {
      if (scope === null || sentOn !== scope.hostId) return NOTHING_TO_FOLLOW;
      const accountId = scope.coordinator.account();
      if (accountId === null) return NOTHING_TO_FOLLOW;
      let pending: PendingSettingsSave;
      try {
        pending = await followSave(scope, save, accountId);
      } catch {
        pending = NOTHING_TO_FOLLOW;
      }
      if (scope.coordinator.account() === accountId) return pending;
      // Made for an account that is no longer here: it is not sent, and its
      // record, if remembered in that account's memory, is not out.
      if (pending.kind === "send") pending.failed();
      return { kind: "abandoned", method: save.method };
    },
    [scope],
  );
}

/**
 * Whether the environment holds exactly one `kind` item keyed `key`, as authn
 * lists it on the person's sign-in. False when the host is in no environment,
 * or the read fails. A host may say which item to look for, never that it
 * exists.
 */
export type SettingsItemExists = (key: string) => Promise<boolean>;

/** {@link SettingsItemExists} for `kind`, over the host behind `client`. */
export function useSettingsItemExists(
  client: HostClient<HostRpcRegistry> | null,
  kind: string,
): SettingsItemExists {
  const scope = useSaveScope(client, [kind]);
  return useCallback(
    async (key: string): Promise<boolean> => {
      if (scope === null) return false;
      try {
        const rows = await scope.queryClient.fetchQuery(
          saveItemsQuery(scope, kind),
        );
        return rows.filter((row) => row.key === key).length === 1;
      } catch {
        return false;
      }
    },
    [kind, scope],
  );
}
