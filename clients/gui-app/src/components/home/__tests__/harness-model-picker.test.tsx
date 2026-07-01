import "../../../../__tests__/test-browser-apis";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The picker's provider-settings gear opens the settings modal through router
// actions. This unit test renders the picker bare (no RouterProvider), so stub
// the action hook.
const openSettingsMock = vi.fn();
vi.mock("@/stores/tabs/use-system-tab-modal", () => ({
  useSystemTabModalActions: () => ({
    openSettings: openSettingsMock,
    openHistory: vi.fn(),
    close: vi.fn(),
    setSection: vi.fn(),
  }),
}));
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { matchDigitAction } from "@/lib/keybindings/dispatch";
import type {
  HarnessModelSelection,
  HarnessOption,
  ModelOption,
  ProviderId,
  ReasoningLevel,
  ServiceTier,
} from "@/components/home/data/landing-options";
import type { ProviderCliState } from "@traycer/protocol/host/provider-schemas";
import type { Key, ReactNode } from "react";

interface CatalogHarness extends HarnessOption {
  readonly models: ReadonlyArray<ModelOption>;
  readonly modelsLoading: boolean;
  readonly modelsError: Error | null;
}

interface QueryActivity {
  readonly enabled: boolean;
  readonly subscribed: boolean;
}

