/**
 * The build without environments (`unreleased-features.ts`) never says what
 * the Terminal account is under the picker: that line points at Providers'
 * Personal sign-in, which does not exist there.
 */
vi.mock("@/unreleased-features", () => ({
  UNRELEASED_FEATURES_ENABLED: false,
}));
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetPaneActivationFocusIntentsForTests } from "@/components/epic-canvas/pane-activation";

// The picker's provider-settings gear opens the settings modal through router
// actions. This unit test renders the picker bare (no RouterProvider), so stub
// the action hook.
const openSettingsMock = vi.fn();
const profileUsageHookMock = vi.hoisted(() => ({
  runTargetHostIds: [] as Array<string | null>,
  calls: [] as Array<{
    readonly runTargetHostId: string | null;
    readonly providerId: string;
    readonly profiles: ReadonlyArray<ProviderProfile>;
  }>,
}));
// The picker's Terminal account sentence reads the fleet's rows for the run
// target's name; this suite has no fleet.
vi.mock("@/components/settings/host-scope/use-host-options", async () => {
  const { hostOptionsFixture } =
    await import("@/components/settings/host-scope/host-scope-fixture");
  return { useHostOptions: () => hostOptionsFixture({ hosts: [] }) };
});
vi.mock("@/stores/tabs/use-system-tab-modal", () => ({
  useSystemTabModalActions: () => ({
    openSettings: openSettingsMock,
    openHistory: vi.fn(),
    close: vi.fn(),
    setSection: vi.fn(),
  }),
}));
// Profile comparison has its own focused picker integration suite. Keep this
// broad legacy picker suite on its existing identity-row contract so its host
// sentinels do not need to impersonate a full HostClient.
vi.mock("@/hooks/rate-limits/use-profile-usage-comparison", () => ({
  useProfileUsageComparison: (args: {
    readonly runTargetHostId: string | null;
    readonly providerId: string;
    readonly profiles: ReadonlyArray<ProviderProfile>;
  }) => {
    profileUsageHookMock.runTargetHostIds.push(args.runTargetHostId);
    profileUsageHookMock.calls.push(args);
    return { hostId: args.runTargetHostId, isReady: true, entries: new Map() };
  },
}));
// The profile dropdown (ProfileDropdown) renders through Radix's real
// DropdownMenu, which opens on pointerdown rather than click - render it
// inline + always-open so tests can click its rows without fighting
// pointer-open semantics in jsdom (mirrors the established mock in
// worktrees-settings-panel.test / folder-controls.test).
vi.mock("@/components/ui/dropdown-menu", () => {
  const passthrough = (props: { readonly children: ReactNode }): ReactNode =>
    props.children;
  return {
    DropdownMenu: passthrough,
    DropdownMenuTrigger: passthrough,
    DropdownMenuContent: (props: {
      readonly children: ReactNode;
      readonly container: HTMLElement | null | undefined;
      readonly onKeyDown: (event: KeyboardEvent<HTMLDivElement>) => void;
    }): ReactNode => (
      <div
        role="menu"
        tabIndex={-1}
        data-testid="profile-dropdown-content"
        data-has-container={props.container instanceof HTMLElement}
        onKeyDown={props.onKeyDown}
      >
        {props.children}
      </div>
    ),
    DropdownMenuItem: (props: {
      readonly children: ReactNode;
      readonly onSelect: (() => void) | undefined;
      readonly "aria-label": string | undefined;
      readonly "aria-current": "true" | undefined;
      readonly className: string | undefined;
      readonly disabled: boolean | undefined;
      readonly title: string | undefined;
    }): ReactNode => (
      <button
        type="button"
        role="menuitem"
        aria-label={props["aria-label"]}
        aria-current={props["aria-current"]}
        className={props.className}
        disabled={props.disabled}
        title={props.title}
        onClick={props.onSelect}
      >
        {props.children}
      </button>
    ),
    DropdownMenuSeparator: (): ReactNode => <div role="separator" />,
    DropdownMenuRadioGroup: passthrough,
    DropdownMenuRadioItem: passthrough,
    DropdownMenuShortcut: (props: {
      readonly children: ReactNode;
      readonly "data-testid": string | undefined;
    }): ReactNode => (
      <span data-testid={props["data-testid"]}>{props.children}</span>
    ),
  };
});
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type {
  HarnessModelSelection,
  HarnessOption,
  ModelOption,
  ProviderId,
  ReasoningLevel,
  ServiceTier,
} from "@/components/home/data/landing-options";
import type { MaxModeContext } from "@/components/home/data/model-max-mode";
import {
  type ProviderCliState,
  type ProviderProfile,
} from "@traycer/protocol/host/provider-schemas";
import {
  type Key,
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
} from "react";

interface CatalogHarness extends HarnessOption {
  readonly models: ReadonlyArray<ModelOption>;
  readonly modelsLoading: boolean;
  readonly modelsError: Error | null;
}

