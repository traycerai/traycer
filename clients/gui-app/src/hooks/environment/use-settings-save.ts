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
import type {
  EnvironmentCloud,
  EnvironmentCloudSource,
} from "@traycer-clients/shared/environment/environment-cloud";
import {
  readSettingsItemRows,
  readSettingsSaveHost,
} from "@traycer-clients/shared/environment/settings-save-target";
import type { EnvironmentOs } from "@traycer/protocol/host/environment-schemas";
import { settingValueSchema } from "@traycer/protocol/host/environment/settings-proposals";
import {
  canonicalSettingValue,
  settingsSaveBaseAddress,
  settingsSaveItemEdit,
  type SettingsItemEdit,
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
import { useAuthStore } from "@/stores/auth/auth-store";

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
 * Called just before a save is sent, with the host it is sent on and the
 * sign-in the person acted on (`pressedOn`, taken in the mutation's
 * `onMutate`; null with no session service): remembers what the save will
 * propose, so the app applies its own hold. A save sent on any host but the
 * requester's own is not followed. Once the sign-in it was pressed on has
 * ended, by a switch or by signing in again as the same person, the save is
 * not sent.
 */
export type PrepareSettingsSave = (
  save: SettingsSave,
  sentOn: string | null,
  pressedOn: EnvironmentCloud | null,
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

/** Who is signed in now, as {@link useCloudChatViewerId} names them. */
function signedInViewer(): string {
  return useAuthStore.getState().contextMetadata?.userId ?? "";
}

const NOTHING_TO_FOLLOW: PendingSettingsSave = {
  kind: "send",
  answered: () => undefined,
  failed: () => undefined,
};

/**
 * Read once per editor session and kept: the revision the person edits over
 * is the one read when the editor opened, so a newer value from another
 * device makes the hold a conflict that waits in the review list. Only the
 * session's own applied saves move it ({@link keepOwnWrite}).
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

/**
 * `read` on one sign-in of the viewer `base` names, for that viewer's cache:
 * a read begun once anyone else is signed in, or answered after the sign-in
 * it went out on ended, throws, and nothing is cached.
 */
async function readForViewer<T>(
  source: EnvironmentCloudSource,
  viewerId: string,
  read: (cloud: EnvironmentCloud) => Promise<T>,
): Promise<T> {
  if (signedInViewer() !== viewerId) {
    throw new Error("Another account is signed in");
  }
  const cloud = source();
  const answer = await read(cloud);
  if (!cloud.onOriginSignIn()) {
    throw new Error("The sign-in the read went out on has ended");
  }
  return answer;
}

/** authn's listing of the host a save is made on. */
function saveHostQuery(base: EditBaseScope, hostId: string) {
  const { source, environmentId, viewerId } = base;
  // `source` is the sign-in of the viewer the key already names; adding it
  // would refetch on its identity alone.
  // eslint-disable-next-line @tanstack/query/exhaustive-deps
  return queryOptions({
    ...EDIT_BASE_READ,
    queryKey: environmentQueryKeys.settingsSaveHost(
      environmentId,
      hostId,
      viewerId,
      base.session,
    ),
    queryFn:
      source === null
        ? skipToken
        : () =>
            readForViewer(source, viewerId, (cloud) =>
              readSettingsSaveHost(cloud, environmentId, hostId),
            ),
  });
}

/** authn's rows of `kind`, as the person's edit is made over them. */
function saveItemsQuery(base: EditBaseScope, kind: string) {
  const { source, environmentId, viewerId } = base;
  // `source` is the sign-in of the viewer the key already names.
  // eslint-disable-next-line @tanstack/query/exhaustive-deps
  return queryOptions({
    ...EDIT_BASE_READ,
    queryKey: environmentQueryKeys.settingsSaveItems(
      environmentId,
      kind,
      viewerId,
      base.session,
    ),
    queryFn:
      source === null
        ? skipToken
        : () =>
            readForViewer(source, viewerId, (cloud) =>
              readSettingsItemRows(cloud, environmentId, kind),
            ),
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
  readonly ledger: SaveLedger;
}

/**
 * The order of an editor session's saves, as the person made them, and per
 * row the latest of them whose write moved the base. A delete is ordered the
 * same way as a put: an absent row says nothing of which save removed it.
 */
interface SaveLedger {
  /** The next save's place. */
  readonly take: () => number;
  /**
   * Whether the save at `order` may move the base of `address`: no later save
   * of the session moved it already. Records it when it may.
   */
  readonly publish: (address: string, order: number) => boolean;
}

function createSaveLedger(): SaveLedger {
  let next = 0;
  const published = new Map<string, number>();
  return {
    take: () => next++,
    publish: (address, order) => {
      if ((published.get(address) ?? -1) > order) return false;
      published.set(address, order);
      return true;
    },
  };
}

/** The row `edit` writes, as the ledger names it. */
function rowAddress(edit: SettingsItemEdit): string {
  return JSON.stringify([edit.kind, edit.key, edit.os]);
}

/** Whether `row`, authn's row at `edit`'s address, is what `edit` wrote. */
function isOwnWrite(row: AuthnItemRow | null, edit: SettingsItemEdit): boolean {
  if (edit.operation === "delete") return row === null;
  if (row === null) return false;
  const value = settingValueSchema.safeParse(row.value);
  return (
    value.success && canonicalSettingValue(value.data) === edit.canonicalValue
  );
}

/** `rows` with `edit`'s row as authn now holds it, `row`. */
function withOwnWrite(
  rows: readonly AuthnItemRow[],
  edit: SettingsItemEdit,
  row: AuthnItemRow | null,
): readonly AuthnItemRow[] {
  const held = liveRowAt(
    rows.filter((candidate) => candidate.key === edit.key),
    edit.os,
  );
  const others = rows.filter((candidate) => candidate !== held);
  return row === null ? others : [...others, row];
}

/**
 * Once this window has applied a save of this session's own hold, moves the
 * base of its row to the row authn holds, when that row is still the one the
 * save wrote: the person has seen their own write, and their next edit is
 * made over it. Neither the send nor a reconcile that leaves the save queued
 * moves it. A row anyone else wrote leaves the base where the person last saw
 * it, whether the next edit began before this apply or after, so that edit
 * waits in the review list against the change instead of overwriting it. A
 * save whose read answers after a later save of this session moved the base
 * of the same row leaves it there.
 */
async function keepOwnWrite(
  scope: SaveScope,
  operation: SaveOperation,
  edit: SettingsItemEdit,
): Promise<void> {
  const { queryClient, environmentId, ledger } = scope;
  const { cloud, order } = operation;
  // `cloud` is the sign-in the save was made on: a read on any later one is
  // another person's view of the row.
  if (!cloud.onOriginSignIn()) return;
  const rows = await readSettingsItemRows(cloud, environmentId, edit.kind);
  const row =
    liveRowAt(
      rows.filter((candidate) => candidate.key === edit.key),
      edit.os,
    ) ?? null;
  if (!isOwnWrite(row, edit) || !cloud.onOriginSignIn()) return;
  if (!ledger.publish(rowAddress(edit), order)) return;
  queryClient.setQueryData(saveItemsQuery(scope, edit.kind).queryKey, (held) =>
    held === undefined ? held : withOwnWrite(held, edit, row),
  );
}

/** One save of an editor session, from its preparation to its apply. */
interface SaveOperation {
  /** The sign-in the save was pressed on. */
  readonly cloud: EnvironmentCloud;
  /** Its place among the session's saves ({@link SaveLedger}). */
  readonly order: number;
}

/**
 * Remembers `save`, made for `accountId`, if it maps to a proposal; answers
 * how to follow it.
 */
async function followSave(
  scope: SaveScope,
  operation: SaveOperation,
  save: SettingsSave,
  accountId: string,
): Promise<PendingSettingsSave> {
  const { coordinator, queryClient, environmentId, hostId } = scope;
  // A base read this save makes goes out on the save's own sign-in.
  const reads: EditBaseScope = { ...scope, source: () => operation.cloud };
  const rowsOf = async (kind: string, key: string) =>
    (await queryClient.fetchQuery(saveItemsQuery(reads, kind))).filter(
      (row) => row.key === key,
    );
  const host = await queryClient.fetchQuery(saveHostQuery(reads, hostId));
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
  // Nothing is remembered for a press whose sign-in has ended.
  if (!operation.cloud.onOriginSignIn()) {
    return { kind: "abandoned", method: save.method };
  }
  const beginning = await coordinator.begin(
    mapping,
    {
      accountId,
      environmentId,
      hostId,
      sharingGeneration: host.sharingGeneration,
      expectedLiveRevision: liveRowAt(editRows, edit.os)?.revision ?? null,
    },
    () => {
      void keepOwnWrite(scope, operation, edit).catch(() => undefined);
    },
  );
  if (beginning.kind === "account_changed") {
    return { kind: "abandoned", method: save.method };
  }
  if (beginning.kind === "nothing_to_remember") return NOTHING_TO_FOLLOW;
  const { ticket } = beginning;
  return {
    kind: "send",
    answered: () => {
      void coordinator.settle(ticket, true);
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
  const [session] = useState(() => crypto.randomUUID());
  const [ledger] = useState(createSaveLedger);
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
            ledger,
          },
    [
      coordinator,
      queryClient,
      source,
      environmentId,
      hostId,
      viewerId,
      session,
      ledger,
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
      pressedOn: EnvironmentCloud | null,
    ): Promise<PendingSettingsSave> => {
      // The save was pressed on `pressedOn`: once that sign-in has ended it
      // is not sent, wherever it was going, followed or not.
      if (pressedOn !== null && !pressedOn.onOriginSignIn()) {
        return { kind: "abandoned", method: save.method };
      }
      if (scope === null || pressedOn === null) return NOTHING_TO_FOLLOW;
      // The editor, and whatever the caller read from authn for this save,
      // belong to `scope.viewerId`: a save prepared once anyone else is
      // signed in is not sent, wherever it was going.
      const isEditorsAccount = (): boolean =>
        signedInViewer() === scope.viewerId;
      if (!isEditorsAccount()) {
        return { kind: "abandoned", method: save.method };
      }
      if (sentOn !== scope.hostId) return NOTHING_TO_FOLLOW;
      const accountId = scope.coordinator.account();
      if (accountId === null) return NOTHING_TO_FOLLOW;
      const operation: SaveOperation = {
        cloud: pressedOn,
        order: scope.ledger.take(),
      };
      let pending: PendingSettingsSave;
      try {
        pending = await followSave(scope, operation, save, accountId);
      } catch {
        pending = NOTHING_TO_FOLLOW;
      }
      if (
        pressedOn.onOriginSignIn() &&
        isEditorsAccount() &&
        scope.coordinator.account() === accountId
      ) {
        return pending;
      }
      // Pressed on a sign-in that has ended: it is not sent, and its record,
      // if remembered in that account's memory, is not out.
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
