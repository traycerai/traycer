import { useState, type ReactNode } from "react";
import { vi } from "vitest";
import type {
  ChatRunSettings,
  LastFailedAttempt,
  PendingFallback,
} from "@traycer/protocol/host/agent/gui/subscribe";
import type { ChatFallbackListTargetsResponse } from "@traycer/protocol/host/chat-fallback";
import type {
  ProviderCliState,
  ProviderProfile,
} from "@traycer/protocol/host/provider-schemas";
import type {
  HarnessOption,
  ModelOption,
} from "@/components/home/data/landing-options";
import { profileCommitId } from "@/components/providers/provider-profile-model";
import type { ProfileUsageDetailState } from "@/lib/rate-limits/profile-usage-comparison-state";
import type { FallbackChoiceLease } from "@/stores/chats/chat-session-store";
import { ALL_PERMISSION_MODES } from "@traycer/protocol/persistence/epic/foundation";
import {
  FAILED_CLAUDE_TUPLE,
  TARGET_CODEX_TUPLE,
  pendingFallback,
} from "./fallback-fixtures";

/**
 * Shared doubles for the routing chooser's suites.
 *
 * `vi.mock` factories cannot be shared, but the STATE and the module bodies
 * they return can: each suite mocks the same modules with
 * `vi.mock(path, async () => (await import("./routing-picker-kit")).xModule())`
 * and drives one `kit` object. The chooser mounts the real model picker, so
 * the doubles below stand in for exactly the host-backed reads that picker and
 * the chooser make - the catalog, the providers list, the usage comparison,
 * the listing, the hold and the two verbs - and nothing else.
 *
 * Every double records the CLIENT it was handed. The client here is a sentinel
 * keyed by the host id it was resolved for, so a suite can prove a read went
 * through the tab's host and not the app-wide one.
 */

export const EPIC_ID = "epic-routing";
export const CHAT_ID = "chat-routing";
/** The chat session's host: keys the session-store reads. */
export const SESSION_HOST_ID = "host-session";
/** The tab's host: the machine every RPC goes to. */
export const TAB_HOST_ID = "host-tab";
/** What `useHostClientForHostId(null)` - the app-wide default - resolves to. */
export const APP_WIDE_CLIENT_ID = "client:default";
export const TAB_CLIENT_ID = `client:${TAB_HOST_ID}`;
export const TRAVERSAL_ID = "traversal-routing";

export interface KitClient {
  readonly id: string;
  getActiveHostId(): string | null;
  getActiveHost(): { readonly websocketUrl: string | null } | null;
}

interface MutationCall {
  readonly clientId: string | null;
  readonly method: string;
  readonly variables: Record<string, unknown>;
}

interface UsageConfig {
  readonly detail: ProfileUsageDetailState;
  readonly fetchEligible: boolean;
  readonly refreshStatus: "idle" | "refreshing";
}

export interface SessionSlice {
  lastFailedAttempt: LastFailedAttempt | undefined;
  pendingFallback: PendingFallback | undefined;
  access: { readonly canAct: boolean } | null;
  connectionStatus: "connecting" | "open" | "reconnecting" | "closed";
  chat: { readonly settings: ChatRunSettings | null } | null;
  publishConfirmedManualFallbackAction: (input: unknown) => void;
  publishUnattendedFallbackOutcome: (input: unknown) => void;
}

function initialSession(): SessionSlice {
  return {
    lastFailedAttempt: undefined,
    pendingFallback: undefined,
    access: { canAct: true },
    connectionStatus: "open",
    chat: null,
    publishConfirmedManualFallbackAction: (input: unknown): void => {
      kit.confirmed.push(input);
    },
    publishUnattendedFallbackOutcome: (input: unknown): void => {
      kit.unattended.push(input);
    },
  };
}

