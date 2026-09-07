import { useQueryClient, type UseQueryResult } from "@tanstack/react-query";
import { useCallback, useMemo } from "react";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import { hostQueryKeys } from "@/lib/query-keys";
import { PROVIDER_INVALIDATIONS } from "@/hooks/providers/invalidations";
import { useRefreshProvidersForClient } from "@/hooks/providers/use-refresh-providers";
import { useHostBinding, useHostClient } from "@/lib/host";
import { resolveSubtreeHostClient } from "@/lib/host/binding-host-client";
import { useEffectiveHostId } from "@/hooks/host/use-effective-host-id";
import type {
  GuiHarnessOption,
  GuiHarnessId,
  ListGuiAgentCommandsResponse,
  ListGuiAgentModelsResponse,
  ListGuiHarnessesResponse,
} from "@traycer/protocol/host/index";
import type { HostRpcRegistry } from "@/lib/host";
import {
  useHostQuery,
  type UseHostQueryOptions,
} from "@/hooks/host/use-host-query";
import { useHostQueries } from "@/hooks/host/use-host-queries";
import { getConditionPollEpisodeCoordinator } from "@/lib/query/condition-poll-episode-coordinator";

// Cache-only model catalogs (`staleTime: Infinity`). Only the app-load fill may fan out. Recovery must not invalidate listModels / listCommands. This window matches the host OpenCode idle timeout.
export const HARNESS_CATALOG_REFRESH_AFTER_MS = 15 * 60 * 1000;
const HARNESS_AVAILABILITY_REFRESH_MS = 15 * 60 * 1000;

export interface HarnessCatalogEntryFreshness {
  readonly dataUpdatedAt: number;
  readonly isError: boolean;
  readonly isFetching: boolean;
}

/** Intent-edge refresh only. Skip in-flight fetches (imperative refetch would cancel them). Always due on error or never-loaded. */
export function harnessCatalogEntryNeedsRefresh(
  entry: HarnessCatalogEntryFreshness,
): boolean {
  if (entry.isFetching) return false;
  if (entry.isError || entry.dataUpdatedAt === 0) return true;
  return Date.now() - entry.dataUpdatedAt >= HARNESS_CATALOG_REFRESH_AFTER_MS;
}

/** `enabled` gates fetch; `subscribed` gates cache attachment. Hidden surfaces pass both false. */
export interface QueryActivityOptions {
  readonly enabled: boolean;
  readonly subscribed: boolean;
}

/** `"all-harnesses"` fans out (app-load only). `"cached-only"` never fetches missing slots. */
export interface CatalogQueryActivityOptions extends QueryActivityOptions {
  readonly modelsFetch: "all-harnesses" | "cached-only";
}

export interface GuiHarnessCatalogEntry extends GuiHarnessOption {
  readonly models: ListGuiAgentModelsResponse["models"];
  readonly modelsLoading: boolean;
  readonly modelsError: HostRpcError | null;
}

export interface GuiHarnessCatalog {
  readonly harnesses: ReadonlyArray<GuiHarnessCatalogEntry>;
  readonly harnessesLoading: boolean;
  readonly harnessesError: HostRpcError | null;
  readonly modelsLoading: boolean;
}

const EMPTY_GUI_HARNESS_IDS: ReadonlyArray<GuiHarnessId> = [];
const EMPTY_GUI_HARNESS_CATALOG_ENTRIES: ReadonlyArray<GuiHarnessCatalogEntry> =
  [];
const EMPTY_GUI_MODEL_OPTIONS: ListGuiAgentModelsResponse["models"] = [];
const EMPTY_GUI_MODEL_REQUESTS: ReadonlyArray<{
  readonly method: "agent.gui.listModels";
  readonly params: {
    readonly harnessId: GuiHarnessId;
    readonly workingDirectory: string | null;
  };
}> = [];

// App-wide wrappers only. Composer surfaces use ...ForClient with the surface host.
function useDefaultHostClient(): HostClient<HostRpcRegistry> | null {
  // Read binding here so tests that mock useHostBinding still apply. null disables the wrappers.
  const binding = useHostBinding();
  const effectiveHostId = useEffectiveHostId();
  return useMemo(
    () => resolveSubtreeHostClient(binding, effectiveHostId),
    [binding, effectiveHostId],
  );
}

export function useGuiHarnessesQuery(
  activity: QueryActivityOptions,
): UseQueryResult<ListGuiHarnessesResponse, HostRpcError> {
  return useGuiHarnessesQueryForClient(useDefaultHostClient(), activity);
}

/** Client-scoped listHarnesses. null client disables; never fall back to the default host. */
export function useGuiHarnessesQueryForClient(
  client: HostClient<HostRpcRegistry> | null,
  activity: QueryActivityOptions,
): UseQueryResult<ListGuiHarnessesResponse, HostRpcError> {
  return useHostQuery<HostRpcRegistry, "agent.gui.listHarnesses">({
    cacheKeyIdentity: undefined,
    client,
    method: "agent.gui.listHarnesses",
    params: {},
    options: {
      enabled: activity.enabled,
      subscribed: activity.subscribed,
      staleTime: HARNESS_AVAILABILITY_REFRESH_MS,
    },
  });
}