interface QueryActivity {
  readonly enabled: boolean;
  readonly subscribed: boolean;
}

interface MockHostClient {
  readonly id: string;
  getActiveHostId(): string | null;
  getActiveHost(): { readonly websocketUrl: string | null } | null;
}

function mockHostClientKey(client: MockHostClient): string {
  return client.id;
}

const queryMock = vi.hoisted(() => ({
  /** The cloud catalog's Traycer models, read for a sandbox refusal only. */
  cloudTraycerModels: undefined as ReadonlyArray<ModelOption> | undefined,
  harnesses: [] as HarnessOption[],
  catalogHarnesses: [] as CatalogHarness[],
  selectedModelsByHarness: new Map<string, ReadonlyArray<ModelOption>>(),
  harnessesLoading: false,
  harnessesError: null as Error | null,
  catalogHarnessesLoading: false,
  modelsLoading: false,
  providerStates: [] as ProviderCliState[],
  // Per-target-host override for `useProvidersListForClient` - keyed by the
  // sentinel `useHostClientForHostId` returns ("default" for a null host id,
  // else the raw host id). A test that never populates this map gets
  // `providerStates` for every target host, matching the pre-fix behavior
  // where the gate always read the default host's list.
  providerStatesByClient: new Map<string, ProviderCliState[]>(),
  // Per-target-host overrides for the harness-catalog `…ForClient` hooks,
  // keyed by the same `useHostClientForHostId` sentinel as
  // `providerStatesByClient` above. Unpopulated (the common case): every
  // `…ForClient` call falls back to the single `harnesses` /
  // `selectedModelsByHarness` / `catalogHarnesses` fixture below, matching
  // pre-fix behavior where every call read the same data regardless of host.
  harnessesByClient: new Map<string, HarnessOption[]>(),
  modelsByClient: new Map<string, Map<string, ReadonlyArray<ModelOption>>>(),
  catalogHarnessesByClient: new Map<string, CatalogHarness[]>(),
  unresolvedHostIds: new Set<string>(),
  endpointAbsentHostIds: new Set<string>(),
  reachabilityByHost: new Map<
    string,
    {
      readonly status:
        | "checking"
        | "reachable"
        | "unreachable"
        | "host-starting";
      readonly hostLabel: string;
      readonly unavailability: "offline" | null;
    }
  >(),
  concreteDefaultHostId: null as string | null,
  cloneCatalogOnRead: false,
  calls: {
    harnesses: [] as Array<{
      readonly enabled: boolean;
      readonly subscribed: boolean;
    }>,
    // The `client` each `…ForClient` call was invoked with (recorded
    // separately from `calls.harnesses` / `calls.models` / `calls.catalog`
    // above so their pre-existing `toEqual({ enabled, subscribed })`
    // assertions keep matching exactly, with no extra field to account for).
    harnessClients: [] as Array<string | null>,
    catalog: [] as Array<{
      readonly workingDirectory: string | null;
      readonly enabled: boolean;
      readonly subscribed: boolean;
    }>,
    catalogClients: [] as Array<string | null>,
    models: [] as Array<{
      readonly harnessId: string;
      readonly workingDirectory: string | null;
      readonly enabled: boolean;
      readonly subscribed: boolean;
    }>,
    modelClients: [] as Array<string | null>,
    providers: [] as Array<{
      readonly enabled: boolean;
      readonly subscribed: boolean;
    }>,
    commands: [] as Array<{
      readonly harnessId: string;
      readonly workingDirectories: ReadonlyArray<string>;
      readonly enabled: boolean;
      readonly subscribed: boolean;
    }>,
    ensurePack: [] as string[],
    // `useRefreshHarnessCatalogForClient`'s own `client` argument (not the
    // client the returned refresh function later resolves internally - this
    // suite mocks the hook itself, so this is the one signal available).
    refresh: [] as Array<string | null>,
  },
}));

vi.mock("@/hooks/providers/use-providers-ensure-pack-mutation", () => ({
  // Mocked alongside its sibling `use-providers-list-query` below: both are
  // host-backed and this suite runs without a QueryClient/HostRuntimeProvider.
  // The retry click is recorded so the rail's gated-tab behaviour can be
  // asserted without a real mutation.
  useProvidersEnsurePackForClient: () => ({
    mutate: (variables: { readonly providerId: string }) => {
      queryMock.calls.ensurePack.push(variables.providerId);
    },
  }),
}));