function createSessionStore() {
  let state = initialSession();
  const listeners = new Set<() => void>();
  return {
    getState: (): SessionSlice => state,
    getInitialState: (): SessionSlice => initialSession(),
    setState: (next: Partial<SessionSlice>): SessionSlice => {
      state = { ...state, ...next };
      for (const listener of listeners) listener();
      return state;
    },
    reset: (): void => {
      state = initialSession();
    },
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

export const session = createSessionStore();

export const CLAUDE_HARNESS: HarnessOption = {
  id: "claude",
  label: "Claude",
  enabled: true,
  available: true,
  error: null,
  modes: ["gui", "tui"],
  requiresApiKey: false,
  supportedPermissionModes: [...ALL_PERMISSION_MODES],
  nativeAutoJudge: false,
  availabilityPending: false,
};

export const CODEX_HARNESS: HarnessOption = {
  ...CLAUDE_HARNESS,
  id: "codex",
  label: "Codex",
};

function model(overrides: Partial<ModelOption>): ModelOption {
  return {
    harnessId: "codex",
    slug: "gpt-test",
    label: "GPT Test",
    description: null,
    contextWindow: null,
    maxOutputTokens: null,
    defaultReasoningEffort: null,
    supportedReasoningEfforts: [],
    defaultServiceTier: null,
    supportedServiceTiers: [],
    deprecationNotice: null,
    metadata: {},
    ...overrides,
  };
}

const CLAUDE_MODELS: ReadonlyArray<ModelOption> = [
  model({
    harnessId: "claude",
    slug: "claude-sonnet-4",
    label: "Claude Sonnet 4",
  }),
  model({
    harnessId: "claude",
    slug: "claude-opus-4",
    label: "Claude Opus 4",
  }),
];

const CODEX_MODELS: ReadonlyArray<ModelOption> = [
  model({ harnessId: "codex", slug: "gpt-5", label: "GPT-5" }),
  model({ harnessId: "codex", slug: "gpt-4.1", label: "GPT-4.1" }),
];

interface CatalogCall {
  readonly hook: "harnesses" | "models" | "catalog";
  readonly clientId: string | null;
  readonly enabled: boolean;
}

export const kit = {
  // Every `client` a host-backed read was handed, and whether it was enabled.
  catalogCalls: [] as CatalogCall[],
  providerCalls: [] as Array<string | null>,
  labelCalls: [] as Array<string | null>,
  // The listing.
  listCalls: [] as Array<{
    readonly clientId: string | null;
    readonly enabled: boolean;
    readonly selector: unknown;
  }>,
  listData: undefined as ChatFallbackListTargetsResponse | undefined,
  listFetching: false,
  listError: false,
  // The hold (the wrapper's `useFallbackChoiceLease`, when a suite mocks it).
  lease: null as FallbackChoiceLease | null,
  hold: vi.fn<(traversalId: string) => void>(),
  release: vi.fn<() => void>(),
  // The verbs.
  mutations: [] as MutationCall[],
  mutationResult: { outcome: "applied", detail: null } as {
    readonly outcome: string;
    readonly detail: null;
  },
  mutationFails: false,
  deferResponses: false,
  pendingResponses: [] as Array<() => void>,
  // What the two publishers received.
  confirmed: [] as unknown[],
  unattended: [] as unknown[],
  toast: vi.fn<(message: string) => void>(),
  // The providers list and the per-account usage.
  providers: [] as ProviderCliState[],
  usage: new Map<string, UsageConfig>(),
  usageProbeCalls: [] as Array<{
    readonly runTargetHostId: string | null;
    readonly providerId: string;
  }>,
  ensureFreshCalls: [] as Array<{
    readonly providerId: string;
    readonly profileId: string | null;
  }>,
  refreshCalls: [] as Array<{
    readonly providerId: string;
    readonly profileId: string | null;
  }>,
  // An `ensureFresh` that never answers: the check is still in flight.
  ensureFreshHangs: false,
  // Model labels: `harnessId:model` -> label; `null` passes the slug through.
  modelLabels: null as ReadonlyMap<string, string> | null,
  openSettings: vi.fn<() => void>(),
};

export function resetKit(): void {
  kit.catalogCalls = [];
  kit.providerCalls = [];
  kit.labelCalls = [];
  kit.listCalls = [];
  kit.listData = undefined;
  kit.listFetching = false;
  kit.listError = false;
  kit.lease = null;
  kit.hold.mockReset();
  kit.release.mockReset();
  kit.mutations = [];
  kit.mutationResult = { outcome: "applied", detail: null };
  kit.mutationFails = false;
  kit.deferResponses = false;
  kit.pendingResponses = [];
  kit.confirmed = [];
  kit.unattended = [];
  kit.toast.mockReset();
  kit.providers = [];
  kit.usage = new Map();
  kit.usageProbeCalls = [];
  kit.ensureFreshCalls = [];
  kit.refreshCalls = [];
  kit.ensureFreshHangs = false;
  kit.modelLabels = null;
  kit.openSettings.mockReset();
  session.reset();
}

/* ------------------------------------------------------------------------- */
/* Fixtures                                                                  */
/* ------------------------------------------------------------------------- */

export function providerCliState(input: {
  readonly providerId: ProviderCliState["providerId"];
  readonly profiles: ProviderCliState["profiles"];
}): ProviderCliState {
  return {
    providerId: input.providerId,
    enabled: true,
    disabledBy: null,
    selected: { kind: "bundled" },
    candidates: [],
    auth: {
      status: "authenticated",
      badgeText: null,
      label: null,
      detail: null,
    },
    authPending: false,
    checkedAt: null,
    apiKey: { supported: false, configured: false, source: null },
    terminalAgentArgs: "",
    envOverrides: [],
    loginCapability: {
      oauthArgs: ["auth", "login"],
      token: null,
      codePaste: null,
      terminalLogin: null,
      remoteSafe: null,
      selfOpensBrowser: null,
    },
    availabilityPending: false,
    nativeCapabilities: {
      supportedTabs: ["general", "env", "usage"],
      mcp: null,
      plugins: null,
      skills: null,
      modelProviders: null,
    },
    managedInstallState: null,
    versionVisibility: null,
    advisory: null,
    profiles: input.profiles,
  };
}

export function usageKey(providerId: string, profileId: string | null): string {
  return `${providerId}|${profileId ?? ""}`;
}

/** The pending traversal this suite's countdown entry is drawn from. */
export function countdownPending(input: {
  readonly state: PendingFallback["state"];
  readonly revision: number;
  readonly queuedItemsMoving: number;
}): PendingFallback {
  return pendingFallback({
    state: input.state,
    reason: "rate_limit",
    failedTuple: FAILED_CLAUDE_TUPLE,
    targetTuple: TARGET_CODEX_TUPLE,
    impendingAction: null,
    deadline: input.state === "hold" ? 1_700_000_012_000 : null,
    attempt: 1,
    maxAttempts: 3,
    queuedItemsMoving: input.queuedItemsMoving,
    siblingSwitching: 0,
    traversalId: TRAVERSAL_ID,
    revision: input.revision,
  });
}

export function heldLease(
  status: FallbackChoiceLease["status"],
  token: string | null,
): FallbackChoiceLease {
  return {
    traversalId: TRAVERSAL_ID,
    clientActionId: "action-1",
    token,
    status,
    releaseRequested: false,
    connectionEpoch: 0,
  };
}

export function accounts(
  profiles: ReadonlyArray<ProviderProfile>,
  providerId: ProviderCliState["providerId"],
): ProviderCliState {
  return providerCliState({ providerId, profiles: [...profiles] });
}

/* ------------------------------------------------------------------------- */
/* Module bodies for `vi.mock`                                               */
/* ------------------------------------------------------------------------- */

function clientFor(hostId: string | null): KitClient {
  return {
    id: `client:${hostId ?? "default"}`,
    getActiveHostId: () => hostId ?? "default",
    getActiveHost: () => ({ websocketUrl: "ws://127.0.0.1:59998/stream" }),
  };
}

function idOf(client: KitClient | null): string | null {
  return client === null ? null : client.id;
}

/** `@/hooks/host/use-host-client-for-host-id`. */
export function hostClientModule() {
  return {
    useHostClientForHostId: (hostId: string | null): KitClient =>
      clientFor(hostId),
  };
}

/** `@/hooks/harnesses/use-gui-harness-catalog`. */
export function catalogModule() {
  const catalog = [
    { ...CLAUDE_HARNESS, models: CLAUDE_MODELS },
    { ...CODEX_HARNESS, models: CODEX_MODELS },
  ].map((entry) => ({
    ...entry,
    modelsLoading: false,
    modelsError: null,
  }));
  const harnesses = [CLAUDE_HARNESS, CODEX_HARNESS];
  const modelsOf = (harnessId: string): ReadonlyArray<ModelOption> =>
    harnessId === "claude" ? CLAUDE_MODELS : CODEX_MODELS;
  return {
    harnessCatalogEntryNeedsRefresh: () => true,
    useGuiHarnessesQueryForClient: (
      client: KitClient | null,
      activity: { readonly enabled: boolean },
    ) => {
      kit.catalogCalls.push({
        hook: "harnesses",
        clientId: idOf(client),
        enabled: activity.enabled,
      });
      return {
        data: activity.enabled && client !== null ? { harnesses } : undefined,
        isPending: false,
        isError: false,
        error: null,
      };
    },
    useGuiHarnessModelsQueryForClient: (
      client: KitClient | null,
      harnessId: string,
      _workingDirectory: string | null,
      activity: { readonly enabled: boolean },
    ) => {
      kit.catalogCalls.push({
        hook: "models",
        clientId: idOf(client),
        enabled: activity.enabled,
      });
      return {
        data:
          activity.enabled && client !== null
            ? { harnessId, models: modelsOf(harnessId) }
            : undefined,
        isPending: false,
        isError: false,
        error: null,
        refetch: () => Promise.resolve({ data: undefined }),
      };
    },
    useGuiHarnessCommandsQuery: () => ({
      data: undefined,
      isPending: false,
      error: null,
      refetch: () => Promise.resolve({ data: undefined }),
    }),
    useGuiHarnessCatalogForClient: (
      client: KitClient | null,
      _workingDirectory: string | null,
      activity: { readonly enabled: boolean },
    ) => {
      kit.catalogCalls.push({
        hook: "catalog",
        clientId: idOf(client),
        enabled: activity.enabled,
      });
      return {
        harnesses: activity.enabled && client !== null ? catalog : [],
        harnessesLoading: false,
        harnessesError: null,
        modelsLoading: false,
      };
    },
    useRefreshHarnessCatalogForClient: () => () => Promise.resolve(),
  };
}

/** `@/hooks/providers/use-providers-list-query`. */
export function providersListModule() {
  const read = (client: KitClient | null, enabled: boolean) => {
    kit.providerCalls.push(idOf(client));
    return {
      data:
        enabled && client !== null ? { providers: kit.providers } : undefined,
      isPending: false,
      isError: false,
      error: null,
      isFetching: false,
    };
  };
  return {
    useProvidersList: (activity: { readonly enabled: boolean }) =>
      read(clientFor(null), activity.enabled),
    useProvidersListForClient: (
      client: KitClient | null,
      activity: { readonly enabled: boolean },
    ) => read(client, activity.enabled),
  };
}

/** The picker's other host-backed reads, all inert. */
export function providersEnsurePackModule() {
  return { useProvidersEnsurePackForClient: () => ({ mutate: vi.fn() }) };
}

export function providersSetProfileEnabledModule() {
  return {
    useProviderProfileEnablementPending: () => () => false,
    useProvidersSetProfileEnabledForClient: () => ({
      mutate: vi.fn(),
      isPending: false,
    }),
  };
}

export function reactiveHostReadinessModule() {
  return {
    useReactiveHostReadiness: (client: KitClient | null) => ({
      hostId: client === null ? null : client.getActiveHostId(),
      requestContextUserId: "user-1",
      isReady: client !== null,
      hasRpcEndpoint: client !== null,
      canExecute: client !== null,
    }),
  };
}

export function hostReachabilityModule() {
  return {
    useHostReachability: (hostId: string) => ({
      status: "reachable",
      hostLabel: hostId,
      unavailability: null,
      basis: "directory",
      hostKind: "local",
    }),
  };
}

export function addressableHostIdModule() {
  return { useAddressableHostId: () => "local" };
}

export function hostDirectoryListModule() {
  return {
    useHostDirectoryList: () => ({
      data: [
        {
          hostId: "local",
          kind: "local",
          label: "Local host",
          transportDialability: "dialable",
          websocketUrl: "ws://127.0.0.1:0",
        },
        {
          hostId: TAB_HOST_ID,
          kind: "local",
          label: "Tab host",
          transportDialability: "dialable",
          websocketUrl: "ws://127.0.0.1:1",
        },
      ],
    }),
  };
}

/**
 * `@/hooks/rate-limits/use-profile-usage-comparison`: one entry per profile
 * the caller passes, from `kit.usage` (default: never checked, eligible, idle).
 * `ensureFresh` and `refresh` are recorded and resolve at once.
 */
export function usageComparisonModule() {
  return {
    useProfileUsageComparison: (args: {
      readonly runTargetHostId: string | null;
      readonly providerId: string;
      readonly profiles: ReadonlyArray<ProviderProfile>;
    }) => {
      kit.usageProbeCalls.push({
        runTargetHostId: args.runTargetHostId,
        providerId: args.providerId,
      });
      const entries = new Map<string | null, unknown>();
      for (const profile of args.profiles) {
        const profileId = profileCommitId(profile);
        const config = kit.usage.get(usageKey(args.providerId, profileId));
        entries.set(profileId, {
          profileId,
          providerId: args.providerId,
          detail:
            config === undefined ? { kind: "never-checked" } : config.detail,
          fetchEligible: config === undefined ? true : config.fetchEligible,
          refreshStatus: config === undefined ? "idle" : config.refreshStatus,
          refresh: () => {
            kit.refreshCalls.push({ providerId: args.providerId, profileId });
            return Promise.resolve();
          },
          ensureFresh: () => {
            kit.ensureFreshCalls.push({
              providerId: args.providerId,
              profileId,
            });
            return kit.ensureFreshHangs
              ? new Promise<void>(() => undefined)
              : Promise.resolve();
          },
        });
      }
      return { hostId: args.runTargetHostId, isReady: true, entries };
    },
  };
}

/** `@/components/chat/fallback/use-fallback-targets`. */
export function listTargetsModule() {
  return {
    useFallbackListTargets: (
      client: KitClient | null,
      input: { readonly enabled: boolean; readonly selector: unknown },
    ) => {
      kit.listCalls.push({
        clientId: idOf(client),
        enabled: input.enabled,
        selector: input.selector,
      });
      return {
        data: kit.listData,
        isPending: kit.listData === undefined && !kit.listError,
        isFetching: kit.listFetching,
        isError: kit.listError,
      };
    },
  };
}

/** `@/components/chat/fallback/use-fallback-choice-lease`, hand-driven. */
export function leaseModule() {
  return {
    useFallbackChoiceLease: () => ({
      lease: kit.lease,
      hold: kit.hold,
      release: kit.release,
    }),
  };
}

/**
 * `@/hooks/host/use-host-scoped-mutation`: records every send with the client
 * it was made on, holds `isPending` in real state, and delivers the answer to
 * BOTH the hook-level and the per-call `onSuccess` - the conservative shape,
 * which lets a suite catch a reporting channel that speaks twice.
 */
export function hostScopedMutationModule() {
  return {
    useHostScopedMutationForClient: (
      client: KitClient | null,
      args: {
        readonly method: string;
        readonly onSuccess:
          | ((
              response: { readonly outcome: string },
              variables: unknown,
            ) => void)
          | undefined;
      },
    ) => {
      const [pending, setPending] = useState(false);
      return {
        mutate: (
          variables: Record<string, unknown>,
          opts:
            | {
                readonly onSuccess:
                  | ((
                      response: { readonly outcome: string },
                      variables: unknown,
                    ) => void)
                  | undefined;
                readonly onError: ((error: Error) => void) | undefined;
              }
            | undefined,
        ) => {
          kit.mutations.push({
            clientId: idOf(client),
            method: args.method,
            variables,
          });
          setPending(true);
          const deliver = (): void => {
            setPending(false);
            if (kit.mutationFails) {
              if (opts !== undefined && opts.onError !== undefined) {
                opts.onError(new Error("transport down"));
              }
              return;
            }
            const result = kit.mutationResult;
            if (args.onSuccess !== undefined) {
              args.onSuccess(result, variables);
            }
            if (opts !== undefined && opts.onSuccess !== undefined) {
              opts.onSuccess(result, variables);
            }
          };
          if (kit.deferResponses) {
            kit.pendingResponses.push(deliver);
            return;
          }
          deliver();
        },
        isPending: pending,
      };
    },
  };
}

/** `@/lib/registries/chat-session-registry`, over the {@link session} store. */
export function registryModule<T extends object>(actual: T) {
  return {
    ...actual,
    useExistingChatSessionHandle: () => ({ store: session }),
  };
}

/** `@/components/chat/fallback/fallback-identity`: the labels resolver only. */
export function identityModule<T extends object>(actual: T) {
  return {
    ...actual,
    useFallbackModelLabels: (client: KitClient | null) => {
      kit.labelCalls.push(idOf(client));
      return (harnessId: string, model: string): string =>
        kit.modelLabels === null
          ? model
          : (kit.modelLabels.get(`${harnessId}:${model}`) ?? model);
    },
  };
}

/** `@/stores/tabs/use-system-tab-modal`. */
export function systemTabModalModule() {
  return {
    useSystemTabModalActions: () => ({ openSettings: kit.openSettings }),
  };
}

/** `react-virtuoso`: renders a window of rows, no measuring. */
export async function virtuosoModule() {
  const React = await import("react");
  interface Props {
    readonly id?: string;
    readonly role?: string;
    readonly "aria-label"?: string;
    readonly className?: string;
    readonly data?: ReadonlyArray<unknown>;
    readonly totalCount?: number;
    readonly computeItemKey?: (
      index: number,
      item: undefined,
    ) => string | number;
    readonly itemContent?: (index: number, item: undefined) => ReactNode;
  }
  const Virtuoso = React.forwardRef<unknown, Props>((props, ref) => {
    React.useImperativeHandle(ref, () => ({
      autoscrollToBottom: () => undefined,
      getState: (callback: (state: null) => void) => {
        callback(null);
      },
      scrollBy: () => undefined,
      scrollIntoView: () => undefined,
      scrollTo: () => undefined,
      scrollToIndex: () => undefined,
    }));
    const total = props.totalCount ?? props.data?.length ?? 0;
    const indexes = Array.from({ length: total }, (_unused, index) => index);
    return React.createElement(
      "div",
      {
        id: props.id,
        role: props.role,
        "aria-label": props["aria-label"],
        className: props.className,
        "data-testid": "virtuoso-scroller",
      },
      ...indexes.map((index) =>
        React.createElement(
          React.Fragment,
          { key: props.computeItemKey?.(index, undefined) ?? index },
          props.itemContent?.(index, undefined),
        ),
      ),
    );
  });
  return { Virtuoso };
}