const queryMock = vi.hoisted(() => ({
  harnesses: [] as HarnessOption[],
  catalogHarnesses: [] as CatalogHarness[],
  selectedModelsByHarness: new Map<string, ReadonlyArray<ModelOption>>(),
  harnessesLoading: false,
  harnessesError: null as Error | null,
  catalogHarnessesLoading: false,
  modelsLoading: false,
  providerStates: [] as ProviderCliState[],
  cloneCatalogOnRead: false,
  calls: {
    harnesses: [] as Array<{
      readonly enabled: boolean;
      readonly subscribed: boolean;
    }>,
    catalog: [] as Array<{
      readonly workingDirectory: string | null;
      readonly enabled: boolean;
      readonly subscribed: boolean;
    }>,
    models: [] as Array<{
      readonly harnessId: string;
      readonly workingDirectory: string | null;
      readonly enabled: boolean;
      readonly subscribed: boolean;
    }>,
    providers: [] as Array<{
      readonly enabled: boolean;
      readonly subscribed: boolean;
    }>,
  },
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
      number | { readonly index: number | "LAST" };
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

vi.mock("@/hooks/harnesses/use-gui-harness-catalog", () => ({
  useGuiHarnessesQuery: (activity: QueryActivity) => {
    queryMock.calls.harnesses.push({
      enabled: activity.enabled,
      subscribed: activity.subscribed,
    });
    return {
      data: activity.enabled ? { harnesses: queryMock.harnesses } : undefined,
      isPending: activity.enabled && queryMock.harnessesLoading,
      error: queryMock.harnessesError,
    };
  },
  useGuiHarnessModelsQuery: (
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
    return {
      data: activity.enabled
        ? {
            harnessId,
            models: queryMock.selectedModelsByHarness.get(harnessId) ?? [],
          }
        : undefined,
      isPending: false,
      error: null,
    };
  },
  useGuiHarnessCatalog: (
    workingDirectory: string | null,
    activity: QueryActivity,
  ) => {
    queryMock.calls.catalog.push({
      workingDirectory,
      enabled: activity.enabled,
      subscribed: activity.subscribed,
    });
    return {
      harnesses: activity.enabled ? catalogHarnessesForRender() : [],
      harnessesLoading: activity.enabled && queryMock.catalogHarnessesLoading,
      harnessesError: null,
      modelsLoading: activity.enabled && queryMock.modelsLoading,
    };
  },
  useRefreshHarnessCatalog: () => async () => {},
}));

import { HarnessModelPicker } from "@/components/home/pickers/harness-model-picker";
import { SurfaceActivityProvider } from "@/components/home/composer/surface-activity-context";
import {
  createComposerToolbarStore,
  type ComposerToolbarStore,
} from "@/stores/composer/composer-toolbar-store";
import { useComposerHarnessMemoryStore } from "@/stores/composer/composer-harness-memory-store";
import { useProvidersFocusStore } from "@/stores/settings/providers-focus-store";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ALL_PERMISSION_MODES } from "@traycer/protocol/persistence/epic/foundation";

const CODEX_HARNESS: HarnessOption = {
  id: "codex",
  label: "Codex",
  available: true,
  error: null,
  modes: ["gui", "tui"],
  requiresApiKey: false,
  supportedPermissionModes: [...ALL_PERMISSION_MODES],
  availabilityPending: false,
};

const CLAUDE_HARNESS: HarnessOption = {
  id: "claude",
  label: "Claude",
  available: true,
  error: null,
  modes: ["gui", "tui"],
  requiresApiKey: false,
  supportedPermissionModes: [...ALL_PERMISSION_MODES],
  availabilityPending: false,
};

const OPENCODE_HARNESS: HarnessOption = {
  id: "opencode",
  label: "OpenCode",
  available: false,
  error: "OpenCode not configured",
  modes: ["gui", "tui"],
  requiresApiKey: false,
  supportedPermissionModes: [...ALL_PERMISSION_MODES],
  availabilityPending: false,
};

const OPENROUTER_HARNESS: HarnessOption = {
  id: "openrouter",
  label: "OpenRouter",
  available: false,
  error: "OpenRouter needs an API key",
  modes: ["gui"],
  requiresApiKey: true,
  supportedPermissionModes: [...ALL_PERMISSION_MODES],
  availabilityPending: false,
};

const DROID_HARNESS: HarnessOption = {
  id: "droid",
  label: "Droid",
  available: true,
  error: null,
  modes: ["gui"],
  requiresApiKey: false,
  supportedPermissionModes: [...ALL_PERMISSION_MODES],
  availabilityPending: false,
};

const CURSOR_HARNESS: HarnessOption = {
  id: "cursor",
  label: "Cursor",
  available: true,
  error: null,
  modes: ["gui"],
  requiresApiKey: false,
  supportedPermissionModes: [...ALL_PERMISSION_MODES],
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

function providerCliState(input: {
  readonly providerId: ProviderCliState["providerId"];
  readonly authStatus: ProviderCliState["auth"]["status"];
  readonly apiKey: ProviderCliState["apiKey"];
}): ProviderCliState {
  return {
    providerId: input.providerId,
    enabled: true,
    disabledBy: null,
    selected: { kind: "bundled" },
    candidates: [],
    auth: {
      status: input.authStatus,
      badgeText: null,
      label: null,
      detail: null,
    },
    authPending: false,
    checkedAt: null,
    apiKey: input.apiKey,
    terminalAgentArgs: "",
    envOverrides: [],
    loginCapability: null,
    availabilityPending: false,
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

function longClaudeModels(): ReadonlyArray<ModelOption> {
  return [
    model({
      harnessId: "claude",
      slug: "claude-opus-4-7",
      label: "Claude Opus 4.7",
      contextWindow: 200_000,
    }),
    ...Array.from({ length: 40 }, (_unused, index) =>
      model({
        harnessId: "claude",
        slug: `claude-model-${index + 1}`,
        label: `Claude Model ${index + 1}`,
      }),
    ),
  ];
}

function defaultSelection(): HarnessModelSelection {
  return { harnessId: "codex", modelSlug: "" };
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

function installClaudeCatalog(models: ReadonlyArray<ModelOption>): void {
  const codex = codexModels();
  queryMock.harnesses = [
    CODEX_HARNESS,
    CLAUDE_HARNESS,
    OPENCODE_HARNESS,
    OPENROUTER_HARNESS,
  ];
  queryMock.catalogHarnesses = [
    catalogHarness(CODEX_HARNESS, codex),
    catalogHarness(CLAUDE_HARNESS, models),
    catalogHarness(OPENCODE_HARNESS, []),
    catalogHarness(OPENROUTER_HARNESS, []),
  ];
  queryMock.selectedModelsByHarness = new Map([
    ["codex", codex],
    ["claude", models],
    ["opencode", []],
    ["openrouter", []],
  ]);
}

interface RenderPickerInput {
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
  readonly tuiOnly?: boolean;
  readonly lockedHarnessId?: ProviderId | null;
  readonly disabled?: boolean;
  readonly activityEnabled?: boolean;
}

interface PickerHarness {
  readonly store: ComposerToolbarStore;
  readonly selections: HarnessModelSelection[];
  readonly reasoningChanges: ReasoningLevel[];
  readonly serviceTierChanges: ServiceTier[];
  readonly element: (disabled: boolean) => ReactNode;
}

function pickerHarness(input: RenderPickerInput | undefined): PickerHarness {
  const resolvedInput = input ?? {};
  const selection = resolvedInput.selection ?? defaultSelection();
  const store = createComposerToolbarStore({
    seedKey: "picker-test",
    values: {
      permission: "supervised",
      selection,
      reasoning: resolvedInput.reasoning ?? "",
      serviceTier: resolvedInput.serviceTier ?? "",
      agentMode: "regular",
    },
    onSettingsChange: null,
    tuiOnly: resolvedInput.tuiOnly ?? false,
  });
  if (resolvedInput.storeModels !== undefined) {
    store.getState().setCatalog({
      harnesses: undefined,
      modelsHarnessId: selection.harnessId,
      models: resolvedInput.storeModels,
      modelsLoaded: true,
      tuiOnly: resolvedInput.tuiOnly ?? false,
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
  const element = (disabled: boolean): ReactNode => (
    <SurfaceActivityProvider active={resolvedInput.activityEnabled ?? true}>
      <TooltipProvider>
        <HarnessModelPicker
          store={store}
          withServiceTier={resolvedInput.withServiceTier ?? false}
          tuiOnly={resolvedInput.tuiOnly ?? false}
          lockedHarnessId={resolvedInput.lockedHarnessId ?? null}
          disabled={disabled}
          registerActivation={false}
        />
      </TooltipProvider>
    </SurfaceActivityProvider>
  );
  return { store, selections, reasoningChanges, serviceTierChanges, element };
}

function renderPicker(input: RenderPickerInput | undefined): PickerHarness {
  const harness = pickerHarness(input);
  render(harness.element(input?.disabled ?? false));
  return harness;
}

async function openPicker(): Promise<HTMLInputElement> {
  return openPickerByTriggerName(/^GPT-5\.5/);
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
    queryMock.harnessesLoading = false;
    queryMock.harnessesError = null;
    queryMock.catalogHarnessesLoading = false;
    queryMock.modelsLoading = false;
    queryMock.providerStates = [];
    queryMock.cloneCatalogOnRead = false;
    queryMock.calls.harnesses = [];
    queryMock.calls.catalog = [];
    queryMock.calls.models = [];
    queryMock.calls.providers = [];
    openSettingsMock.mockClear();
    useProvidersFocusStore.getState().clearFocusHarnessId();
    // Memory is a module singleton read by `commitSelection`; reset so a
    // seeded record can't leak between tests.
    useComposerHarnessMemoryStore.getState().resetForTests();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    cleanup();
    useComposerHarnessMemoryStore.getState().resetForTests();
  });

  // Seed the per-harness memory so a switch / pick restores a known record.
  function recordMemory(input: {
    readonly harnessId: ProviderId;
    readonly model: string;
    readonly reasoningEffort: string | null;
    readonly serviceTier: string | null;
  }): void {
    useComposerHarnessMemoryStore.getState().record({
      harnessId: input.harnessId,
      model: input.model,
      permissionMode: "supervised",
      reasoningEffort: input.reasoningEffort,
      serviceTier: input.serviceTier,
      agentMode: "regular",
    });
  }

  // Simulate the hook reloading the committed harness's catalog into the store
  // (the picker itself never pushes catalog; `useComposerToolbarStore` does).
  function pushStoreCatalog(
    store: ComposerToolbarStore,
    modelsHarnessId: ProviderId,
    models: ReadonlyArray<ModelOption>,
  ): void {
    act(() => {
      store.getState().setCatalog({
        harnesses: undefined,
        modelsHarnessId,
        models,
        modelsLoaded: true,
        tuiOnly: false,
      });
    });
  }

  it("opens with one search input, a provider rail, and selected provider rows", async () => {
    renderPicker(undefined);

    const input = await openPicker();

    await waitFor(() => {
      expect(document.activeElement).toBe(input);
    });
    expect(
      screen.getByRole("tablist", { name: "Model providers" }),
    ).not.toBeNull();
    expect(
      screen.getByRole("tab", { name: "Codex" }).getAttribute("aria-selected"),
    ).toBe("true");
    expect(
      screen
        .getByRole("option", { name: /GPT-5\.5/ })
        .getAttribute("aria-selected"),
    ).toBe("true");
    expect(screen.getByText("GPT-4.1")).not.toBeNull();
    expect(screen.queryByText("Claude Sonnet 4.6")).toBeNull();
  });

  it("opens the virtualized provider list at a far-down selected model", async () => {
    installClaudeCatalog(longClaudeModels());
    renderPicker({
      selection: { harnessId: "claude", modelSlug: "claude-model-32" },
    });

    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: "Claude Model 32" }),
      ).not.toBeNull();
    });
    await openPickerByTriggerName("Claude Model 32");

    await waitFor(() => {
      expect(
        screen
          .getByRole("option", { name: /Claude Model 32/ })
          .getAttribute("aria-selected"),
      ).toBe("true");
    });
  });

  it("does not use row-level scrollIntoView after a browsing rerender", async () => {
    queryMock.cloneCatalogOnRead = true;
    const scrollSpy = vi
      .spyOn(Element.prototype, "scrollIntoView")
      .mockImplementation(() => undefined);
    renderPicker({
      selection: { harnessId: "claude", modelSlug: "claude-sonnet-4-6" },
    });

    await openPickerByTriggerName("Claude Sonnet 4.6");
    const selectedRow = screen.getByRole("option", {
      name: /Claude Sonnet 4\.6/,
    });

    expect(selectedRow.getAttribute("aria-selected")).toBe("true");
    const scrollCallCount = scrollSpy.mock.calls.length;

    fireEvent.mouseEnter(
      screen.getByRole("option", { name: /Claude Opus 4\.7/ }),
    );

    await new Promise<void>((resolve) => {
      window.setTimeout(resolve, 10);
    });
    expect(scrollSpy).toHaveBeenCalledTimes(scrollCallCount);
  });

  it("commits a switch to the browsed provider from the rail", async () => {
    const { selections } = renderPicker(undefined);

    await openPicker();
    fireEvent.click(screen.getByRole("tab", { name: "Claude" }));

    // An AVAILABLE rail click now COMMITS the switch (was browse-only). No memory
    // for Claude, so the harness commits with an unresolved model (the store
    // resolves the first model once its catalog loads); the rail still rebases.
    expect(selections.at(-1)?.harnessId).toBe("claude");
    expect(screen.getByText("Claude Sonnet 4.6")).not.toBeNull();
    expect(
      screen.getByRole("tab", { name: "Claude" }).getAttribute("aria-selected"),
    ).toBe("true");
  });

  it("keeps other rail providers visible but disabled when locked", async () => {
    const { selections } = renderPicker({
      selection: { harnessId: "claude", modelSlug: "claude-opus-4-7" },
      lockedHarnessId: "claude",
    });

    await openPickerByTriggerName("Claude Opus 4.7");
    const codexTab = screen.getByRole("tab", { name: "Codex" });
    const claudeTab = screen.getByRole("tab", { name: "Claude" });

    expect(codexTab.getAttribute("aria-disabled")).toBe("true");
    expect(codexTab.getAttribute("title")).toBe(
      "Provider cannot be changed while forking terminal agent",
    );
    expect(claudeTab.getAttribute("aria-disabled")).toBeNull();
    fireEvent.focus(codexTab);
    expect((await screen.findByRole("tooltip")).textContent).toBe(
      "Provider cannot be changed while forking terminal agent",
    );
    fireEvent.click(codexTab);

    expect(
      screen.getByRole("tab", { name: "Claude" }).getAttribute("aria-selected"),
    ).toBe("true");
    expect(screen.getByText("Claude Sonnet 4.6")).not.toBeNull();
    expect(screen.queryByRole("option", { name: /GPT-5\.5/ })).toBeNull();
    expect(selections).toEqual([]);
  });

  it("keeps the rail and searches within the active harness when typing", async () => {
    renderPicker(undefined);

    const input = await openPicker();
    fireEvent.change(input, { target: { value: "4.1" } });

    // Rail stays mounted - search is local to the active harness, not global.
    expect(
      screen.getByRole("tablist", { name: "Model providers" }),
    ).not.toBeNull();
    // Matches are scoped to Codex: GPT-4.1 shows, GPT-5.5 is filtered out, and
    // no other harness's models leak in.
    expect(screen.getByRole("option", { name: /GPT-4\.1/ })).not.toBeNull();
    // GPT-5.5 still labels the trigger button, so assert on the list option only.
    expect(screen.queryByRole("option", { name: /GPT-5\.5/ })).toBeNull();
    expect(screen.queryByText("Claude Sonnet 4.6")).toBeNull();
  });

  it("selects the preferred model row as its concrete slug", async () => {
    const { selections } = renderPicker(undefined);

    await openPicker();
    fireEvent.click(screen.getByRole("option", { name: /GPT-5\.5/ }));

    expect(selections).toEqual([{ harnessId: "codex", modelSlug: "gpt-5.5" }]);
  });

  it("closes and blocks selection when disabled while already open", async () => {
    const harness = pickerHarness(undefined);
    const view = render(harness.element(false));

    await openPicker();
    view.rerender(harness.element(true));

    await waitFor(() => {
      expect(screen.queryByRole("textbox", { name: /^Search/ })).toBeNull();
    });
    view.rerender(harness.element(false));

    expect(screen.queryByRole("textbox", { name: /^Search/ })).toBeNull();
    expect(harness.selections).toEqual([]);
  });

  it("detaches harness queries while inactive", () => {
    renderPicker({ activityEnabled: false });

    expect(queryMock.calls.harnesses.at(-1)).toEqual({
      enabled: false,
      subscribed: false,
    });
    expect(queryMock.calls.models.at(-1)).toEqual({
      harnessId: "codex",
      workingDirectory: null,
      enabled: false,
      subscribed: false,
    });
    expect(queryMock.calls.catalog.at(-1)).toEqual({
      workingDirectory: null,
      enabled: false,
      subscribed: false,
    });
    expect(queryMock.calls.providers.at(-1)).toEqual({
      enabled: false,
      subscribed: false,
    });
  });

  it("keeps provider state warm before opening the picker", () => {
    renderPicker(undefined);

    expect(queryMock.calls.providers.at(-1)).toEqual({
      enabled: true,
      subscribed: true,
    });
  });

  it("hides unavailable providers that are not recoverable from the rail", async () => {
    renderPicker(undefined);

    await openPicker();

    // OpenCode is unavailable → hidden entirely, not greyed.
    expect(
      screen.queryByRole("tab", { name: "OpenCode unavailable" }),
    ).toBeNull();
    expect(screen.queryByRole("tab", { name: "OpenCode" })).toBeNull();
    // Available providers remain selectable.
    expect(screen.getByRole("tab", { name: "Codex" })).not.toBeNull();
    expect(screen.getByRole("tab", { name: "Claude" })).not.toBeNull();
  });

  it("orders the rail by provider defaults and moves degraded providers down", async () => {
    const codex = codexModels();
    const claude = claudeModels();
    queryMock.harnesses = [
      OPENROUTER_HARNESS,
      CURSOR_HARNESS,
      CLAUDE_HARNESS,
      DROID_HARNESS,
      CODEX_HARNESS,
      OPENCODE_HARNESS,
    ];
    queryMock.catalogHarnesses = [
      catalogHarness(OPENROUTER_HARNESS, []),
      catalogHarness(CURSOR_HARNESS, []),
      catalogHarness(CLAUDE_HARNESS, claude),
      catalogHarness(DROID_HARNESS, []),
      catalogHarness(CODEX_HARNESS, codex),
      catalogHarness(OPENCODE_HARNESS, []),
    ];
    queryMock.selectedModelsByHarness = new Map([
      ["codex", codex],
      ["claude", claude],
      ["cursor", []],
      ["droid", []],
      ["opencode", []],
      ["openrouter", []],
    ]);

    renderPicker(undefined);

    await openPicker();
    const tabs = screen.getAllByRole("tab");

    expect(tabs.map((tab) => tab.getAttribute("aria-label"))).toEqual([
      "Codex",
      "Claude",
      "Droid",
      "Cursor",
      "OpenRouter",
    ]);
    expect(
      screen
        .getByRole("tab", { name: "OpenRouter" })
        .getAttribute("data-degraded"),
    ).toBe("true");
    const openRouterDescriptionId = screen
      .getByRole("tab", { name: "OpenRouter" })
      .getAttribute("aria-describedby");
    if (openRouterDescriptionId === null) {
      throw new Error("Expected degraded provider to have a description.");
    }
    expect(document.getElementById(openRouterDescriptionId)?.textContent).toBe(
      "Setup required",
    );
    expect(
      screen.getByRole("tab", { name: "Codex" }).getAttribute("data-degraded"),
    ).toBeNull();
  });

  it("keeps signed-out providers visible as degraded rail items", async () => {
    const codex = codexModels();
    const signedOutClaude: HarnessOption = {
      ...CLAUDE_HARNESS,
      available: false,
      error: "Claude is signed out",
    };
    queryMock.harnesses = [signedOutClaude, CODEX_HARNESS];
    queryMock.catalogHarnesses = [
      catalogHarness(signedOutClaude, []),
      catalogHarness(CODEX_HARNESS, codex),
    ];
    queryMock.selectedModelsByHarness = new Map([
      ["codex", codex],
      ["claude", []],
    ]);
    queryMock.providerStates = [
      providerCliState({
        providerId: "claude-code",
        authStatus: "unauthenticated",
        apiKey: { supported: false, configured: false, source: null },
      }),
    ];

    renderPicker(undefined);

    await openPicker();
    const claudeTab = screen.getByRole("tab", { name: "Claude" });

    expect(screen.getAllByRole("tab")).toEqual([
      screen.getByRole("tab", { name: "Codex" }),
      screen.getByRole("tab", { name: "Claude" }),
    ]);
    expect(claudeTab.getAttribute("data-degraded")).toBe("true");

    fireEvent.click(claudeTab);

    expect(
      screen.getByRole("option", { name: "Claude unavailable" }),
    ).not.toBeNull();
  });

  it("keeps unavailable API-key providers visible with a settings CTA", async () => {
    renderPicker(undefined);

    await openPicker();
    fireEvent.click(screen.getByRole("tab", { name: "OpenRouter" }));

    expect(screen.getByText("Connect OpenRouter")).not.toBeNull();
    expect(
      screen.getByText(
        "OpenRouter needs an API key to list models and start chats. Add yours in Provider settings to get started.",
      ),
    ).not.toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Add API key" }));

    expect(useProvidersFocusStore.getState().focusHarnessId).toBe("openrouter");
    expect(openSettingsMock).toHaveBeenCalledWith({
      section: "providers",
      resetToGeneral: false,
    });
  });

  it("keeps the query when switching harness, re-scopes the results, and commits", async () => {
    const { selections } = renderPicker(undefined);

    const input = await openPicker();
    // "opus" matches nothing in Codex (the active harness) -> scope-aware empty.
    fireEvent.change(input, { target: { value: "opus" } });
    expect(screen.getByText("No Codex models match")).not.toBeNull();
    expect(screen.queryByText("Claude Opus 4.7")).toBeNull();

    // Switching to Claude from the rail keeps the typed query and re-runs it
    // against Claude's models, now surfacing the match - AND commits the switch.
    fireEvent.click(screen.getByRole("tab", { name: "Claude" }));

    expect(input.value).toBe("opus");
    expect(
      screen.getByRole("option", { name: /Claude Opus 4\.7/ }),
    ).not.toBeNull();
    expect(selections.at(-1)?.harnessId).toBe("claude");
  });

  it("renders thinking effort controls in the picker footer", async () => {
    const { reasoningChanges } = renderPicker({
      reasoning: "high",
      storeModels: [
        model({
          slug: "gpt-5.5",
          label: "GPT-5.5",
          supportedReasoningEfforts: [
            { id: "low", label: "Low", description: null },
            { id: "high", label: "High", description: null },
          ],
        }),
      ],
    });

    await openPicker();

    expect(
      screen.getByRole("group", { name: "Thinking effort" }),
    ).not.toBeNull();
    expect(
      screen.getByRole("button", { name: "High" }).getAttribute("aria-pressed"),
    ).toBe("true");

    fireEvent.click(screen.getByRole("button", { name: "Low" }));

    expect(reasoningChanges).toEqual(["low"]);
  });

  it("renders fast mode controls in the picker footer", async () => {
    const { serviceTierChanges } = renderPicker({
      withServiceTier: true,
      storeModels: [
        model({
          slug: "gpt-5.5",
          label: "GPT-5.5",
          supportedServiceTiers: [
            { id: "standard", label: "Standard", description: null },
            { id: "fast", label: "Fast", description: null },
          ],
          defaultServiceTier: "standard",
        }),
      ],
    });

    await openPicker();

    const fastButton = screen.getByRole("button", { name: "Fast mode" });
    expect(fastButton.getAttribute("aria-pressed")).toBe("false");

    fireEvent.click(fastButton);

    expect(serviceTierChanges).toEqual(["fast"]);
  });

  it("marks fast mode active in the picker footer", async () => {
    renderPicker({
      withServiceTier: true,
      serviceTier: "fast",
      storeModels: [
        model({
          slug: "gpt-5.5",
          label: "GPT-5.5",
          supportedServiceTiers: [
            { id: "standard", label: "Standard", description: null },
            { id: "fast", label: "Fast", description: null },
          ],
          defaultServiceTier: "standard",
        }),
      ],
    });

    await openPicker();

    expect(
      screen
        .getByRole("button", { name: "Fast mode" })
        .getAttribute("aria-pressed"),
    ).toBe("true");
  });

  it("supports Arrow, Enter, and Escape from the search input", async () => {
    const { selections } = renderPicker(undefined);

    const input = await openPicker();
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(selections).toEqual([{ harnessId: "codex", modelSlug: "gpt-4.1" }]);
  });

  it("clears search with Escape before closing the picker", async () => {
    renderPicker(undefined);

    const input = await openPicker();
    fireEvent.change(input, { target: { value: "4.1" } });
    // Scoped filter is active: GPT-5.5 is hidden behind the query (it still
    // labels the trigger button, so assert on the list option only).
    expect(screen.queryByRole("option", { name: /GPT-5\.5/ })).toBeNull();

    fireEvent.keyDown(input, { key: "Escape" });

    // Escape clears the query first (not closing), restoring the full Codex list.
    expect(input.value).toBe("");
    expect(screen.getByRole("option", { name: /GPT-5\.5/ })).not.toBeNull();
    expect(
      screen.getByRole("tablist", { name: "Model providers" }),
    ).not.toBeNull();
  });

  it("commits a switch via the leader digit", async () => {
    const { selections } = renderPicker(undefined);

    await openPicker();
    // ⌘2 → the 2nd rail provider (Claude). Now COMMITS the switch (was
    // browse-only), exactly like clicking the rail icon; the popover stays open.
    act(() => {
      fireLeaderDigit(2, "mod");
    });

    await waitFor(() => {
      expect(
        screen
          .getByRole("tab", { name: "Claude" })
          .getAttribute("aria-selected"),
      ).toBe("true");
    });
    expect(screen.getByText("Claude Sonnet 4.6")).not.toBeNull();
    expect(selections.at(-1)?.harnessId).toBe("claude");
  });

  it("sets the thinking level with the sub-leader digit", async () => {
    const { reasoningChanges } = renderPicker({
      reasoning: "low",
      storeModels: [
        model({
          slug: "gpt-5.5",
          label: "GPT-5.5",
          supportedReasoningEfforts: [
            { id: "low", label: "Low", description: null },
            { id: "high", label: "High", description: null },
          ],
        }),
      ],
    });

    await openPicker();
    // ⌥2 → second thinking level. The browsed provider (Codex) matches the
    // selected model's, so the footer is actionable.
    act(() => {
      fireLeaderDigit(2, "alt");
    });

    expect(reasoningChanges).toEqual(["high"]);
  });

  it("sets the thinking level on the now-committed model after a rail switch", async () => {
    // The old "browse a different provider without committing" premise is gone -
    // a rail switch now COMMITS. Once the new harness's catalog loads, the footer
    // reflects the committed model and ⌥-digit sets ITS effort.
    const { store, reasoningChanges } = renderPicker({
      storeModels: [
        model({
          slug: "gpt-5.5",
          label: "GPT-5.5",
          supportedReasoningEfforts: [
            { id: "low", label: "Low", description: null },
            { id: "high", label: "High", description: null },
          ],
        }),
      ],
    });

    await openPicker();
    fireEvent.click(screen.getByRole("tab", { name: "Claude" }));
    // Hook reloads Claude's catalog post-switch; the committed (empty) slug
    // resolves to the first Claude model, which exposes thinking levels.
    pushStoreCatalog(store, "claude", [
      model({
        harnessId: "claude",
        slug: "claude-opus-4-7",
        label: "Claude Opus 4.7",
        defaultReasoningEffort: "low",
        supportedReasoningEfforts: [
          { id: "low", label: "Low", description: null },
          { id: "high", label: "High", description: null },
        ],
      }),
    ]);
    act(() => {
      fireLeaderDigit(2, "alt");
    });

    expect(reasoningChanges.at(-1)).toBe("high");
  });

  it("does not commit a degraded provider (browse + reauth CTA only)", async () => {
    // OpenRouter is signed-out -> degraded. Clicking it browses (the panel shows
    // its reauth CTA) but must NOT commit a switch.
    queryMock.providerStates = [
      providerCliState({
        providerId: "openrouter",
        authStatus: "unauthenticated",
        apiKey: { supported: true, configured: false, source: null },
      }),
    ];
    const { selections } = renderPicker(undefined);

    await openPicker();
    fireEvent.click(screen.getByRole("tab", { name: "OpenRouter" }));

    // Browsed (rail rebased) but never committed.
    expect(
      screen
        .getByRole("tab", { name: "OpenRouter" })
        .getAttribute("aria-selected"),
    ).toBe("true");
    expect(selections).toEqual([]);
  });

  it("restores the remembered (harness, model) effort + tier on a rail switch", async () => {
    recordMemory({
      harnessId: "claude",
      model: "claude-opus-4-7",
      reasoningEffort: "high",
      serviceTier: "fast",
    });
    const { selections, reasoningChanges, serviceTierChanges } = renderPicker({
      withServiceTier: true,
    });

    await openPicker();
    fireEvent.click(screen.getByRole("tab", { name: "Claude" }));

    // The switch restores the harness's last model AND that pair's effort/tier.
    expect(selections.at(-1)).toEqual({
      harnessId: "claude",
      modelSlug: "claude-opus-4-7",
    });
    expect(reasoningChanges.at(-1)).toBe("high");
    expect(serviceTierChanges.at(-1)).toBe("fast");
  });

  it("restores a (harness, model) record on a model-row pick", async () => {
    recordMemory({
      harnessId: "codex",
      model: "gpt-4.1",
      reasoningEffort: "high",
      serviceTier: null,
    });
    const { selections, reasoningChanges } = renderPicker(undefined);

    await openPicker();
    fireEvent.click(screen.getByRole("option", { name: /GPT-4\.1/ }));

    expect(selections.at(-1)).toEqual({
      harnessId: "codex",
      modelSlug: "gpt-4.1",
    });
    expect(reasoningChanges.at(-1)).toBe("high");
  });

  it("uses the model's own default effort for an unvisited model (no-carry)", async () => {
    // No memory for this (harness, model): the pick passes reasoning "" and the
    // store resolves it to the model's OWN default, overriding the sticky value.
    const { reasoningChanges } = renderPicker({
      reasoning: "high",
      storeModels: [
        model({
          harnessId: "codex",
          slug: "gpt-4.1",
          label: "GPT-4.1",
          defaultReasoningEffort: "medium",
          supportedReasoningEfforts: [
            { id: "low", label: "Low", description: null },
            { id: "medium", label: "Medium", description: null },
            { id: "high", label: "High", description: null },
          ],
        }),
      ],
    });

    // The trigger reflects the store's first model (GPT-4.1) here, not GPT-5.5.
    await openPickerByTriggerName(/^GPT-4\.1/);
    fireEvent.click(screen.getByRole("option", { name: /GPT-4\.1/ }));

    expect(reasoningChanges.at(-1)).toBe("medium");
  });

  it("resolves a stale remembered slug to the first model on a switch", async () => {
    // Claude's remembered model was delisted. The switch carries the stale slug,
    // and once Claude's catalog loads (without it) the derive falls back to the
    // first model.
    recordMemory({
      harnessId: "claude",
      model: "claude-delisted",
      reasoningEffort: null,
      serviceTier: null,
    });
    const { store, selections } = renderPicker(undefined);

    await openPicker();
    fireEvent.click(screen.getByRole("tab", { name: "Claude" }));
    // Stale slug is held for display until the catalog proves it absent.
    expect(selections.at(-1)).toEqual({
      harnessId: "claude",
      modelSlug: "claude-delisted",
    });

    pushStoreCatalog(store, "claude", [
      model({
        harnessId: "claude",
        slug: "claude-opus-4-7",
        label: "Claude Opus 4.7",
      }),
    ]);

    // Catalog loaded WITHOUT the stale slug -> resolves to the first model.
    expect(store.getState().selection).toEqual({
      harnessId: "claude",
      modelSlug: "claude-opus-4-7",
    });
  });
});

// Fire a leader digit straight through the scope stack (the picker registers
// its scope on open). No KeybindingProvider is mounted here, so only the
// picker's own scope is present - exactly the surface under test.
function fireLeaderDigit(digit: number, modifier: "mod" | "alt"): void {
  const match = matchDigitAction(
    new KeyboardEvent("keydown", {
      code: digit === 0 ? "Digit0" : `Digit${digit}`,
      metaKey: modifier === "mod",
      altKey: modifier === "alt",
    }),
  );
  match?.run();
}