vi.mock("@/hooks/providers/use-providers-list-query", () => ({
  useProvidersList: (activity: QueryActivity) => {
    queryMock.calls.providers.push({
      enabled: activity.enabled,
      subscribed: activity.subscribed,
    });
    return {
      data: activity.enabled
        ? { providers: queryMock.providerStates }
        : undefined,
      isPending: false,
      isError: false,
      isFetching: false,
    };
  },
  // Backs the create-profile gate's host-scoped read. `client` is whatever
  // the mocked `useHostClientForHostId` below returned - a sentinel string,
  // not a real `HostClient` - so this just looks it up in
  // `providerStatesByClient`, falling back to the same `providerStates` list
  // `useProvidersList` serves when a test hasn't set up a per-host override.
  useProvidersListForClient: (
    client: MockHostClient | null,
    activity: QueryActivity,
  ) => {
    // The picker now issues TWO `useProvidersListForClient` calls (the rail,
    // and the create-profile capability gate) where it used to issue ONE
    // `useProvidersList` call for the rail - recording both here keeps
    // `calls.providers` a faithful "every providers-list observer this
    // render created" log. Both calls share the same `activityEnabled` in
    // every fixture in this file, so existing `.at(-1)` assertions on
    // enabled/subscribed are unaffected by which call lands last.
    queryMock.calls.providers.push({
      enabled: activity.enabled,
      subscribed: activity.subscribed,
    });
    // A `null` client models an UNRESOLVED run-target host - `useHostQuery`
    // disables the query outright (`enabled: (query) => client === null ? ...
    // false`), so a real disabled query with no cached data reports
    // `isPending: true`/`data: undefined` forever, never the DEFAULT host's
    // cached providers. Falling back to `providerStates` here (the pre-fix
    // behavior) would leak the default host's profiles into a picker bound to
    // a host that never resolved.
    if (client === null) {
      return {
        data: undefined,
        isPending: true,
        isError: false,
        error: null,
        isFetching: false,
      };
    }
    const providers =
      queryMock.providerStatesByClient.get(mockHostClientKey(client)) ??
      queryMock.providerStates;
    return {
      data: activity.enabled ? { providers } : undefined,
      isPending: false,
      isError: false,
      error: null,
      isFetching: false,
    };
  },
}));

vi.mock("@/hooks/providers/use-providers-set-profile-enabled-mutation", () => ({
  useProviderProfileEnablementPending: () => () => false,
  useProvidersSetProfileEnabledForClient: () => ({
    mutate: vi.fn(),
    isPending: false,
  }),
}));

// Resolves to a small `HostClient` stand-in keyed by its requested host. A
// null request follows the default host, which can be set concretely by a
// test to cover focus transfer out of a following picker.
vi.mock("@/hooks/host/use-host-client-for-host-id", () => ({
  useHostClientForHostId: (hostId: string | null): MockHostClient | null => {
    if (hostId !== null && queryMock.unresolvedHostIds.has(hostId)) {
      return null;
    }
    return {
      id: hostId ?? "default",
      getActiveHostId: () =>
        hostId ?? queryMock.concreteDefaultHostId ?? "default",
      getActiveHost: () => ({
        websocketUrl: queryMock.endpointAbsentHostIds.has(hostId ?? "default")
          ? null
          : "ws://127.0.0.1:59998/stream",
      }),
    };
  },
}));

vi.mock("@/hooks/host/use-reactive-host-readiness", () => ({
  useReactiveHostReadiness: (client: MockHostClient | null) => {
    const hostId = client?.getActiveHostId() ?? null;
    const hasRpcEndpoint =
      (client?.getActiveHost()?.websocketUrl ?? null) !== null;
    return {
      hostId,
      requestContextUserId: "user-1",
      isReady: hostId !== null,
      hasRpcEndpoint,
      canExecute: hostId !== null && hasRpcEndpoint,
    };
  },
}));

vi.mock("@/hooks/agent/use-host-reachability", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/hooks/agent/use-host-reachability")
  >()),
  useHostReachability: (hostId: string) => {
    const reachability = queryMock.reachabilityByHost.get(hostId);
    return {
      status: reachability?.status ?? "reachable",
      hostLabel: reachability?.hostLabel ?? hostId,
      unavailability: reachability?.unavailability ?? null,
      basis: "directory",
      hostKind: "local",
    };
  },
}));

// The capability gate resolves the "Create new profile" row's target host
// via `useAddressableHostId()` / `useHostDirectoryList()` - stub both to a
// single local host so the row is enabled by default (mirrors
// `providers-settings-panel.test.tsx`'s equivalent stubs).
vi.mock("@/hooks/host/use-addressable-host-id", () => ({
  useAddressableHostId: () => "local",
}));

vi.mock("@/hooks/host/use-host-directory-list-query", () => ({
  useHostDirectoryList: () => ({
    data: [
      {
        hostId: "local",
        kind: "local",
        label: "Local host",
        transportDialability: "dialable",
        websocketUrl: "ws://127.0.0.1:0",
      },
      // A second local-kind host, distinct from the app-wide default
      // ("local") - lets a test prove a tab's explicit `createProfileHostId`
      // is what the capability gate/flow store actually use, not just a
      // coincidental match with the default.
      {
        hostId: "tab-host-1",
        kind: "local",
        label: "Tab host",
        transportDialability: "dialable",
        websocketUrl: "ws://127.0.0.1:1",
      },
    ],
  }),
}));

