/**
 * Shared harness for the Judge tab suites: fixtures, the catalog / providers
 * state the mocked hooks read, and the mock factories that let the REAL
 * `HarnessModelPicker` render inside the judge's second tile.
 *
 * `vi.mock` calls stay in each suite (they are hoisted per file); their
 * factories delegate here through a dynamic import, which resolves to the same
 * module instance the suite imports, so both share one state.
 */
import { useSyncExternalStore } from "react";
import { vi } from "vitest";
import type { GuiHarnessOption } from "@traycer/protocol/host/index";
import {
  guiAgentModelOptionSchema,
  guiHarnessOptionSchema,
  type GuiAgentModelOption,
} from "@traycer/protocol/host/agent/gui/unary-schemas";
import type {
  ProviderCliState,
  ProviderId,
  ProviderProfile,
} from "@traycer/protocol/host/provider-schemas";

// ---- fixtures -------------------------------------------------------------

export function harness(
  overrides: Partial<GuiHarnessOption>,
): GuiHarnessOption {
  return guiHarnessOptionSchema.parse({
    id: "claude",
    label: "Claude Code",
    available: true,
    error: null,
    modes: ["gui"],
    requiresApiKey: false,
    ...overrides,
  });
}

export function model(
  harnessId: string,
  slug: string,
  label: string,
): GuiAgentModelOption {
  return guiAgentModelOptionSchema.parse({
    harnessId,
    slug,
    label,
    description: null,
    contextWindow: null,
    maxOutputTokens: null,
    defaultReasoningEffort: null,
    supportedReasoningEfforts: [],
    metadata: {},
  });
}

export function profile(
  profileId: string,
  kind: ProviderProfile["kind"],
): ProviderProfile {
  return {
    profileId,
    enabled: true,
    kind,
    authType: "oauth",
    label: profileId,
    auth: {
      status: "authenticated",
      badgeText: null,
      label: null,
      detail: null,
    },
    identity: null,
    usageUpdatedAt: null,
    rateLimitStatus: "unknown",
    rateLimitLimitedScopes: null,
    duplicateOfProfileId: null,
    ambientDriftNotice: null,
    accentColor: null,
  };
}

export function provider(
  providerId: ProviderId,
  profiles: ProviderProfile[],
): ProviderCliState {
  return {
    providerId,
    enabled: true,
    disabledBy: null,
    selected: { kind: "bundled" },
    candidates: [],
    authPending: false,
    checkedAt: null,
    apiKey: { supported: false, configured: false, source: null },
    terminalAgentArgs: "",
    envOverrides: [],
    loginCapability: null,
    availabilityPending: false,
    managedInstallState: null,
    versionVisibility: null,
    advisory: null,
    profiles,
    auth: {
      status: "authenticated",
      badgeText: null,
      label: null,
      detail: null,
    },
    nativeCapabilities: {
      supportedTabs: ["general", "env", "usage"],
      mcp: null,
      plugins: null,
      skills: null,
      modelProviders: null,
    },
  };
}

// ---- the catalog the mocked hooks answer ----------------------------------

export type ModelsState =
  | { readonly kind: "pending" }
  | {
      readonly kind: "ready";
      readonly models: ReadonlyArray<GuiAgentModelOption>;
    }
  | { readonly kind: "error" };

const PENDING_MODELS: ModelsState = { kind: "pending" };

interface CatalogState {
  harnesses: ReadonlyArray<GuiHarnessOption>;
  /** What the harness catalog query answers: data, a failure, or pending. */
  harnessesStatus: "answered" | "failed" | "pending";
  /** `undefined` models `providers.list` still loading. */
  providers: ReadonlyArray<ProviderCliState> | undefined;
}

export const judgeCatalog: CatalogState = {
  harnesses: [],
  harnessesStatus: "answered",
  providers: [],
};

let modelStates: Record<string, ModelsState> = {};
let version = 0;
const listeners = new Set<() => void>();

