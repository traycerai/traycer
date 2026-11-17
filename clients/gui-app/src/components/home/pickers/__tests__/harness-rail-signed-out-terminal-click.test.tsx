/**
 * A click on a provider's rail tab while its Terminal login is signed out.
 *
 * With exactly one enabled, signed-in managed profile the click commits that
 * profile; with two or more it only browses and commits nothing; with none
 * the tab is dimmed and commits nothing. Renders the whole `HarnessModelPicker`
 * with the host-backed hooks mocked at their boundaries, as
 * `team-sandbox-harness-rail.test.tsx` does.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { Fragment, type Key, type ReactNode } from "react";
import type { ProviderCliState } from "@traycer/protocol/host/provider-schemas";
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
  providers: [] as ProviderCliState[],
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
    data: activity.enabled ? { providers: mocks.providers } : undefined,
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
      data: activity.enabled ? { providers: mocks.providers } : undefined,
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

import {
  legacyProfile,
  providerState,
} from "@/components/providers/__tests__/profile-pin-fixtures";

const HOST_ID = "host-a";

function harnessOption(
  id: HarnessOption["id"],
  label: string,
  authStatus: HarnessOption["authStatus"],
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
    authStatus,
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
      option: harnessOption("codex", "Codex", "authenticated"),
      models: [model("codex", "codex-main")],
    },
    {
      option: harnessOption("claude", "Claude", "unauthenticated"),
      models: [model("claude", "claude-main")],
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

/** Claude Code with its Terminal login signed out and the given managed rows. */
function claudeWithSignedOutTerminal(
  managed: ReadonlyArray<{
    readonly profileId: string;
    readonly signedIn: boolean;
  }>,
): ProviderCliState {
  return providerState({
    providerId: "claude-code",
    authStatus: "unauthenticated",
    profiles: [
      legacyProfile({
        profileId: "ambient",
        label: "Terminal",
        kind: "ambient",
        enabled: true,
        authStatus: "unauthenticated",
      }),
      ...managed.map((row) =>
        legacyProfile({
          profileId: row.profileId,
          label: row.profileId,
          kind: "managed",
          enabled: true,
          authStatus: row.signedIn ? "authenticated" : "unauthenticated",
        }),
      ),
    ],
  });
}

interface RenderedPicker {
  readonly store: ComposerToolbarStore;
  readonly selections: HarnessModelSelection[];
}

function renderPicker(): RenderedPicker {
  const store = createComposerToolbarStore({
    purpose: "run",
    reasoningFallback: "model-default",
    seedKey: "signed-out-terminal-click-test",
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

describe("a click on a rail tab whose Terminal login is signed out", () => {
  beforeEach(() => {
    installCatalog();
    mocks.onTeamSandbox.current = false;
    mocks.providers = [];
    useComposerHarnessMemoryStore.getState().resetForTests();
  });
  afterEach(() => {
    cleanup();
    resetPaneActivationFocusIntentsForTests();
    useComposerHarnessMemoryStore.getState().resetForTests();
  });

  it("commits the one signed-in managed profile", async () => {
    mocks.providers = [
      claudeWithSignedOutTerminal([{ profileId: "work-uuid", signedIn: true }]),
    ];
    const { store } = renderPicker();
    await openPicker();

    fireEvent.click(screen.getByRole("tab", { name: "Claude" }));

    expect(store.getState().selection.harnessId).toBe("claude");
    expect(store.getState().selection.profileId).toBe("work-uuid");
  });

  it("commits nothing for two signed-in managed profiles: the person picks", async () => {
    mocks.providers = [
      claudeWithSignedOutTerminal([
        { profileId: "work-uuid", signedIn: true },
        { profileId: "side-uuid", signedIn: true },
      ]),
    ];
    const { store, selections } = renderPicker();
    await openPicker();

    fireEvent.click(screen.getByRole("tab", { name: "Claude" }));

    expect(selections).toEqual([]);
    expect(store.getState().selection).toEqual({
      harnessId: "codex",
      modelSlug: "codex-main",
      profileId: null,
    });
  });

  it("commits nothing while no managed profile is signed in: the tab is dimmed", async () => {
    mocks.providers = [
      claudeWithSignedOutTerminal([
        { profileId: "work-uuid", signedIn: false },
      ]),
    ];
    const { store, selections } = renderPicker();
    await openPicker();

    fireEvent.click(screen.getByRole("tab", { name: "Claude" }));

    expect(selections).toEqual([]);
    expect(store.getState().selection.harnessId).toBe("codex");
  });
});