vi.mock("react-virtuoso", async () => {
  const React = await import("react");

  interface MockVirtuosoHandle {
    readonly scrollIntoView: (location: unknown) => void;
    readonly scrollToIndex: (location: unknown) => void;
    readonly scrollBy: (location: unknown) => void;
    readonly scrollTo: (location: unknown) => void;
    readonly autoscrollToBottom: () => void;
    readonly getState: (callback: (state: null) => void) => void;
  }

  interface MockVirtuosoProps {
    readonly id?: string;
    readonly role?: string;
    readonly "aria-label"?: string;
    readonly className?: string;
    readonly data?: ReadonlyArray<unknown>;
    readonly totalCount?: number;
    readonly computeItemKey?: (index: number, item: undefined) => Key;
    readonly initialTopMostItemIndex?:
      | number
      | { readonly index: number | "LAST" };
    readonly itemContent?: (index: number, item: undefined) => ReactNode;
  }

  const Virtuoso = React.forwardRef<MockVirtuosoHandle, MockVirtuosoProps>(
    (props, ref) => {
      React.useImperativeHandle(ref, () => ({
        autoscrollToBottom: () => undefined,
        getState: (callback) => {
          callback(null);
        },
        scrollBy: () => undefined,
        scrollIntoView: () => undefined,
        scrollTo: () => undefined,
        scrollToIndex: () => undefined,
      }));

      const totalCount = props.totalCount ?? props.data?.length ?? 0;
      const indexes = mockVirtuosoIndexes(
        totalCount,
        mockInitialIndex(props.initialTopMostItemIndex, totalCount),
      );
      const children = indexes.map((index) =>
        React.createElement(
          React.Fragment,
          { key: props.computeItemKey?.(index, undefined) ?? index },
          props.itemContent?.(index, undefined),
        ),
      );

      return React.createElement(
        "div",
        {
          id: props.id,
          role: props.role,
          "aria-label": props["aria-label"],
          className: props.className,
          "data-testid": "virtuoso-scroller",
        },
        ...children,
      );
    },
  );

  function mockInitialIndex(
    value: MockVirtuosoProps["initialTopMostItemIndex"],
    totalCount: number,
  ): number {
    if (totalCount === 0) return 0;
    let rawIndex = 0;
    if (typeof value === "number") {
      rawIndex = value;
    } else if (value?.index === "LAST") {
      rawIndex = totalCount - 1;
    } else if (value?.index !== undefined) {
      rawIndex = value.index;
    }
    if (rawIndex < 0) return 0;
    if (rawIndex >= totalCount) return totalCount - 1;
    return rawIndex;
  }

  function mockVirtuosoIndexes(
    totalCount: number,
    initialIndex: number,
  ): ReadonlyArray<number> {
    const windowSize = 12;
    const start = Math.max(0, initialIndex - Math.floor(windowSize / 2));
    const end = Math.min(totalCount, start + windowSize);
    return Array.from(
      { length: end - start },
      (_unused, index) => start + index,
    );
  }

  return { Virtuoso };
});

function catalogHarnessesForRender(): CatalogHarness[] {
  if (!queryMock.cloneCatalogOnRead) return queryMock.catalogHarnesses;
  return queryMock.catalogHarnesses.map((harness) => ({
    ...harness,
    models: [...harness.models],
  }));
}

