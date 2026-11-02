/**
 * A team sandbox's rail never commits a harness the sandbox does not offer.
 *
 * The model rows of a blocked harness are already unselectable
 * (`team-sandbox-harness.test.tsx` drives the panel body). The provider RAIL
 * is the other road to a commit: an available rail entry commits its switch
 * on click, so a blocked entry must only be browsed (the panel names why),
 * never committed; a placeholder harness's entry still commits, and off a team
 * host nothing changes.
 *
 * This renders the whole `HarnessModelPicker` with the host-backed hooks
 * mocked at their boundaries, as `harness-model-picker.test.tsx` does.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { Fragment, type Key, type ReactNode } from "react";
import type {
  HarnessModelSelection,
  HarnessOption,
  ModelOption,
} from "@/components/home/data/landing-options";
import { ALL_PERMISSION_MODES } from "@traycer/protocol/persistence/epic/foundation";
import { resetPaneActivationFocusIntentsForTests } from "@/components/epic-canvas/pane-activation";

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

const mocks = vi.hoisted(() => ({
  harnesses: [] as HarnessOption[],
  catalogHarnesses: [] as CatalogHarness[],
  modelsByHarness: new Map<string, ReadonlyArray<ModelOption>>(),
  onTeamSandbox: { current: false },
}));

vi.mock("@/hooks/sandboxes/use-on-team-sandbox", () => ({
  useOnTeamSandbox: (): boolean => mocks.onTeamSandbox.current,
  useHostOwnerTeamId: (): string | null =>
    mocks.onTeamSandbox.current ? "t1" : null,
}));

vi.mock("@/stores/tabs/use-system-tab-modal", () => ({
  useSystemTabModalActions: () => ({
    openSettings: vi.fn(),
    openHistory: vi.fn(),
    close: vi.fn(),
    setSection: vi.fn(),
  }),
}));

vi.mock("@/hooks/rate-limits/use-profile-usage-comparison", () => ({
  useProfileUsageComparison: (args: {
    readonly runTargetHostId: string | null;
  }) => ({ hostId: args.runTargetHostId, isReady: true, entries: new Map() }),
}));

vi.mock("@/hooks/providers/use-providers-ensure-pack-mutation", () => ({
  useProvidersEnsurePackForClient: () => ({ mutate: vi.fn() }),
}));

vi.mock("@/hooks/providers/use-providers-list-query", () => ({
  useProvidersList: (activity: QueryActivity) => ({
    data: activity.enabled ? { providers: [] } : undefined,
    isPending: false,
    isError: false,
    isFetching: false,
  }),
  useProvidersListForClient: (
    client: MockHostClient | null,
    activity: QueryActivity,
  ) => {
    if (client === null) {
      return {
        data: undefined,
        isPending: true,
        isError: false,
        error: null,
        isFetching: false,
      };
    }
    return {
      data: activity.enabled ? { providers: [] } : undefined,
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

vi.mock("@/hooks/host/use-host-client-for-host-id", () => ({
  useHostClientForHostId: (hostId: string | null): MockHostClient => ({
    id: hostId ?? "default",
    getActiveHostId: () => hostId ?? "default",
    getActiveHost: () => ({ websocketUrl: "ws://127.0.0.1:59998/stream" }),
  }),
}));

vi.mock("@/hooks/host/use-reactive-host-readiness", () => ({
  useReactiveHostReadiness: (client: MockHostClient | null) => {
    const hostId = client?.getActiveHostId() ?? null;
    return {
      hostId,
      requestContextUserId: "user-1",
      isReady: hostId !== null,
      hasRpcEndpoint: true,
      canExecute: hostId !== null,
    };
  },
}));

vi.mock("@/hooks/agent/use-host-reachability", () => ({
  useHostReachability: (hostId: string) => ({
    status: "reachable",
    hostLabel: hostId,
    unavailability: null,
    basis: "directory",
    hostKind: "local",
  }),
}));

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
    ],
  }),
}));

// jsdom has no layout, so the virtualised list renders no rows: render them all.
vi.mock("react-virtuoso", () => ({
  Virtuoso: (props: {
    readonly id: string | undefined;
    readonly role: string | undefined;
    readonly totalCount: number | undefined;
    readonly computeItemKey:
      | ((index: number, item: undefined) => Key)
      | undefined;
    readonly itemContent:
      | ((index: number, item: undefined) => ReactNode)
      | undefined;
  }) => (
    <div id={props.id} role={props.role}>
      {Array.from({ length: props.totalCount ?? 0 }, (_unused, index) => (
        <Fragment key={props.computeItemKey?.(index, undefined) ?? index}>
          {props.itemContent?.(index, undefined)}
        </Fragment>
      ))}
    </div>
  ),
}));

// The picker's cloud read of Traycer's models, made only when a sandbox
// refusal opens it; nothing here opens one.
vi.mock("@/hooks/sandboxes/use-sandbox-traycer-models-query", () => ({
  useSandboxTraycerModels: () => ({
    data: undefined,
    error: null,
    isPending: false,
  }),
}));
vi.mock("@/hooks/harnesses/use-gui-harness-catalog", () => ({
  harnessCatalogEntryNeedsRefresh: () => true,
  useGuiHarnessesQueryForClient: (
    client: MockHostClient | null,
    activity: QueryActivity,
  ) => {
    if (client === null) {
      return { data: undefined, isPending: true, isError: false, error: null };
    }
    return {
      data: activity.enabled ? { harnesses: mocks.harnesses } : undefined,
      isPending: false,
      isError: false,
      error: null,
    };
  },
  useGuiHarnessModelsQueryForClient: (
    client: MockHostClient | null,
    harnessId: string,
    _workingDirectory: string | null,
    activity: QueryActivity,
  ) => {
    if (client === null) {
      return {
        data: undefined,
        isPending: true,
        isError: false,
        error: null,
        refetch: () => Promise.resolve({ data: undefined }),
      };
    }
    return {
      data: activity.enabled
        ? { harnessId, models: mocks.modelsByHarness.get(harnessId) ?? [] }
        : undefined,
      isPending: false,
      isError: false,
      error: null,
      refetch: () => Promise.resolve({ data: undefined }),
    };
  },
  useGuiHarnessCommandsQuery: (
    _client: unknown,
    harnessId: string,
    _workingDirectories: ReadonlyArray<string>,
    activity: QueryActivity,
  ) => ({
    data: activity.enabled ? { harnessId, commands: [] } : undefined,
    isPending: false,
    error: null,
    refetch: () => Promise.resolve({ data: undefined }),
  }),
  useGuiHarnessCatalogForClient: (
    client: MockHostClient | null,
    _workingDirectory: string | null,
    activity: QueryActivity,
  ) => {
    if (client === null) {
      return {
        harnesses: [],
        harnessesLoading: false,
        harnessesError: null,
        modelsLoading: false,
      };
    }
    return {
      harnesses: activity.enabled ? mocks.catalogHarnesses : [],
      harnessesLoading: false,
      harnessesError: null,
      modelsLoading: false,
    };
  },
  useRefreshHarnessCatalogForClient: () => () => Promise.resolve(),
}));

import { HarnessModelPicker } from "@/components/home/pickers/harness-model-picker";
import { SurfaceActivityProvider } from "@/components/home/composer/surface-activity-context";
import {
  createComposerToolbarStore,
  type ComposerToolbarStore,
} from "@/stores/composer/composer-toolbar-store";
import { useComposerHarnessMemoryStore } from "@/stores/composer/composer-harness-memory-store";
import { TooltipProvider } from "@/components/ui/tooltip";

const HOST_ID = "host-a";
const UNAVAILABLE_TESTID = "picker-team-sandbox-unavailable";

function harnessOption(
  id: HarnessOption["id"],
  label: string,
  mode: "placeholder" | "process-scoped",
): HarnessOption {
  return {
    id,
    label,
    enabled: true,
    available: true,
    error: null,
    modes: ["gui"],
    requiresApiKey: false,
    supportedPermissionModes: [...ALL_PERMISSION_MODES],
    nativeAutoJudge: false,
    availabilityPending: false,
    sandboxCredentialMode: mode,
    sandboxCredentialNote: null,
  };
}

function model(harnessId: HarnessOption["id"], slug: string): ModelOption {
  return {
    harnessId,
    slug,
    label: slug,
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
}

function installCatalog(): void {
  const entries: ReadonlyArray<{
    readonly option: HarnessOption;
    readonly models: ReadonlyArray<ModelOption>;
  }> = [
    {
      option: harnessOption("codex", "Codex", "placeholder"),
      models: [model("codex", "codex-main")],
    },
    {
      option: harnessOption("claude", "Claude", "process-scoped"),
      models: [model("claude", "claude-main")],
    },
    {
      option: harnessOption("droid", "Droid", "placeholder"),
      models: [model("droid", "droid-main")],
    },
  ];
  mocks.harnesses = entries.map((entry) => entry.option);
  mocks.catalogHarnesses = entries.map((entry) => ({
    ...entry.option,
    models: entry.models,
    modelsLoading: false,
    modelsError: null,
  }));
  mocks.modelsByHarness = new Map(
    entries.map((entry) => [entry.option.id, entry.models]),
  );
}

interface RenderedPicker {
  readonly store: ComposerToolbarStore;
  readonly selections: HarnessModelSelection[];
}

function renderPicker(): RenderedPicker {
  const store = createComposerToolbarStore({
    purpose: "run",
    reasoningFallback: "model-default",
    seedKey: "team-rail-test",
    values: {
      ultracode: false,
      permission: "supervised",
      selection: {
        harnessId: "codex",
        modelSlug: "codex-main",
        profileId: null,
      },
      reasoning: "",
      serviceTier: "",
    },
    onSettingsChange: null,
    tuiOnly: false,
    chatLineCarriesAutoMode: null,
    ultracodeCarried: false,
    hostId: HOST_ID,
  });
  const selections: HarnessModelSelection[] = [];
  store.subscribe((state, previous) => {
    if (state.selection !== previous.selection) {
      selections.push(state.selection);
    }
  });
  render(
    <SurfaceActivityProvider active>
      <TooltipProvider delayDuration={0}>
        <HarnessModelPicker
          withUltracode={false}
          labelDisplay="responsive"
          store={store}
          maxModeContext={{ kind: "none" }}
          withServiceTier={false}
          withReasoning
          tuiOnly={false}
          lockedHarnessId={null}
          disabled={false}
          registerActivation={false}
          createProfileHostId={null}
          runTargetHostId={null}
          profileAdmission={null}
          terminalLoginSurface={null}
          embedding={null}
        />
      </TooltipProvider>
    </SurfaceActivityProvider>,
  );
  return { store, selections };
}

async function openPicker(): Promise<void> {
  fireEvent.click(screen.getByRole("button", { name: /^codex-main/ }));
  await screen.findByRole("textbox", { name: /^Search/ });
}

describe("harness picker rail on a team sandbox", () => {
  beforeEach(() => {
    installCatalog();
    mocks.onTeamSandbox.current = false;
    useComposerHarnessMemoryStore.getState().resetForTests();
  });
  afterEach(() => {
    cleanup();
    resetPaneActivationFocusIntentsForTests();
    useComposerHarnessMemoryStore.getState().resetForTests();
  });

  it("browses a blocked harness from the rail without committing it, and says why", async () => {
    mocks.onTeamSandbox.current = true;
    const { store, selections } = renderPicker();
    await openPicker();

    fireEvent.click(screen.getByRole("tab", { name: "Claude" }));

    expect(store.getState().selection.harnessId).toBe("codex");
    expect(selections).toEqual([]);
    expect(screen.getByTestId(UNAVAILABLE_TESTID).textContent).toBe(
      "Not available on team sandboxes.",
    );
  });

  it("still commits a placeholder harness's rail entry on a team sandbox", async () => {
    mocks.onTeamSandbox.current = true;
    const { store } = renderPicker();
    await openPicker();

    fireEvent.click(screen.getByRole("tab", { name: "Droid" }));

    expect(store.getState().selection.harnessId).toBe("droid");
    expect(screen.queryByTestId(UNAVAILABLE_TESTID)).toBeNull();
  });

  it("commits the same process-scoped rail entry off a team sandbox", async () => {
    mocks.onTeamSandbox.current = false;
    const { store } = renderPicker();
    await openPicker();

    fireEvent.click(screen.getByRole("tab", { name: "Claude" }));

    expect(store.getState().selection.harnessId).toBe("claude");
    expect(screen.queryByTestId(UNAVAILABLE_TESTID)).toBeNull();
  });
});