export function useGuiHarnessModelsQuery(
  harnessId: GuiHarnessId,
  workingDirectory: string | null,
  activity: QueryActivityOptions,
): UseQueryResult<ListGuiAgentModelsResponse, HostRpcError> {
  return useGuiHarnessModelsQueryForClient(
    useDefaultHostClient(),
    harnessId,
    workingDirectory,
    activity,
  );
}

/** Client-scoped `agent.gui.listModels`; see `useGuiHarnessesQueryForClient`. */
export function useGuiHarnessModelsQueryForClient(
  client: HostClient<HostRpcRegistry> | null,
  harnessId: GuiHarnessId,
  workingDirectory: string | null,
  activity: QueryActivityOptions,
): UseQueryResult<ListGuiAgentModelsResponse, HostRpcError> {
  const params = useMemo(
    () => ({ harnessId, workingDirectory }),
    [harnessId, workingDirectory],
  );
  return useHostQuery<HostRpcRegistry, "agent.gui.listModels">({
    cacheKeyIdentity: undefined,
    client,
    method: "agent.gui.listModels",
    params,
    options: {
      enabled: activity.enabled,
      subscribed: activity.subscribed,
      staleTime: Infinity,
      // Inactive detaches the observer; keep the last verified catalog.
      gcTime: Infinity,
    },
  });
}

/** Single-harness listModels into the catalog slot. Gate enabled on availability. null harnessId mounts no query. */
export function useGuiHarnessModelsWarmup(
  client: HostClient<HostRpcRegistry> | null,
  harnessId: GuiHarnessId | null,
  activity: QueryActivityOptions,
): Array<UseQueryResult<ListGuiAgentModelsResponse, HostRpcError>> {
  const requests = useMemo(() => {
    if (harnessId === null) return EMPTY_GUI_MODEL_REQUESTS;
    return [
      {
        method: "agent.gui.listModels" as const,
        params: { harnessId, workingDirectory: null },
      },
    ];
  }, [harnessId]);
  return useHostQueries<HostRpcRegistry, "agent.gui.listModels">({
    client,
    cacheKeyIdentity: undefined,
    requests,
    options: {
      enabled: activity.enabled,
      subscribed: activity.subscribed,
      staleTime: Infinity,
      gcTime: Infinity,
    },
  });
}

export function useGuiHarnessCommandsQuery(
  client: HostClient<HostRpcRegistry> | null,
  harnessId: GuiHarnessId,
  workingDirectories: ReadonlyArray<string>,
  activity: QueryActivityOptions,
): UseQueryResult<ListGuiAgentCommandsResponse, HostRpcError> {
  const params = useMemo(
    () => guiHarnessCommandsQueryParams(harnessId, workingDirectories),
    [harnessId, workingDirectories],
  );
  return useHostQuery<HostRpcRegistry, "agent.gui.listCommands">({
    cacheKeyIdentity: undefined,
    client,
    method: "agent.gui.listCommands",
    params,
    options: {
      enabled: activity.enabled,
      subscribed: activity.subscribed,
      staleTime: HARNESS_CATALOG_REFRESH_AFTER_MS,
    },
  } satisfies UseHostQueryOptions<HostRpcRegistry, "agent.gui.listCommands">);
}

export function useGuiHarnessCatalog(
  workingDirectory: string | null,
  activity: CatalogQueryActivityOptions,
): GuiHarnessCatalog {
  return useGuiHarnessCatalogForClient(
    useDefaultHostClient(),
    workingDirectory,
    activity,
  );
}