// The picker's cloud read of Traycer's models, made only when a sandbox
// refusal opens it.
vi.mock("@/hooks/sandboxes/use-sandbox-traycer-models-query", () => ({
  useSandboxTraycerModels: () => ({
    data: queryMock.cloudTraycerModels,
    error: null,
    isPending: false,
  }),
}));
vi.mock("@/hooks/harnesses/use-gui-harness-catalog", () => ({
  // The real hook resolves the app-wide default host's client via
  // `useHostBinding()`; this suite renders the picker without a
  // `<HostRuntimeProvider>`, so a real call would just resolve to `null`
  // anyway (`useHostBinding` tolerates a missing provider) - stub it
  // directly rather than exercising that context machinery.
  // The picker asks this at every intent edge before it refetches. This suite
  // mocks the hook module wholesale, so its query stubs carry no
  // `dataUpdatedAt` to judge freshness from - answer "due" so the edges under
  // test here (which fire a no-op `refetch` below) still run. The real
  // freshness policy, and the RPCs it gates, are covered against a mocked host
  // transport in `harness-model-picker-intent-rpc.test.tsx`.
  harnessCatalogEntryNeedsRefresh: () => true,
  // The picker resolves its own client (`useHostClientForHostId`, mocked
  // above to a sentinel keyed by `runTargetHostId`) and threads it into every
  // `…ForClient` call below. This suite's fixtures are not per-host (see
  // `queryMock`), so every `…ForClient` variant delegates to the SAME data -
  // the `client` argument is only ever recorded, never used to branch, unless
  // a test specifically layers `queryMock.harnessesByClient` (see below).
  useGuiHarnessesQueryForClient: (
    client: MockHostClient | null,
    activity: QueryActivity,
  ) => {
    queryMock.calls.harnesses.push({
      enabled: activity.enabled,
      subscribed: activity.subscribed,
    });
    queryMock.calls.harnessClients.push(
      client === null ? null : mockHostClientKey(client),
    );
    // A `null` client models an unresolved run-target host: `useHostQuery`
    // disables the underlying query, so a real disabled query with no cached
    // data reports `isPending: true`/`data: undefined` forever - never the
    // default host's cached harness list. See the matching comment on
    // `useProvidersListForClient` above for why this must not fall back.
    if (client === null) {
      return { data: undefined, isPending: true, isError: false, error: null };
    }
    const clientKey = mockHostClientKey(client);
    const harnesses = queryMock.harnessesByClient.has(clientKey)
      ? (queryMock.harnessesByClient.get(clientKey) ?? [])
      : queryMock.harnesses;
    return {
      data: activity.enabled ? { harnesses } : undefined,
      isPending: activity.enabled && queryMock.harnessesLoading,
      isError: queryMock.harnessesError !== null,
      error: queryMock.harnessesError,
    };
  },
  useGuiHarnessModelsQueryForClient: (
    client: MockHostClient | null,
    harnessId: string,
    workingDirectory: string | null,
    activity: QueryActivity,
  ) => {
    queryMock.calls.models.push({
      harnessId,
      workingDirectory,
      enabled: activity.enabled,
      subscribed: activity.subscribed,
    });
    queryMock.calls.modelClients.push(
      client === null ? null : mockHostClientKey(client),
    );
    // See `useGuiHarnessesQueryForClient` above: a `null` client is a
    // permanently-disabled query, never a default-host fallback.
    if (client === null) {
      return {
        data: undefined,
        isPending: true,
        isError: false,
        error: null,
        refetch: () => Promise.resolve({ data: undefined }),
      };
    }
    const clientKey = mockHostClientKey(client);
    const modelsByHarness = queryMock.modelsByClient.has(clientKey)
      ? (queryMock.modelsByClient.get(clientKey) ??
        queryMock.selectedModelsByHarness)
      : queryMock.selectedModelsByHarness;
    return {
      data: activity.enabled
        ? {
            harnessId,
            models: modelsByHarness.get(harnessId) ?? [],
          }
        : undefined,
      isPending: false,
      isError: false,
      error: null,
      // The picker's intent-edge effects call `.refetch()` on both queries
      // whenever the popover opens or the selection changes (real RPC
      // behavior now covered by `harness-model-picker-intent-rpc.test.tsx`
      // against a mocked host transport). This suite mocks the hook
      // wholesale, so `.refetch()` must stay a harmless no-op here rather
      // than throw.
      refetch: () => Promise.resolve({ data: undefined }),
    };
  },
  useGuiHarnessCommandsQuery: (
    _client: unknown,
    harnessId: string,
    workingDirectories: ReadonlyArray<string>,
    activity: QueryActivity,
  ) => {
    queryMock.calls.commands.push({
      harnessId,
      workingDirectories,
      enabled: activity.enabled,
      subscribed: activity.subscribed,
    });
    return {
      data: activity.enabled ? { harnessId, commands: [] } : undefined,
      isPending: false,
      error: null,
      refetch: () => Promise.resolve({ data: undefined }),
    };
  },
  useGuiHarnessCatalogForClient: (
    client: MockHostClient | null,
    workingDirectory: string | null,
    activity: QueryActivity,
  ) => {
    queryMock.calls.catalog.push({
      workingDirectory,
      enabled: activity.enabled,
      subscribed: activity.subscribed,
    });
    queryMock.calls.catalogClients.push(
      client === null ? null : mockHostClientKey(client),
    );
    // See `useGuiHarnessesQueryForClient` above: with a `null` client the
    // underlying harnesses query is permanently disabled, so the REAL
    // composed hook reports an empty catalog (never the default host's cached
    // one) that is NOT loading - it gates `harnessesLoading` on the client,
    // since a disabled query's `isPending` would otherwise read as loading
    // forever - and no model queries ever fire since there are no available
    // harness ids to fan out over.
    if (client === null) {
      return {
        harnesses: [],
        harnessesLoading: false,
        harnessesError: null,
        modelsLoading: false,
      };
    }
    const clientKey = mockHostClientKey(client);
    const harnesses = queryMock.catalogHarnessesByClient.has(clientKey)
      ? (queryMock.catalogHarnessesByClient.get(clientKey) ?? [])
      : catalogHarnessesForRender();
    return {
      harnesses: activity.enabled ? harnesses : [],
      harnessesLoading: activity.enabled && queryMock.catalogHarnessesLoading,
      harnessesError: activity.enabled ? queryMock.harnessesError : null,
      modelsLoading: activity.enabled && queryMock.modelsLoading,
    };
  },
  useRefreshHarnessCatalogForClient: (client: MockHostClient | null) => () => {
    queryMock.calls.refresh.push(
      client === null ? null : mockHostClientKey(client),
    );
    return Promise.resolve();
  },
}));

