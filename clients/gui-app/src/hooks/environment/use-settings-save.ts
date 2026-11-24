import { useCallback, useMemo, useState } from "react";
import {
  queryOptions,
  skipToken,
  useQueries,
  useQuery,
  useQueryClient,
  type QueryClient,
} from "@tanstack/react-query";
import { settingsSaveRequestId } from "@traycer/protocol/framework/settings-save-request-id";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type { AuthnItemRow } from "@traycer-clients/shared/environment/authn-environment-schemas";
import type {
  EnvironmentCloud,
  EnvironmentCloudSource,
} from "@traycer-clients/shared/environment/environment-cloud";
import {
  readSettingsItemRows,
  readSettingsSaveHost,
  readSettingsSavePersonal,
} from "@traycer-clients/shared/environment/settings-save-target";
import type { EnvironmentOs } from "@traycer/protocol/host/environment-schemas";
import { hostOsOfPlatform } from "@traycer/protocol/host/environment/host-os";
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
import { readHostMethodSchemaVersion } from "@/hooks/host/use-host-supports-method";
import type { AuthService } from "@/lib/auth/auth-service";
import { useHostBinding, type HostRpcRegistry } from "@/lib/host";
import type {
  PrebindSettingsSaveTarget,
  SettingsSaveBeginning,
  SettingsSaveCoordinator,
} from "@/lib/environment/settings-save-coordinator";
import type { PendingSettingsSave } from "@/lib/environment/settings-save-follow";
import type { SettingsSaveOrigin } from "@/lib/environment/settings-save-origin";
import { environmentQueryKeys } from "@/lib/query-keys";
import { useSettingsSaveCoordinator } from "@/providers/settings-save-coordinator-context";
import { useAuthStore } from "@/stores/auth/auth-store";

/**
 * Remembers what the host save will propose, so the app applies its own hold. Not
 * followed on any host but the requester's; not sent once the pressed sign-in ended.
 */
export type PrepareSettingsSave = (
  save: SettingsSave,
  sentOn: string | null,
  origin: SettingsSaveOrigin,
) => Promise<PendingSettingsSave>;

function signedInViewer(): string {
  return useAuthStore.getState().contextMetadata?.userId ?? "";
}

const NOTHING_TO_FOLLOW: PendingSettingsSave = {
  kind: "send",
  answered: () => undefined,
  failed: () => undefined,
};

// The revision edited over is the one read when the editor opened, so a newer value
// from elsewhere makes the hold a conflict in the review list.
const EDIT_BASE_READ = {
  staleTime: Number.POSITIVE_INFINITY,
  refetchOnWindowFocus: false,
  refetchOnReconnect: false,
  retry: false,
} as const;

interface EditBaseScope {
  readonly source: EnvironmentCloudSource | null;
  readonly environmentId: string;
  readonly viewerId: string;
  readonly session: string;
}

/** A read begun once anyone else is signed in, or answered after its sign-in ended, throws and caches nothing. */
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
    throw new Error("Please sign in again.");
  }
  return answer;
}

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
  readonly session: string;
  readonly ledger: SaveLedger;
}