/** Client-scoped harness + model catalog. Null client disables; never fall back to the default host. */
export function useGuiHarnessCatalogForClient(
  client: HostClient<HostRpcRegistry> | null,
  workingDirectory: string | null,
  activity: CatalogQueryActivityOptions,
): GuiHarnessCatalog {
  const harnessesQuery = useGuiHarnessesQueryForClient(client, activity);
  // Projection follows `subscribed` so `{ enabled: false, subscribed: true }` still reads cache.
  const attached = activity.subscribed;

  const harnessIds = useMemo(() => {
    if (!attached) return EMPTY_GUI_HARNESS_IDS;
    return (
      harnessesQuery.data?.harnesses.flatMap((harness) =>
        harness.available ? [harness.id] : [],
      ) ?? EMPTY_GUI_HARNESS_IDS
    );
  }, [attached, harnessesQuery.data?.harnesses]);

  const requests = useMemo(() => {
    if (harnessIds.length === 0) return EMPTY_GUI_MODEL_REQUESTS;
    return harnessIds.map((harnessId) => ({
      method: "agent.gui.listModels" as const,
      params: { harnessId, workingDirectory },
    }));
  }, [harnessIds, workingDirectory]);

  const modelQueries = useHostQueries<HostRpcRegistry, "agent.gui.listModels">({
    client,
    cacheKeyIdentity: undefined,
    requests,
    options: {
      // cached-only observers stay disabled: TanStack fetches empty slots regardless of staleTime.
      enabled: activity.enabled && activity.modelsFetch === "all-harnesses",
      staleTime: Infinity,
      gcTime: Infinity,
    },
  });

  const queryByHarnessId = useMemo(() => {
    const queryMap = new Map<GuiHarnessId, (typeof modelQueries)[number]>();
    harnessIds.forEach((id, index) => {
      queryMap.set(id, modelQueries[index]);
    });
    return queryMap;
  }, [harnessIds, modelQueries]);

  const harnesses = useMemo<ReadonlyArray<GuiHarnessCatalogEntry>>(
    () =>
      attached && harnessesQuery.data !== undefined
        ? harnessesQuery.data.harnesses.map((harness) => {
            const modelQuery = queryByHarnessId.get(harness.id);
            return {
              ...harness,
              models: modelQuery?.data?.models ?? EMPTY_GUI_MODEL_OPTIONS,
              // isPending is true for empty cached-only slots; isLoading means a fetch is happening.
              modelsLoading: modelQuery?.isLoading ?? false,
              modelsError:
                modelQuery?.error instanceof HostRpcError
                  ? modelQuery.error
                  : null,
            };
          })
        : EMPTY_GUI_HARNESS_CATALOG_ENTRIES,
    [attached, harnessesQuery.data, queryByHarnessId],
  );
  const modelsLoading = useMemo(
    () => modelQueries.some((query) => query.isLoading),
    [modelQueries],
  );
  // Disabled no-data queries report isPending forever.
  const harnessesLoading = client !== null && harnessesQuery.isPending;

  return useMemo(
    () => ({
      harnesses,
      harnessesLoading,
      harnessesError: harnessesQuery.error,
      modelsLoading,
    }),
    [harnesses, harnessesQuery.error, harnessesLoading, modelsLoading],
  );
}

const REFRESHABLE_CATALOG_METHODS = [
  "agent.gui.listHarnesses",
  "agent.gui.listModels",
  "agent.gui.listCommands",
] as const;

export type HarnessCatalogRefreshOutcome =
  | { readonly kind: "refreshed" }
  | {
      readonly kind: "unavailable";
      readonly reason: "host-unresolved" | "rpc-endpoint-absent";
    };

export function useRefreshHarnessCatalog(): () => Promise<HarnessCatalogRefreshOutcome> {
  return useRefreshHarnessCatalogForClient(useHostClient());
}

/** Invalidates this client's catalog keys. Unresolved host/endpoint returns unavailable and leaves queries unmodified. */
export function useRefreshHarnessCatalogForClient(
  client: HostClient<HostRpcRegistry> | null,
): () => Promise<HarnessCatalogRefreshOutcome> {
  const queryClient = useQueryClient();
  const refreshProviders = useRefreshProvidersForClient(client);
  return useCallback(async () => {
    const hostId = client?.getActiveHostId() ?? null;
    if (hostId === null) {
      return { kind: "unavailable", reason: "host-unresolved" };
    }
    if ((client?.getActiveHost()?.websocketUrl ?? null) === null) {
      return { kind: "unavailable", reason: "rpc-endpoint-absent" };
    }
    getConditionPollEpisodeCoordinator(queryClient).resetQueryByKey(
      hostQueryKeys.method<HostRpcRegistry, "agent.gui.listHarnesses">(
        hostId,
        "agent.gui.listHarnesses",
        {},
      ),
    );
    // Forced providers.list: catalog authStatus is omitted after 30s. Failure must not skip catalog refetch.
    const providersRefreshed = await refreshProviders().then(
      () => true,
      () => false,
    );
    // On success, providers.list already invalidated listHarnesses; skip it. On failure, invalidate every catalog method.
    await Promise.all(
      REFRESHABLE_CATALOG_METHODS.filter(
        (method) =>
          !providersRefreshed || !PROVIDER_INVALIDATIONS.includes(method),
      ).map((method) =>
        queryClient.invalidateQueries({
          queryKey: hostQueryKeys.methodScope(hostId, method),
        }),
      ),
    );
    return { kind: "refreshed" };
  }, [client, queryClient, refreshProviders]);
}

function guiHarnessCommandsQueryParams(
  harnessId: GuiHarnessId,
  workingDirectories: ReadonlyArray<string>,
) {
  const normalized = dedupeNonEmptyStrings(workingDirectories);
  return {
    harnessId,
    workingDirectory: normalized[0] ?? null,
    workingDirectories: normalized,
  };
}

function dedupeNonEmptyStrings(values: ReadonlyArray<string>): string[] {
  return Array.from(
    new Set(
      values.flatMap((value) => {
        const trimmed = value.trim();
        return trimmed.length > 0 ? [trimmed] : [];
      }),
    ),
  );
}