import {
  HarnessModelPicker,
  type HarnessModelPickerEmbedding,
  type OpenForHarness,
} from "@/components/home/pickers/harness-model-picker";
import { SurfaceActivityProvider } from "@/components/home/composer/surface-activity-context";
import type { ProfileRowAdmission } from "@/components/providers/provider-profile-model";
import {
  createComposerToolbarStore,
  type ComposerToolbarStore,
} from "@/stores/composer/composer-toolbar-store";
import { useComposerHarnessMemoryStore } from "@/stores/composer/composer-harness-memory-store";
import { useProvidersFocusStore } from "@/stores/settings/providers-focus-store";
import { useProviderProfileAddFlowStore } from "@/stores/settings/provider-profile-add-flow-store";
import { useKeybindingStore } from "@/stores/settings/keybinding-store";
import {
  DEFAULT_LAYOUT_SNAPSHOT,
  useLayoutStore,
} from "@/stores/layout/layout-store";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ALL_PERMISSION_MODES } from "@traycer/protocol/persistence/epic/foundation";

import { resetActiveModelPickerForTests } from "@/lib/commands/active-model-picker-registry";
const CODEX_HARNESS: HarnessOption = {
  id: "codex",
  label: "Codex",
  enabled: true,
  available: true,
  error: null,
  modes: ["gui", "tui"],
  requiresApiKey: false,
  supportedPermissionModes: [...ALL_PERMISSION_MODES],
  nativeAutoJudge: false,
  availabilityPending: false,
};