function notify(): void {
  version += 1;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Sets one harness's model catalog; a change re-renders every reader. */
export function setModels(harnessId: string, next: ModelsState): void {
  modelStates = { ...modelStates, [harnessId]: next };
  notify();
}

/** Every harness's model catalog goes back to pending. */
export function resetModels(): void {
  modelStates = {};
  notify();
}

function modelsFor(harnessId: string): ModelsState {
  return modelStates[harnessId] ?? PENDING_MODELS;
}

function useCatalogVersion(): number {
  return useSyncExternalStore(subscribe, () => version);
}

interface ModelsResult {
  readonly data:
    | { readonly harnessId: string; readonly models: GuiAgentModelOption[] }
    | undefined;
  readonly isPending: boolean;
  readonly isError: boolean;
  readonly error: Error | null;
  readonly refetch: () => Promise<{ readonly data: undefined }>;
}

const modelsResultCache = new Map<
  string,
  {
    readonly state: ModelsState;
    readonly enabled: boolean;
    readonly result: ModelsResult;
  }
>();

/** One result per (harness, state): the same object until the state moves. */
function modelsResult(harnessId: string, enabled: boolean): ModelsResult {
  const state = modelsFor(harnessId);
  const cached = modelsResultCache.get(harnessId);
  if (
    cached !== undefined &&
    cached.state === state &&
    cached.enabled === enabled
  ) {
    return cached.result;
  }
  const result: ModelsResult = {
    data:
      enabled && state.kind === "ready"
        ? { harnessId, models: [...state.models] }
        : undefined,
    isPending: state.kind === "pending",
    isError: state.kind === "error",
    error: state.kind === "error" ? new Error("models failed") : null,
    refetch: () => Promise.resolve({ data: undefined }),
  };
  modelsResultCache.set(harnessId, { state, enabled, result });
  return result;
}

interface CatalogEntries {
  readonly harnesses: ReadonlyArray<GuiHarnessOption & CatalogEntryModels>;
  readonly harnessesLoading: boolean;
  readonly harnessesError: null;
  readonly modelsLoading: boolean;
}

interface CatalogEntryModels {
  readonly models: GuiAgentModelOption[];
  readonly modelsLoading: boolean;
  readonly modelsError: null;
}

let entriesCache: {
  readonly version: number;
  readonly harnesses: ReadonlyArray<GuiHarnessOption>;
  readonly enabled: boolean;
  readonly value: CatalogEntries;
} | null = null;

/** The composed catalog, by identity while nothing under it moved. */
function catalogEntries(enabled: boolean): CatalogEntries {
  const cached = entriesCache;
  if (
    cached !== null &&
    cached.version === version &&
    cached.harnesses === judgeCatalog.harnesses &&
    cached.enabled === enabled
  ) {
    return cached.value;
  }
  const value: CatalogEntries = {
    harnesses: enabled
      ? judgeCatalog.harnesses.map((row) => {
          const state = modelsFor(row.id);
          return {
            ...row,
            models: state.kind === "ready" ? [...state.models] : [],
            modelsLoading: state.kind === "pending",
            modelsError: null,
          };
        })
      : [],
    harnessesLoading: false,
    harnessesError: null,
    modelsLoading: false,
  };
  entriesCache = {
    version,
    harnesses: judgeCatalog.harnesses,
    enabled,
    value,
  };
  return value;
}

interface Activity {
  readonly enabled: boolean;
  readonly subscribed: boolean;
}

/**
 * `@/hooks/harnesses/use-gui-harness-catalog`, answering from `judgeCatalog`
 * and the per-harness model states. Both the judge tab's default-host hooks
 * and the picker's `…ForClient` ones read the same state.
 */
export async function guiHarnessCatalogModuleMock(): Promise<
  Record<string, unknown>
> {
  const actual = await vi.importActual<
    typeof import("@/hooks/harnesses/use-gui-harness-catalog")
  >("@/hooks/harnesses/use-gui-harness-catalog");
  const harnessesResult = (): {
    readonly data:
      | { readonly harnesses: ReadonlyArray<GuiHarnessOption> }
      | undefined;
    readonly isPending: boolean;
    readonly isError: boolean;
    readonly error: Error | null;
  } => ({
    data:
      judgeCatalog.harnessesStatus === "answered"
        ? { harnesses: judgeCatalog.harnesses }
        : undefined,
    isPending: judgeCatalog.harnessesStatus === "pending",
    isError: judgeCatalog.harnessesStatus === "failed",
    error:
      judgeCatalog.harnessesStatus === "failed" ? new Error("failed") : null,
  });
  return {
    ...actual,
    harnessCatalogEntryNeedsRefresh: (): boolean => true,
    useGuiHarnessesQuery: (activity: Activity) => {
      useCatalogVersion();
      return activity.enabled
        ? harnessesResult()
        : { data: undefined, isPending: true, isError: false, error: null };
    },
    useGuiHarnessesQueryForClient: (_client: unknown, activity: Activity) => {
      useCatalogVersion();
      return activity.enabled
        ? harnessesResult()
        : { data: undefined, isPending: true, isError: false, error: null };
    },
    useGuiHarnessModelsQuery: (
      harnessId: string,
      _workingDirectory: string | null,
      activity: Activity,
    ) => {
      useCatalogVersion();
      return modelsResult(harnessId, activity.enabled);
    },
    useGuiHarnessModelsQueryForClient: (
      _client: unknown,
      harnessId: string,
      _workingDirectory: string | null,
      activity: Activity,
    ) => {
      useCatalogVersion();
      return modelsResult(harnessId, activity.enabled);
    },
    useGuiHarnessCommandsQuery: (
      _client: unknown,
      harnessId: string,
      _workingDirectories: ReadonlyArray<string>,
      activity: Activity,
    ) => ({
      data: activity.enabled ? { harnessId, commands: [] } : undefined,
      isPending: false,
      error: null,
      refetch: () => Promise.resolve({ data: undefined }),
    }),
    useGuiHarnessCatalogForClient: (
      _client: unknown,
      _workingDirectory: string | null,
      activity: Activity,
    ) => {
      useCatalogVersion();
      return catalogEntries(activity.enabled);
    },
    useRefreshHarnessCatalogForClient: () => () => Promise.resolve(),
  };
}

/** `@/hooks/providers/use-providers-list-query`, answering `judgeCatalog`. */
export async function providersListModuleMock(): Promise<
  Record<string, unknown>
> {
  const actual = await vi.importActual<
    typeof import("@/hooks/providers/use-providers-list-query")
  >("@/hooks/providers/use-providers-list-query");
  const result = (
    activity: Activity,
  ): {
    readonly data:
      | { readonly providers: ReadonlyArray<ProviderCliState> }
      | undefined;
    readonly isPending: boolean;
    readonly isError: boolean;
    readonly error: null;
    readonly isFetching: boolean;
  } => ({
    data:
      activity.enabled && judgeCatalog.providers !== undefined
        ? { providers: judgeCatalog.providers }
        : undefined,
    isPending: judgeCatalog.providers === undefined,
    isError: false,
    error: null,
    isFetching: false,
  });
  return {
    ...actual,
    useProvidersList: (activity: Activity) => result(activity),
    useProvidersListForClient: (_client: unknown, activity: Activity) =>
      result(activity),
  };
}

// ---- the host plumbing the picker reads ------------------------------------

interface StandInClient {
  readonly id: string;
  getActiveHostId(): string | null;
  getActiveHost(): { readonly websocketUrl: string | null } | null;
}

/** The small set of host hooks the picker resolves its target through. */
export const pickerHostMocks = {
  clientForHostId: (): {
    useHostClientForHostId: (hostId: string | null) => StandInClient;
  } => ({
    useHostClientForHostId: (hostId: string | null): StandInClient => ({
      id: hostId ?? "default",
      getActiveHostId: () => hostId ?? "default",
      getActiveHost: () => ({ websocketUrl: "ws://127.0.0.1:59998/stream" }),
    }),
  }),
  reactiveHostReadiness: (): {
    useReactiveHostReadiness: (client: StandInClient | null) => {
      readonly hostId: string | null;
      readonly requestContextUserId: string;
      readonly isReady: boolean;
      readonly hasRpcEndpoint: boolean;
      readonly canExecute: boolean;
    };
  } => ({
    useReactiveHostReadiness: (client) => {
      const hostId = client?.getActiveHostId() ?? null;
      return {
        hostId,
        requestContextUserId: "user-1",
        isReady: hostId !== null,
        hasRpcEndpoint: true,
        canExecute: hostId !== null,
      };
    },
  }),
  hostReachability: () => ({
    useHostReachability: (hostId: string) => ({
      status: "reachable",
      hostLabel: hostId,
      unavailability: null,
      basis: "directory",
      hostKind: "local",
    }),
  }),
  addressableHostId: () => ({ useAddressableHostId: () => "host-a" }),
  hostDirectoryList: () => ({
    useHostDirectoryList: () => ({
      data: [
        {
          hostId: "host-a",
          kind: "local",
          label: "Local host",
          transportDialability: "dialable",
          websocketUrl: "ws://127.0.0.1:0",
        },
      ],
    }),
  }),
  ensurePack: () => ({
    useProvidersEnsurePackForClient: () => ({ mutate: vi.fn() }),
  }),
  setProfileEnabled: () => ({
    useProviderProfileEnablementPending: () => () => false,
    useProvidersSetProfileEnabledForClient: () => ({
      mutate: vi.fn(),
      isPending: false,
    }),
  }),
  profileUsage: () => ({
    useProfileUsageComparison: (args: {
      readonly runTargetHostId: string | null;
    }) => ({
      hostId: args.runTargetHostId,
      isReady: true,
      entries: new Map(),
    }),
  }),
  virtuoso: async () => ({
    Virtuoso: (await import("./judge-virtuoso-stand-in")).VirtuosoStandIn,
  }),
};
