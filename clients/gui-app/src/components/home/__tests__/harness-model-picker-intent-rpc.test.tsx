import "../../../../__tests__/test-browser-apis";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Same UI/infra scaffolding `harness-model-picker.test.tsx` mocks - none of it
// is the network boundary this suite cares about. The one deliberate
// difference from that file: `@/hooks/harnesses/use-gui-harness-catalog` is
// NOT mocked here - the whole point of this suite is to exercise the real
// query hooks against a mocked host transport so an actual RPC undercount (or
// overcount) is observable, which a wholesale hook mock structurally cannot
// catch (see the review comment on PR #331).
vi.mock("@/stores/tabs/use-system-tab-modal", () => ({
  useSystemTabModalActions: () => ({
    openSettings: vi.fn(),
    openHistory: vi.fn(),
    close: vi.fn(),
    setSection: vi.fn(),
  }),
}));
vi.mock("@/components/ui/dropdown-menu", () => {
  const passthrough = (props: { readonly children: ReactNode }): ReactNode =>
    props.children;
  return {
    DropdownMenu: passthrough,
    DropdownMenuTrigger: passthrough,
    DropdownMenuContent: (props: {
      readonly children: ReactNode;
      readonly container: HTMLElement | null | undefined;
    }): ReactNode => (
      <div
        data-testid="profile-dropdown-content"
        data-has-container={props.container instanceof HTMLElement}
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
    DropdownMenuShortcut: (props: {
      readonly children: ReactNode;
      readonly "data-testid": string | undefined;
    }): ReactNode => (
      <span data-testid={props["data-testid"]}>{props.children}</span>
    ),
  };
});

interface QueryActivity {
  readonly enabled: boolean;
  readonly subscribed: boolean;
}

vi.mock("@/hooks/providers/use-providers-list-query", () => ({
  useProvidersList: (activity: QueryActivity) => ({
    data: activity.enabled ? { providers: [] } : undefined,
    isPending: false,
    isError: false,
    isFetching: false,
  }),
  useProvidersListForClient: (
    _client: string | null,
    activity: QueryActivity,
  ) => ({
    data: activity.enabled ? { providers: [] } : undefined,
    isPending: false,
    isError: false,
    isFetching: false,
  }),
}));

vi.mock("@/hooks/host/use-host-client-for-host-id", () => ({
  useHostClientForHostId: (hostId: string | null) => hostId ?? "default",
}));

vi.mock("@/hooks/host/use-reactive-active-host-id", () => ({
  useReactiveActiveHostId: () => "local",
}));

vi.mock("@/hooks/host/use-host-directory-list-query", () => ({
  useHostDirectoryList: () => ({
    data: [
      {
        hostId: "local",
        kind: "local",
        label: "Local host",
        status: "available",
        websocketUrl: "ws://127.0.0.1:0",
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
    readonly id: string | undefined;
    readonly role: string | undefined;
    readonly "aria-label": string | undefined;
    readonly className: string | undefined;
    readonly data: ReadonlyArray<unknown> | undefined;
    readonly totalCount: number | undefined;
    readonly computeItemKey:
      ((index: number, item: undefined) => Key) | undefined;
    readonly initialTopMostItemIndex:
      number | { readonly index: number | "LAST" } | undefined;
    readonly itemContent:
      ((index: number, item: undefined) => ReactNode) | undefined;
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

const hostBindingMock = vi.hoisted(() => ({
  current: null as { readonly hostClient: unknown } | null,
}));
vi.mock("@/lib/host/runtime", () => ({
  useHostBinding: () => hostBindingMock.current,
  // `useRefreshHarnessCatalog` (wired to the picker's manual refresh button,
  // not part of this suite's intent-edge assertions) reads the client via
  // `useHostClient()` rather than `useHostBinding()?.hostClient` - both must
  // resolve to the same fixture client or the component throws on render.
  useHostClient: () => hostBindingMock.current?.hostClient,
}));

import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import type { Key, ReactNode } from "react";
import { HostClient } from "@traycer-clients/shared/host-client/host-client";
import { mockLocalHostEntry } from "@traycer-clients/shared/host-client/mock/mock-host-directory";
import { MockHostMessenger } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import { createRequestContextFixture } from "@traycer-clients/shared/test-fixtures/request-context";
import type {
  GuiHarnessId,
  ListGuiAgentCommandsResponse,
  ListGuiAgentModelsResponse,
  ListGuiHarnessesResponse,
} from "@traycer/protocol/host/index";
import { hostRpcRegistry, type HostRpcRegistry } from "@/lib/host";
import { createHostQueryInvalidator } from "@/lib/host/query-invalidator";
import { createAppQueryClient } from "@/lib/query-client";
import { HarnessModelPicker } from "@/components/home/pickers/harness-model-picker";
import { HARNESS_CATALOG_REFRESH_AFTER_MS } from "@/hooks/harnesses/use-gui-harness-catalog";
import { SurfaceActivityProvider } from "@/components/home/composer/surface-activity-context";
import {
  createComposerToolbarStore,
  type ComposerToolbarStore,
} from "@/stores/composer/composer-toolbar-store";
import { useComposerHarnessMemoryStore } from "@/stores/composer/composer-harness-memory-store";
import { useProvidersFocusStore } from "@/stores/settings/providers-focus-store";
import { useProviderProfileAddFlowStore } from "@/stores/settings/provider-profile-add-flow-store";
import { useKeybindingStore } from "@/stores/settings/keybinding-store";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ALL_PERMISSION_MODES } from "@traycer/protocol/persistence/epic/foundation";
import type { HarnessModelSelection } from "@/components/home/data/landing-options";

function harnessEntry(
  id: GuiHarnessId,
  available: boolean,
): ListGuiHarnessesResponse["harnesses"][number] {
  return {
    id,
    label: id,
    enabled: true,
    available,
    error: available ? null : `${id} not available`,
    modes: ["gui", "tui"],
    requiresApiKey: false,
    supportedPermissionModes: [...ALL_PERMISSION_MODES],
    availabilityPending: false,
  };
}

function modelsResponseFor(
  harnessId: GuiHarnessId,
): ListGuiAgentModelsResponse {
  return {
    harnessId,
    models: [
      {
        harnessId,
        slug: `${harnessId}-model-1`,
        label: `${harnessId} Model 1`,
        description: null,
        contextWindow: null,
        maxOutputTokens: null,
        defaultReasoningEffort: null,
        supportedReasoningEfforts: [],
        defaultServiceTier: null,
        supportedServiceTiers: [],
        deprecationNotice: null,
        metadata: {},
      },
    ],
  };
}

interface RpcCallLog {
  readonly listModels: Array<{ readonly harnessId: GuiHarnessId }>;
  readonly listCommands: Array<{ readonly harnessId: GuiHarnessId }>;
}

interface PickerRpcFixture {
  readonly calls: RpcCallLog;
  readonly Wrapper: (props: { readonly children: ReactNode }) => ReactNode;
}

/**
 * Real `HostClient` over a `MockHostMessenger`, mirroring the fixture in
 * `use-gui-harness-catalog.test.tsx` (~L210-245) - the only faked boundary is
 * the network; every query hook, TanStack cache, and React effect above it is
 * real. `calls` is populated from inside the typed mock handlers (rather than
 * parsed back out of the messenger's untyped `calls` log) so counting a
 * harness's RPCs never needs an `as`-cast on `unknown` params.
 */
function createPickerRpcFixture(
  harnesses: ReadonlyArray<ListGuiHarnessesResponse["harnesses"][number]>,
): PickerRpcFixture {
  const calls: RpcCallLog = { listModels: [], listCommands: [] };
  const queryClient = createAppQueryClient();
  let requestCounter = 0;
  const client = new HostClient<HostRpcRegistry>({
    registry: hostRpcRegistry,
    invalidator: createHostQueryInvalidator(queryClient),
    messenger: new MockHostMessenger<HostRpcRegistry>({
      registry: hostRpcRegistry,
      requestId: () => {
        requestCounter += 1;
        return `req-${String(requestCounter)}`;
      },
      handlers: {
        "agent.gui.listHarnesses": () => ({ harnesses: [...harnesses] }),
        "agent.gui.listModels": (params) => {
          calls.listModels.push({ harnessId: params.harnessId });
          return modelsResponseFor(params.harnessId);
        },
        "agent.gui.listCommands": (params) => {
          calls.listCommands.push({ harnessId: params.harnessId });
          return {
            harnessId: params.harnessId,
            commands: [],
          } satisfies ListGuiAgentCommandsResponse;
        },
      },
    }),
  });
  client.bind(mockLocalHostEntry);
  client.setRequestContext(
    createRequestContextFixture({ origin: "renderer", bearerToken: "tok-1" }),
  );
  hostBindingMock.current = { hostClient: client };
  const Wrapper = (props: { readonly children: ReactNode }): ReactNode => (
    <QueryClientProvider client={queryClient}>
      {props.children}
    </QueryClientProvider>
  );
  return { calls, Wrapper };
}

function countFor(
  entries: ReadonlyArray<{ readonly harnessId: GuiHarnessId }>,
  harnessId: GuiHarnessId,
): number {
  return entries.filter((entry) => entry.harnessId === harnessId).length;
}

function defaultSelection(harnessId: GuiHarnessId): HarnessModelSelection {
  return { harnessId, modelSlug: "", profileId: null };
}

function renderPickerWithFixture(
  fixture: PickerRpcFixture,
  selection: HarnessModelSelection,
): ComposerToolbarStore {
  const store = createComposerToolbarStore({
    seedKey: "picker-intent-rpc-test",
    values: {
      permission: "supervised",
      selection,
      reasoning: "",
      serviceTier: "",
      agentMode: "regular",
    },
    onSettingsChange: null,
    tuiOnly: false,
  });
  render(
    <fixture.Wrapper>
      <SurfaceActivityProvider active>
        <TooltipProvider delayDuration={0}>
          <HarnessModelPicker
            store={store}
            withServiceTier={false}
            tuiOnly={false}
            lockedHarnessId={null}
            disabled={false}
            registerActivation={false}
            createProfileHostId={null}
          />
        </TooltipProvider>
      </SurfaceActivityProvider>
    </fixture.Wrapper>,
  );
  return store;
}

async function openPickerByTriggerName(
  triggerName: string | RegExp,
): Promise<void> {
  fireEvent.click(screen.getByRole("button", { name: triggerName }));
  await screen.findByRole("textbox", { name: /^Search/ });
}

async function closePickerByTriggerName(
  triggerName: string | RegExp,
): Promise<void> {
  fireEvent.click(screen.getByRole("button", { name: triggerName }));
  await waitFor(() => {
    expect(screen.queryByRole("textbox", { name: /^Search/ })).toBeNull();
  });
}

/**
 * Ages every cached catalog entry past the refresh window. Both
 * `harnessCatalogEntryNeedsRefresh` and TanStack's own `dataUpdatedAt` read
 * `Date.now()`, so moving the system clock is what puts a cache entry "15
 * minutes old" without any real waiting.
 */
function ageCachePastRefreshWindow(): void {
  vi.setSystemTime(Date.now() + HARNESS_CATALOG_REFRESH_AFTER_MS + 1_000);
}

describe("<HarnessModelPicker /> real-RPC intent edges", () => {
  afterEach(() => {
    vi.useRealTimers();
    hostBindingMock.current = null;
    cleanup();
    useKeybindingStore.getState().resetAll();
    useComposerHarnessMemoryStore.getState().resetForTests();
    useProviderProfileAddFlowStore.getState().close();
    useProvidersFocusStore.getState().clearFocusHarnessId();
  });

  beforeEach(() => {
    // Fake `Date` only. The refresh window is measured in wall-clock time, so
    // `ageCachePastRefreshWindow` needs a movable `Date.now()` - but timers
    // themselves must stay real, or Testing Library's `findBy*` / `waitFor`
    // (and the mocked transport's async replies) would never settle.
    vi.useFakeTimers({ toFake: ["Date"] });
    useKeybindingStore.getState().resetAll();
    useComposerHarnessMemoryStore.getState().resetForTests();
    useProviderProfileAddFlowStore.getState().close();
    useProvidersFocusStore.getState().clearFocusHarnessId();
  });

  it("fetches models on mount (it feeds the UI) but issues zero commands prewarm calls on mount", async () => {
    const fixture = createPickerRpcFixture([
      harnessEntry("codex", true),
      harnessEntry("opencode", false),
    ]);
    renderPickerWithFixture(fixture, defaultSelection("codex"));

    // Let the harnesses fetch resolve, `selectedHarnessAvailable` flip true,
    // and `selectedModelsQuery`'s own `enabled` gate transition - this is a
    // real TanStack "enabled just turned true" fetch, not the guarded intent
    // edge, and it is legitimate: `selectedModelsQuery` feeds the trigger /
    // footer UI directly.
    await screen.findByText("codex Model 1");

    expect(countFor(fixture.calls.listModels, "codex")).toBe(1);
    // The commands prewarm query is held `enabled: false` - only the guarded
    // intent-edge refetch below may ever fire it. Nothing has opened the
    // picker or changed selection yet, so it must still be zero.
    expect(countFor(fixture.calls.listCommands, "codex")).toBe(0);
  });

  it("does not refetch the selected harness's models when the picker opens inside the refresh window", async () => {
    const fixture = createPickerRpcFixture([
      harnessEntry("codex", true),
      harnessEntry("opencode", false),
    ]);
    renderPickerWithFixture(fixture, defaultSelection("codex"));
    await screen.findByText("codex Model 1");
    const modelsBeforeOpen = countFor(fixture.calls.listModels, "codex");
    expect(countFor(fixture.calls.listCommands, "codex")).toBe(0);

    await openPickerByTriggerName(/^codex Model 1/);

    // The mount fetch filled this entry seconds ago, so the open edge has
    // nothing to refresh. `.refetch()` ignores `staleTime` as well as
    // `enabled`, so without the freshness guard EVERY open would re-hit
    // `listModels` - and respawn a reaped OpenCode server - however warm the
    // cache was.
    expect(countFor(fixture.calls.listModels, "codex")).toBe(modelsBeforeOpen);
    // The commands prewarm has never loaded, so it IS due on this edge. It is
    // the only call that reaches a Traycer/OpenRouter server (their models come
    // from remote HTTP and never touch it), which is the whole point of firing
    // it here.
    expect(countFor(fixture.calls.listCommands, "codex")).toBe(1);
  });

  it("refetches ONLY the selected harness when the picker opens after the refresh window, never the whole catalog", async () => {
    const fixture = createPickerRpcFixture([
      harnessEntry("codex", true),
      harnessEntry("claude", true),
    ]);
    renderPickerWithFixture(fixture, defaultSelection("codex"));
    await screen.findByText("codex Model 1");

    await openPickerByTriggerName(/^codex Model 1/);
    // The batched fan-out fills every AVAILABLE harness the first time the
    // picker opens - claude has no cached entry yet, and TanStack's no-data
    // path ignores `staleTime`. Wait for that real RPC before snapshotting: the
    // rows only render for whichever provider is browsed (still codex), so it
    // isn't observable in the DOM.
    await waitFor(() => {
      expect(countFor(fixture.calls.listModels, "claude")).toBeGreaterThan(0);
    });
    await closePickerByTriggerName(/^codex Model 1/);
    const codexBeforeReopen = countFor(fixture.calls.listModels, "codex");
    const claudeBeforeReopen = countFor(fixture.calls.listModels, "claude");

    ageCachePastRefreshWindow();
    await openPickerByTriggerName(/^codex Model 1/);

    // The aged catalog re-pulls exactly the harness the user is on...
    await waitFor(() => {
      expect(countFor(fixture.calls.listModels, "codex")).toBe(
        codexBeforeReopen + 1,
      );
    });
    // ...and NOT the ones they aren't. This is the regression the suite exists
    // for: with a finite `staleTime` on the batched fan-out, re-mounting it on
    // an aged cache re-pulled the ENTIRE rail on this edge - every provider,
    // including OpenCode-backed ones the user never touched, each respawning a
    // reaped server.
    expect(countFor(fixture.calls.listModels, "claude")).toBe(
      claudeBeforeReopen,
    );
  });

  it("prewarms the newly selected harness's commands on a rail selection change, without refetching its warm models", async () => {
    const fixture = createPickerRpcFixture([
      harnessEntry("codex", true),
      harnessEntry("claude", true),
    ]);
    renderPickerWithFixture(fixture, defaultSelection("codex"));
    await screen.findByText("codex Model 1");

    await openPickerByTriggerName(/^codex Model 1/);
    await waitFor(() => {
      expect(countFor(fixture.calls.listModels, "claude")).toBeGreaterThan(0);
    });
    const claudeModelsAfterOpen = countFor(fixture.calls.listModels, "claude");

    fireEvent.click(screen.getByRole("tab", { name: "claude" }));
    // "claude Model 1" now matches both the trigger's updated label AND the
    // browsed row - scope to the row list to disambiguate.
    await within(screen.getByTestId("virtuoso-scroller")).findByText(
      "claude Model 1",
    );

    // Commands have never loaded for claude, so selecting it warms its server.
    await waitFor(() => {
      expect(countFor(fixture.calls.listCommands, "claude")).toBe(1);
    });
    // Its models were fetched by the fan-out moments ago, so the selection edge
    // leaves them on cache rather than re-pulling them.
    expect(countFor(fixture.calls.listModels, "claude")).toBe(
      claudeModelsAfterOpen,
    );
  });

  it("refetches only the newly selected harness's models on a rail selection change after the refresh window, and never the harness it left", async () => {
    const fixture = createPickerRpcFixture([
      harnessEntry("codex", true),
      harnessEntry("claude", true),
    ]);
    renderPickerWithFixture(fixture, defaultSelection("codex"));
    await screen.findByText("codex Model 1");

    await openPickerByTriggerName(/^codex Model 1/);
    await waitFor(() => {
      expect(countFor(fixture.calls.listModels, "claude")).toBeGreaterThan(0);
    });
    ageCachePastRefreshWindow();
    const codexModelsAged = countFor(fixture.calls.listModels, "codex");
    const claudeModelsAged = countFor(fixture.calls.listModels, "claude");

    fireEvent.click(screen.getByRole("tab", { name: "claude" }));
    await within(screen.getByTestId("virtuoso-scroller")).findByText(
      "claude Model 1",
    );

    await waitFor(() => {
      expect(countFor(fixture.calls.listModels, "claude")).toBe(
        claudeModelsAged + 1,
      );
    });
    // The harness the user left gets no new calls from this edge, aged or not.
    expect(countFor(fixture.calls.listModels, "codex")).toBe(codexModelsAged);
  });

  it("issues zero listModels and zero listCommands calls when the picker opens on an unavailable/disabled selection", async () => {
    const fixture = createPickerRpcFixture([
      harnessEntry("codex", true),
      harnessEntry("opencode", false),
    ]);
    renderPickerWithFixture(fixture, defaultSelection("opencode"));
    await screen.findByRole("button", { name: "Select model" });

    await openPickerByTriggerName("Select model");

    expect(countFor(fixture.calls.listModels, "opencode")).toBe(0);
    expect(countFor(fixture.calls.listCommands, "opencode")).toBe(0);
  });

  it("issues zero listModels and zero listCommands calls on a programmatic selection change to an unavailable/disabled harness", async () => {
    const fixture = createPickerRpcFixture([
      harnessEntry("codex", true),
      harnessEntry("opencode", false),
    ]);
    const store = renderPickerWithFixture(fixture, defaultSelection("codex"));
    await screen.findByText("codex Model 1");
    await openPickerByTriggerName(/^codex Model 1/);

    // Bypasses the rail-click gate (which only commits available harnesses)
    // to reproduce a selection change arriving from elsewhere while
    // unavailable, mirroring the equivalent case in
    // `harness-model-picker.test.tsx`.
    act(() => {
      store.getState().setSelection(defaultSelection("opencode"));
    });
    await screen.findByRole("button", { name: "Select model" });

    expect(countFor(fixture.calls.listModels, "opencode")).toBe(0);
    expect(countFor(fixture.calls.listCommands, "opencode")).toBe(0);
  });
});