const CLAUDE_HARNESS: HarnessOption = {
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

const OPENCODE_HARNESS: HarnessOption = {
  id: "opencode",
  label: "OpenCode",
  enabled: true,
  available: false,
  error: "OpenCode not configured",
  modes: ["gui", "tui"],
  requiresApiKey: false,
  supportedPermissionModes: [...ALL_PERMISSION_MODES],
  nativeAutoJudge: false,
  availabilityPending: false,
};

const OPENROUTER_HARNESS: HarnessOption = {
  id: "openrouter",
  label: "OpenRouter",
  enabled: true,
  available: false,
  error: "OpenRouter needs an API key",
  modes: ["gui"],
  requiresApiKey: true,
  supportedPermissionModes: [...ALL_PERMISSION_MODES],
  nativeAutoJudge: false,
  availabilityPending: false,
};

function model(overrides: Partial<ModelOption>): ModelOption {
  const base: ModelOption = {
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
  };
  return {
    ...base,
    ...overrides,
    metadata: overrides.metadata ?? base.metadata,
  };
}

function catalogHarness(
  harness: HarnessOption,
  models: ReadonlyArray<ModelOption>,
): CatalogHarness {
  return {
    ...harness,
    models,
    modelsLoading: false,
    modelsError: null,
  };
}

function providerCliStateWithProfiles(input: {
  readonly providerId: ProviderCliState["providerId"];
  readonly profiles: ProviderCliState["profiles"];
  readonly loginCapability?: ProviderCliState["loginCapability"];
}): ProviderCliState {
  return {
    providerId: input.providerId,
    enabled: true,
    disabledBy: null,
    selected: { kind: "bundled" },
    // Capable by default: a runnable candidate, so `providerHostBlock`
    // reports null unless a test explicitly narrows `candidates` to exercise
    // the CLI-missing/checking gate.
    candidates: [
      {
        kind: "bundled",
        path: "/opt/traycer/resources/providers/claude/claude",
        version: "1.0.0",
        available: true,
        versionPending: false,
      },
    ],
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
    // Capable by default (local host, OAuth login args) so the picker's
    // "Create new profile" row is enabled unless a test explicitly narrows
    // this to exercise the capability gate.
    loginCapability:
      input.loginCapability === undefined
        ? {
            oauthArgs: ["auth", "login"],
            token: null,
            codePaste: null,
            terminalLogin: null,
            remoteSafe: null,
            selfOpensBrowser: null,
          }
        : input.loginCapability,
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

function codexModels(): ReadonlyArray<ModelOption> {
  return [
    model({ slug: "gpt-5.5", label: "GPT-5.5" }),
    model({ slug: "gpt-4.1", label: "GPT-4.1" }),
  ];
}

function claudeModels(): ReadonlyArray<ModelOption> {
  return [
    model({
      harnessId: "claude",
      slug: "claude-opus-4-7",
      label: "Claude Opus 4.7",
      contextWindow: 200_000,
    }),
    model({
      harnessId: "claude",
      slug: "claude-sonnet-4-6",
      label: "Claude Sonnet 4.6",
    }),
  ];
}

// Constant host id every store this suite creates commits selections/memory
// writes under, once `catalog.hostId` became a required per-host memory key.
const TEST_HOST_ID = "host-a";

function defaultSelection(): HarnessModelSelection {
  return { harnessId: "codex", modelSlug: "", profileId: null };
}

function installCatalog(): void {
  const codex = codexModels();
  const claude = claudeModels();
  queryMock.harnesses = [
    CODEX_HARNESS,
    CLAUDE_HARNESS,
    OPENCODE_HARNESS,
    OPENROUTER_HARNESS,
  ];
  queryMock.catalogHarnesses = [
    catalogHarness(CODEX_HARNESS, codex),
    catalogHarness(CLAUDE_HARNESS, claude),
    catalogHarness(OPENCODE_HARNESS, []),
    catalogHarness(OPENROUTER_HARNESS, []),
  ];
  queryMock.selectedModelsByHarness = new Map([
    ["codex", codex],
    ["claude", claude],
    ["opencode", []],
    ["openrouter", []],
  ]);
}

interface RenderPickerInput {
  readonly openForHarnessRef?: RefObject<OpenForHarness | null>;
  readonly selection?: HarnessModelSelection;
  readonly reasoning?: ReasoningLevel;
  readonly serviceTier?: ServiceTier;
  /**
   * Models pushed into the toolbar STORE (drives `selectedModel`, hence the
   * reasoning / fast-mode footers). Distinct from the picker's own mocked
   * query catalog above, which drives the rows/rail/trigger.
   */
  readonly storeModels?: ReadonlyArray<ModelOption>;
  readonly withServiceTier?: boolean;
  readonly withReasoning?: boolean;
  readonly tuiOnly?: boolean;
  readonly lockedHarnessId?: ProviderId | null;
  readonly disabled?: boolean;
  readonly registerActivation?: boolean;
  readonly activityEnabled?: boolean;
  readonly createProfileHostId?: string | null;
  readonly profileAdmission?: ReadonlyMap<
    string | null,
    ProfileRowAdmission
  > | null;
  readonly embedding?: HarnessModelPickerEmbedding | null;
  readonly hostId?: string | null;
  readonly maxModeContext?: MaxModeContext;
}

interface PickerHarness {
  readonly store: ComposerToolbarStore;
  readonly selections: HarnessModelSelection[];
  readonly reasoningChanges: ReasoningLevel[];
  readonly serviceTierChanges: ServiceTier[];
  readonly element: (
    disabled: boolean,
    activityEnabled: boolean | undefined,
  ) => ReactNode;
}

function pickerHarness(input: RenderPickerInput | undefined): PickerHarness {
  const resolvedInput = input ?? {};
  const selection = resolvedInput.selection ?? defaultSelection();
  const hostId =
    resolvedInput.hostId === undefined ? TEST_HOST_ID : resolvedInput.hostId;
  const embedding = resolvedInput.embedding ?? null;
  const store = createComposerToolbarStore({
    purpose: "run",
    reasoningFallback: "model-default",
    seedKey: "picker-test",
    values: {
      permission: "supervised",
      selection,
      reasoning: resolvedInput.reasoning ?? "",
      serviceTier: resolvedInput.serviceTier ?? "",
    },
    onSettingsChange: null,
    tuiOnly: resolvedInput.tuiOnly ?? false,
    chatLineCarriesAutoMode: null,
    hostId,
  });
  if (resolvedInput.storeModels !== undefined) {
    store.getState().setCatalog({
      hostId,
      harnesses: undefined,
      modelsHarnessId: selection.harnessId,
      models: resolvedInput.storeModels,
      modelsLoaded: true,
      tuiOnly: resolvedInput.tuiOnly ?? false,
      chatLineCarriesAutoMode: null,
      keepsUnavailablePick: false,
    });
  }
  const selections: HarnessModelSelection[] = [];
  const reasoningChanges: ReasoningLevel[] = [];
  const serviceTierChanges: ServiceTier[] = [];
  store.subscribe((state, previous) => {
    if (state.selection !== previous.selection) {
      selections.push(state.selection);
    }
    if (state.reasoning !== previous.reasoning) {
      reasoningChanges.push(state.reasoning);
    }
    if (state.serviceTier !== previous.serviceTier) {
      serviceTierChanges.push(state.serviceTier);
    }
  });
  const element = (
    disabled: boolean,
    activityEnabled: boolean | undefined,
  ): ReactNode => (
    <SurfaceActivityProvider
      active={activityEnabled ?? resolvedInput.activityEnabled ?? true}
    >
      <TooltipProvider delayDuration={0}>
        <HarnessModelPicker
          openForHarnessRef={resolvedInput.openForHarnessRef}
          labelDisplay="responsive"
          store={store}
          maxModeContext={resolvedInput.maxModeContext ?? { kind: "none" }}
          withServiceTier={resolvedInput.withServiceTier ?? false}
          withReasoning={resolvedInput.withReasoning ?? true}
          tuiOnly={resolvedInput.tuiOnly ?? false}
          lockedHarnessId={resolvedInput.lockedHarnessId ?? null}
          disabled={disabled}
          registerActivation={resolvedInput.registerActivation ?? false}
          createProfileHostId={resolvedInput.createProfileHostId ?? null}
          runTargetHostId={resolvedInput.createProfileHostId ?? null}
          profileAdmission={resolvedInput.profileAdmission ?? null}
          terminalLoginSurface={null}
          embedding={embedding}
        />
      </TooltipProvider>
    </SurfaceActivityProvider>
  );
  return { store, selections, reasoningChanges, serviceTierChanges, element };
}

function renderPicker(input: RenderPickerInput | undefined): PickerHarness {
  const harness = pickerHarness(input);
  render(harness.element(input?.disabled ?? false, undefined));
  return harness;
}

async function openPickerByTriggerName(
  triggerName: string | RegExp,
): Promise<HTMLInputElement> {
  fireEvent.click(screen.getByRole("button", { name: triggerName }));
  // The search label is scope-aware ("Search Codex models"), so match the stem.
  const input = await screen.findByRole("textbox", { name: /^Search/ });
  return input as HTMLInputElement;
}

describe("<HarnessModelPicker />", () => {
  beforeEach(() => {
    installCatalog();
    queryMock.cloudTraycerModels = undefined;
    queryMock.harnessesLoading = false;
    queryMock.harnessesError = null;
    queryMock.catalogHarnessesLoading = false;
    queryMock.modelsLoading = false;
    queryMock.providerStates = [];
    queryMock.providerStatesByClient = new Map();
    queryMock.harnessesByClient = new Map();
    queryMock.modelsByClient = new Map();
    queryMock.catalogHarnessesByClient = new Map();
    queryMock.unresolvedHostIds = new Set();
    queryMock.endpointAbsentHostIds = new Set();
    queryMock.reachabilityByHost = new Map();
    queryMock.concreteDefaultHostId = null;
    queryMock.cloneCatalogOnRead = false;
    queryMock.calls.harnesses = [];
    queryMock.calls.harnessClients = [];
    queryMock.calls.catalog = [];
    queryMock.calls.catalogClients = [];
    queryMock.calls.models = [];
    queryMock.calls.modelClients = [];
    queryMock.calls.providers = [];
    queryMock.calls.commands = [];
    queryMock.calls.ensurePack = [];
    queryMock.calls.refresh = [];
    profileUsageHookMock.runTargetHostIds = [];
    profileUsageHookMock.calls = [];
    openSettingsMock.mockClear();
    useProvidersFocusStore.getState().clearFocusHarnessId();
    useKeybindingStore.getState().resetAll();
    // Memory is a module singleton read by `commitSelection`; reset so a
    // seeded record can't leak between tests.
    useComposerHarnessMemoryStore.getState().resetForTests();
    useProviderProfileAddFlowStore.getState().close();
    useLayoutStore.setState({ ...DEFAULT_LAYOUT_SNAPSHOT });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    cleanup();
    resetActiveModelPickerForTests();
    resetPaneActivationFocusIntentsForTests();
    useKeybindingStore.getState().resetAll();
    useComposerHarnessMemoryStore.getState().resetForTests();
    useProviderProfileAddFlowStore.getState().close();
  });

  it("does not explain the Terminal account when the picker names one", async () => {
    queryMock.providerStates = [
      providerCliStateWithProfiles({
        providerId: "codex",
        profiles: [
          {
            profileId: "ambient",
            enabled: true,
            kind: "ambient",
            authType: "oauth",
            label: "Terminal account",
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
            accentColor: null,
            ambientDriftNotice: null,
          },
          {
            profileId: "work-profile",
            enabled: true,
            kind: "managed",
            authType: "oauth",
            label: "Work",
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
            accentColor: null,
            ambientDriftNotice: null,
          },
        ],
      }),
    ];
    renderPicker({
      selection: {
        harnessId: "codex",
        modelSlug: "gpt-5.5",
        profileId: "ambient",
      },
    });

    await openPickerByTriggerName(/^GPT-5\.5/);

    // The profile row is on screen, so the line's absence is the cut's.
    expect(screen.getByTestId("profile-dropdown-content")).toBeTruthy();
    expect(screen.queryByTestId("terminal-account-first-mention")).toBeNull();
  });
});