/** A delete is ordered as a put: an absent row says nothing of which save removed it. */
interface SaveLedger {
  readonly take: () => number;
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

function rowAddress(edit: SettingsItemEdit): string {
  return JSON.stringify([edit.kind, edit.key, edit.os]);
}

function isOwnWrite(row: AuthnItemRow | null, edit: SettingsItemEdit): boolean {
  if (edit.operation === "delete") return row === null;
  if (row === null) return false;
  const value = settingValueSchema.safeParse(row.value);
  return (
    value.success && canonicalSettingValue(value.data) === edit.canonicalValue
  );
}

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
 * Only a row this session's own applied save wrote moves the base; a row anyone
 * else wrote leaves it, so the next edit waits in review. A read answered after a
 * later save moved the same row's base leaves it there.
 */
async function keepOwnWrite(
  scope: SaveScope,
  operation: SaveOperation,
  edit: SettingsItemEdit,
): Promise<void> {
  const { queryClient, environmentId, ledger } = scope;
  const { cloud, order } = operation;
  // A read on any later sign-in is another person's view of the row.
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

interface SaveOperation {
  readonly cloud: EnvironmentCloud;
  readonly order: number;
}

async function readBoundSave(
  scope: SaveScope,
  cloud: EnvironmentCloud,
  save: SettingsSave,
) {
  const { queryClient, hostId } = scope;
  // A base read this save makes goes out on the save's own sign-in.
  const reads: EditBaseScope = { ...scope, source: () => cloud };
  const rowsOf = async (kind: string, key: string) =>
    (await queryClient.fetchQuery(saveItemsQuery(reads, kind))).filter(
      (row) => row.key === key,
    );
  const host = await queryClient.fetchQuery(saveHostQuery(reads, hostId));
  if (host === null) return undefined;
  const address = settingsSaveBaseAddress(save);
  const baseRows =
    address === null ? [] : await rowsOf(address.kind, address.key);
  const mapping = settingsSaveItemEdit(save, {
    rows: baseRows.map((row) => ({ os: row.os, value: row.value })),
    hostOs: host.hostOs,
  });
  if (mapping.kind === "unmapped" && mapping.reason === "host_os_unknown") {
    return undefined;
  }
  if (mapping.kind !== "proposal") return null;
  const { edit } = mapping;
  const editRows =
    address?.kind === edit.kind && address.key === edit.key
      ? baseRows
      : await rowsOf(edit.kind, edit.key);
  return {
    mapping,
    sharingGeneration: host.sharingGeneration,
    expectedLiveRevision: liveRowAt(editRows, edit.os)?.revision ?? null,
  };
}

async function followSave(
  scope: SaveScope,
  operation: SaveOperation,
  save: SettingsSave,
  accountId: string,
  onUnanswered: () => Promise<PendingSettingsSave>,
): Promise<PendingSettingsSave> {
  const { coordinator, environmentId, hostId } = scope;
  const base = await readBoundSave(scope, operation.cloud, save).catch(
    () => undefined,
  );
  // Nothing is remembered for a press whose sign-in has ended.
  if (!operation.cloud.onOriginSignIn()) {
    return { kind: "abandoned", method: save.method };
  }
  if (base === undefined) return onUnanswered();
  if (base === null) return NOTHING_TO_FOLLOW;
  const { mapping, expectedLiveRevision, sharingGeneration } = base;
  const beginning = await coordinator.begin(
    mapping,
    { accountId, environmentId, hostId, sharingGeneration, expectedLiveRevision },
    () => {
      void keepOwnWrite(scope, operation, mapping.edit).catch(() => undefined);
    },
  );
  return followBeginning(coordinator, beginning, save);
}

function followBeginning(
  coordinator: SettingsSaveCoordinator,
  beginning: SettingsSaveBeginning,
  save: SettingsSave,
): PendingSettingsSave {
  if (beginning.kind === "account_changed") {
    return { kind: "abandoned", method: save.method };
  }
  if (beginning.kind === "nothing_to_remember") return NOTHING_TO_FOLLOW;
  const { ticket } = beginning;
  return {
    kind: "send",
    requestId: settingsSaveRequestId(ticket.id),
    answered: () => {
      void coordinator.settle(ticket, true);
    },
    failed: () => {
      void coordinator.settle(ticket, false);
    },
  };
}

interface LocalSaveScope {
  readonly coordinator: SettingsSaveCoordinator;
  readonly auth: AuthService;
  readonly client: HostClient<HostRpcRegistry>;
  readonly hostId: string;
  readonly beforeBinding: boolean;
  readonly viewerId: string;
}

async function readAcceptedMoveAtPress(
  scope: LocalSaveScope,
): Promise<string | null> {
  const { client, hostId } = scope;
  const version = readHostMethodSchemaVersion(hostId, "environment.status");
  if (version !== null && (version.major !== 1 || version.minor < 3)) return null;
  if (client.getActiveHostId() !== hostId) return null;
  const context = client.getRequestContext();
  const { move } = await client.request("environment.status", {}).catch(() => ({
    move: null,
  }));
  if (
    client.getActiveHostId() !== hostId ||
    client.getRequestContext() !== context
  ) {
    return null;
  }
  return move === null || move.state === "done" ? null : move.acceptanceId;
}

function unansweredMoveTarget(
  save: SettingsSave,
  environmentId: string | null,
  acceptanceId: string | null,
): PrebindSettingsSaveTarget | null {
  const unknown = environmentId === null ? null : { environmentId, item: null };
  if (acceptanceId === null) return unknown;
  const base = { rows: [], hostOs: null, prebind: true as const };
  const stated = settingsSaveItemEdit(save, base);
  const resolveHostOs =
    stated.kind === "unmapped" && stated.reason === "host_os_unknown";
  const mapping = resolveHostOs
    ? settingsSaveItemEdit(save, { ...base, prebind: "unanswered" })
    : stated;
  return mapping.kind === "proposal"
    ? { environmentId, acceptanceId, resolveHostOs, edit: mapping.edit }
    : unknown;
}

async function followLocalSave(
  scope: LocalSaveScope,
  save: SettingsSave,
  accountId: string,
  cloud: EnvironmentCloud,
  readTarget: () => Promise<PrebindSettingsSaveTarget | null>,
): Promise<PendingSettingsSave> {
  const { coordinator, hostId } = scope;
  const beginning = await coordinator.beginLocal(
    { accountId, hostId, onOriginSignIn: cloud.onOriginSignIn },
    readTarget,
  );
  return followBeginning(coordinator, beginning, save);
}

async function readPrebindTarget(
  scope: LocalSaveScope,
  cloud: EnvironmentCloud,
  save: SettingsSave,
  acceptedMove: Promise<string | null>,
): Promise<PrebindSettingsSaveTarget | null> {
  const { auth, hostId } = scope;
  const unavailable = async (environmentId: string | null) =>
    unansweredMoveTarget(save, environmentId, await acceptedMove);
  let environmentId: string;
  try {
    environmentId = await readSettingsSavePersonal(cloud);
  } catch {
    return unavailable(null);
  }
  const targetWithoutItem = { environmentId, item: null };
  const rowsOf = async (kind: string, key: string) =>
    (await readSettingsItemRows(cloud, environmentId, kind)).filter(
      (row) => row.key === key,
    );
  try {
    const address = settingsSaveBaseAddress(save);
    const baseRows =
      address === null ? [] : await rowsOf(address.kind, address.key);
    const base = { rows: baseRows, hostOs: null, prebind: true as const };
    let mapping = settingsSaveItemEdit(save, base);
    if (mapping.kind === "unmapped" && mapping.reason === "host_os_unknown") {
      if (!cloud.onOriginSignIn()) return null;
      const registry = await auth.fetchRegisteredHosts(auth.currentAuthEra());
      const platform = registry?.hosts.find(
        (host) => host.hostId === hostId,
      )?.platform;
      mapping = settingsSaveItemEdit(save, {
        ...base,
        hostOs: hostOsOfPlatform(platform ?? null),
      });
    }
    if (mapping.kind !== "proposal") {
      return mapping.kind === "unmapped" && mapping.reason === "host_os_unknown"
        ? unavailable(environmentId)
        : targetWithoutItem;
    }
    const { edit } = mapping;
    const rows =
      address?.kind === edit.kind && address.key === edit.key
        ? baseRows
        : await rowsOf(edit.kind, edit.key);
    return {
      environmentId,
      item: {
        edit,
        expectedLiveRevision: liveRowAt(rows, edit.os)?.revision ?? null,
      },
    };
  } catch {
    return unavailable(environmentId);
  }
}

interface SaveScopes {
  readonly shared: SaveScope | null;
  readonly local: LocalSaveScope | null;
}

function useSaveScope(
  client: HostClient<HostRpcRegistry> | null,
  kinds: readonly string[],
): SaveScopes {
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
  const auth = useHostBinding()?.auth ?? null;
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
  const local = useMemo<LocalSaveScope | null>(
    () =>
      coordinator !== null &&
      auth !== null &&
      client !== null &&
      hostId !== null &&
      viewerId.length > 0
        ? {
            coordinator,
            auth,
            client,
            hostId,
            viewerId,
            beforeBinding:
              environmentRead.kind === "own_settings" ||
              environmentRead.kind === "pending",
          }
        : null,
    [auth, client, coordinator, environmentRead.kind, hostId, viewerId],
  );
  return { shared: scope, local };
}

/** A save made while the host uses its own settings can be followed after it binds. */
export function useSettingsSave(
  client: HostClient<HostRpcRegistry> | null,
  kinds: readonly string[],
): PrepareSettingsSave {
  const { shared, local } = useSaveScope(client, kinds);
  return useCallback(
    async (
      save: SettingsSave,
      sentOn: string | null,
      origin: SettingsSaveOrigin,
    ): Promise<PendingSettingsSave> => {
      // SettingsSave enumerates host writes, never named authn row writes.
      // A press with no sign-in stays host-only even if an account appears.
      if (origin.kind === "no_sign_in_at_press") return NOTHING_TO_FOLLOW;
      const pressedOn = origin.operation;
      if (!pressedOn.onOriginSignIn()) {
        return { kind: "abandoned", method: save.method };
      }
      const scope = shared ?? local;
      if (scope === null) return NOTHING_TO_FOLLOW;
      // A save prepared once anyone else is signed in is not sent.
      const isEditorsAccount = (): boolean =>
        signedInViewer() === scope.viewerId;
      if (!isEditorsAccount()) {
        return { kind: "abandoned", method: save.method };
      }
      if (sentOn !== scope.hostId) return NOTHING_TO_FOLLOW;
      const accountId = scope.coordinator.account();
      if (accountId === null) return NOTHING_TO_FOLLOW;
      let pending: PendingSettingsSave = NOTHING_TO_FOLLOW;
      try {
        // Begin on the requester before any cloud read can outlast this Move.
        const acceptedMove = local === null
          ? Promise.resolve(null)
          : readAcceptedMoveAtPress(local);
        const followWithMove = async (
          environmentId: string | null,
        ): Promise<PendingSettingsSave> => {
          const acceptanceId = await acceptedMove;
          if (local === null || acceptanceId === null) return NOTHING_TO_FOLLOW;
          return followLocalSave(local, save, accountId, pressedOn, async () =>
            unansweredMoveTarget(save, environmentId, acceptanceId),
          );
        };
        if (shared !== null) {
          pending = await followSave(
            shared,
            { cloud: pressedOn, order: shared.ledger.take() },
            save,
            accountId,
            () => followWithMove(shared.environmentId),
          );
        } else if (local?.beforeBinding === true) {
          pending = await followLocalSave(local, save, accountId, pressedOn, () =>
            readPrebindTarget(local, pressedOn, save, acceptedMove),
          );
        } else {
          pending = await followWithMove(null);
        }
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
      // Pressed on a sign-in that has ended: not sent, and its remembered record is not out.
      if (pending.kind === "send") pending.failed();
      return { kind: "abandoned", method: save.method };
    },
    [local, shared],
  );
}

/** A host may say which item to look for, never that it exists. */
export type SettingsItemExists = (key: string) => Promise<boolean>;

export function useSettingsItemExists(
  client: HostClient<HostRpcRegistry> | null,
  kind: string,
): SettingsItemExists {
  const { shared: scope } = useSaveScope(client, [kind]);
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
