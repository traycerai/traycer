/**
 * A sandbox refusal's "Choose a model" on a host that has Traycer off: the
 * picker opens on what sandboxes run, and Traycer's rows come from the cloud's
 * Traycer catalog, never from the picker host's own harness list, which has
 * no Traycer models to give. Choosing one picks Traycer and that model.
 *
 * This renders the whole `HarnessModelPicker` with the host-backed hooks
 * mocked at their boundaries, as `team-sandbox-harness-rail.test.tsx` does,
 * and opens it the way the refusal does.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { Fragment, type Key, type ReactNode } from "react";
import type {
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
  /** Every harness whose models the picker asked its HOST for. */
  hostModelReads: new Set<string>(),
  /** Harnesses whose `listModels` the host refuses (Traycer off there). */
  hostModelsRefused: new Set<string>(),
  /** Hosts the directory reads as unreachable. */
  unreachableHosts: new Set<string>(),
  cloud: {
    data: undefined as ReadonlyArray<ModelOption> | undefined,
    isPending: false,
    error: null as Error | null,
    enabled: [] as boolean[],
  },
}));

vi.mock("@/hooks/sandboxes/use-on-team-sandbox", () => ({
  useOnTeamSandbox: (): boolean => false,
  useHostOwnerTeamId: (): string | null => null,
  useSandboxHostConfiguration: (): null => null,
}));

vi.mock("@/hooks/command-palette/use-register-composer-controls", () => ({
  useRegisterFocusedComposerControls: () => undefined,
}));

vi.mock("@/hooks/providers/use-resolved-seeded-profile-id", () => ({
  useResolvedSeededProfileId: (_harnessId: string, profileId: string | null) =>
    profileId,
}));

// The cloud's Traycer catalog, `GET /api/traycer/models`.
vi.mock("@/hooks/sandboxes/use-sandbox-traycer-models-query", () => ({
  useSandboxTraycerModels: (enabled: boolean) => {
    mocks.cloud.enabled.push(enabled);
    return {
      data: mocks.cloud.data,
      isPending: mocks.cloud.isPending,
      error: mocks.cloud.error,
    };
  },
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

vi.mock("@/hooks/agent/use-host-reachability", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/hooks/agent/use-host-reachability")
  >()),
  useHostReachability: (hostId: string) => ({
    status: mocks.unreachableHosts.has(hostId) ? "unreachable" : "reachable",
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
    if (activity.enabled) mocks.hostModelReads.add(harnessId);
    if (mocks.hostModelsRefused.has(harnessId)) {
      return {
        data: undefined,
        isPending: false,
        isError: true,
        error: new Error("PROVIDER_DISABLED"),
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
import { useComposerToolbarStore } from "@/components/home/hooks/use-composer-toolbar-store";
import { fallbackSeedSource } from "@/lib/composer/composer-seed-source";
import {
  useStagedSandboxStore,
  type StagedSandboxTarget,
} from "@/stores/composer/staged-sandbox-store";
import { SurfaceActivityProvider } from "@/components/home/composer/surface-activity-context";
import {
  createComposerToolbarStore,
  type ComposerToolbarStore,
} from "@/stores/composer/composer-toolbar-store";
import { useComposerHarnessMemoryStore } from "@/stores/composer/composer-harness-memory-store";
import {
  openActiveModelPickerForHarness,
  resetActiveModelPickerForTests,
} from "@/lib/commands/active-model-picker-registry";
import { TooltipProvider } from "@/components/ui/tooltip";

const HOST_ID = "host-a";

function harnessOption(
  id: HarnessOption["id"],
  label: string,
  available: boolean,
): HarnessOption {
  return {
    id,
    label,
    enabled: available,
    available,
    error: null,
    modes: ["gui"],
    requiresApiKey: false,
    supportedPermissionModes: [...ALL_PERMISSION_MODES],
    nativeAutoJudge: false,
    availabilityPending: false,
    sandboxCredentialMode: "placeholder",
    sandboxCredentialNote: null,
  };
}

function model(
  harnessId: HarnessOption["id"],
  slug: string,
  label: string,
): ModelOption {
  return {
    harnessId,
    slug,
    label,
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

const CLOUD_MODELS: ReadonlyArray<ModelOption> = [
  model("traycer", "traycer:claude-sonnet-5-5", "Claude Sonnet 5.5"),
  model("traycer", "traycer:gpt-6-1", "GPT 6.1"),
];

/** This computer: Codex ready, Traycer turned off, so it lists no Traycer model. */
function installHostWithTraycerOff(): void {
  const entries: ReadonlyArray<{
    readonly option: HarnessOption;
    readonly models: ReadonlyArray<ModelOption>;
  }> = [
    {
      option: harnessOption("codex", "Codex", true),
      models: [model("codex", "codex-main", "codex-main")],
    },
    { option: harnessOption("traycer", "Traycer", false), models: [] },
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

function renderPicker(): ComposerToolbarStore {
  const store = createComposerToolbarStore({
    purpose: "run",
    reasoningFallback: "model-default",
    seedKey: "sandbox-traycer-test",
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
          registerActivation
          createProfileHostId={null}
          runTargetHostId={null}
          profileAdmission={null}
          terminalLoginSurface={null}
          embedding={null}
        />
      </TooltipProvider>
    </SurfaceActivityProvider>,
  );
  return store;
}

/** What a sandbox refusal's "Choose a model" does. */
async function openOnSandboxAgents(): Promise<void> {
  act(() => {
    expect(openActiveModelPickerForHarness("traycer", null, ["traycer"])).toBe(
      true,
    );
  });
  await screen.findByRole("textbox", { name: /^Search/ });
}

describe("a sandbox refusal's model picker on a host with Traycer off", () => {
  beforeEach(() => {
    installHostWithTraycerOff();
    mocks.hostModelReads.clear();
    mocks.cloud.data = CLOUD_MODELS;
    mocks.cloud.isPending = false;
    mocks.cloud.error = null;
    mocks.cloud.enabled = [];
    useComposerHarnessMemoryStore.getState().resetForTests();
  });
  afterEach(() => {
    cleanup();
    resetActiveModelPickerForTests();
    resetPaneActivationFocusIntentsForTests();
    useComposerHarnessMemoryStore.getState().resetForTests();
  });

  it("lists the cloud catalog's Traycer models, and choosing one picks Traycer and that model", async () => {
    const store = renderPicker();
    await openOnSandboxAgents();

    expect(mocks.cloud.enabled.at(-1)).toBe(true);
    expect(
      screen.getAllByRole("option").map((option) => option.textContent),
    ).toEqual([
      expect.stringContaining("Claude Sonnet 5.5"),
      expect.stringContaining("GPT 6.1"),
    ]);
    expect(mocks.hostModelReads.has("traycer")).toBe(false);

    fireEvent.click(screen.getByRole("option", { name: /GPT 6\.1/ }));

    expect(store.getState().selection).toMatchObject({
      harnessId: "traycer",
      modelSlug: "traycer:gpt-6-1",
    });
  });

  it("shows the picker's own loading line while the catalog is read", async () => {
    mocks.cloud.data = undefined;
    mocks.cloud.isPending = true;
    renderPicker();
    await openOnSandboxAgents();

    expect(screen.getByText("Loading models")).toBeTruthy();
    expect(screen.queryByRole("option", { name: /Claude Sonnet/ })).toBeNull();
  });

  it("shows the picker's own failure line when the catalog read fails", async () => {
    mocks.cloud.data = undefined;
    mocks.cloud.error = new Error("Couldn't reach Traycer.");
    renderPicker();
    await openOnSandboxAgents();

    expect(screen.getByText("Couldn't reach Traycer.")).toBeTruthy();
    expect(screen.queryByRole("option", { name: /Claude Sonnet/ })).toBeNull();
  });

  it("reads no cloud catalog for a picker opened on this computer's own agents", async () => {
    renderPicker();
    fireEvent.click(screen.getByRole("button", { name: /^codex-main/ }));
    await screen.findByRole("textbox", { name: /^Search/ });

    expect(mocks.cloud.enabled).not.toContain(true);
  });
});

const SANDBOX_HOST_ID = "sbx-t1-host";
const STAGED_SURFACE = "landing:window-1";
const STAGED_TARGET: StagedSandboxTarget = {
  kind: "new",
  configuration: { kind: "personal" },
  shape: {
    os: "linux",
    cpus: 2,
    memoryMb: 8192,
    diskMb: null,
    region: "us-east",
    idleMinutes: 30,
    destroyAfterRestingMinutes: null,
  },
  name: "",
  wakeString: null,
};

/** The person's Traycer pick, as the composer is seeded with it. */
const TRAYCER_PICK = {
  ultracode: false,
  harnessId: "traycer",
  model: "traycer:claude-sonnet-5-5",
  permissionMode: "supervised",
  reasoningEffort: null,
  serviceTier: null,
  agentMode: "regular",
  profileId: null,
} as const;

/**
 * A composer's own toolbar store, fed by the real hook, under the real picker:
 * the send runs on a sandbox that either is staged on this surface or rests
 * under this chat.
 */
function SandboxComposerPicker(props: {
  readonly hostId: string;
  readonly target: "staged" | "resting";
}): ReactNode {
  const store = useComposerToolbarStore(
    null,
    fallbackSeedSource(TRAYCER_PICK, null),
    null,
    {
      hostClient: null,
      hostId: props.hostId,
      tuiOnly: false,
      chatLineCarriesAutoMode: null,
      ultracodeCarried: false,
      stagedSurfaceKey: props.target === "staged" ? STAGED_SURFACE : null,
      sendsToRestingSandbox: props.target === "resting",
    },
  );
  return (
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
      registerActivation
      createProfileHostId={null}
      runTargetHostId={props.hostId}
      profileAdmission={null}
      terminalLoginSurface={null}
      embedding={null}
    />
  );
}

function renderSandboxComposerPicker(
  hostId: string,
  target: "staged" | "resting",
): void {
  render(
    <SurfaceActivityProvider active>
      <TooltipProvider delayDuration={0}>
        <SandboxComposerPicker hostId={hostId} target={target} />
      </TooltipProvider>
    </SurfaceActivityProvider>,
  );
}

describe("a Traycer pick sent to a sandbox, labelled and listed from the cloud catalog", () => {
  beforeEach(() => {
    installHostWithTraycerOff();
    mocks.hostModelReads.clear();
    mocks.hostModelsRefused = new Set(["traycer"]);
    mocks.unreachableHosts = new Set();
    mocks.cloud.data = CLOUD_MODELS;
    mocks.cloud.isPending = false;
    mocks.cloud.error = null;
    mocks.cloud.enabled = [];
    useStagedSandboxStore.setState({ bySurface: {} });
    useComposerHarnessMemoryStore.getState().resetForTests();
  });
  afterEach(() => {
    cleanup();
    mocks.hostModelsRefused = new Set();
    mocks.unreachableHosts = new Set();
    useStagedSandboxStore.setState({ bySurface: {} });
    resetActiveModelPickerForTests();
    resetPaneActivationFocusIntentsForTests();
    useComposerHarnessMemoryStore.getState().resetForTests();
  });

  // OBS 10: the Start page with a sandbox staged, on a host with Traycer off.
  it("names a staged sandbox's Traycer model on the chip while the picker host refuses Traycer", async () => {
    useStagedSandboxStore.getState().stage(STAGED_SURFACE, STAGED_TARGET);

    renderSandboxComposerPicker(HOST_ID, "staged");

    expect(
      await screen.findByRole("button", { name: /^Claude Sonnet 5\.5/ }),
    ).toBeTruthy();
    expect(screen.queryByText("Select model")).toBeNull();
    expect(mocks.hostModelReads.has("traycer")).toBe(false);
  });

  it("offers only the agents a staged sandbox's catalogue names, never Traycer when it leaves Traycer out", async () => {
    useStagedSandboxStore.getState().stage(STAGED_SURFACE, STAGED_TARGET);
    renderSandboxComposerPicker(HOST_ID, "staged");

    // What a refusal's "Choose a model" does for a catalogue of Codex alone:
    // it opens on Traycer, narrowed to the catalogue's list.
    act(() => {
      expect(openActiveModelPickerForHarness("traycer", null, ["codex"])).toBe(
        true,
      );
    });
    await screen.findByRole("textbox", { name: /^Search/ });

    expect(
      screen.getAllByRole("option").map((option) => option.textContent),
    ).toEqual([expect.stringContaining("codex-main")]);
  });

  it("names a resting chat's Traycer model, and lists the cloud's rows rather than calling the sandbox offline", async () => {
    mocks.unreachableHosts = new Set([SANDBOX_HOST_ID]);

    renderSandboxComposerPicker(SANDBOX_HOST_ID, "resting");

    fireEvent.click(
      await screen.findByRole("button", { name: /^Claude Sonnet 5\.5/ }),
    );
    await screen.findByRole("textbox", { name: /^Search/ });

    expect(screen.queryByText(`${SANDBOX_HOST_ID} is offline`)).toBeNull();
    expect(
      screen.getAllByRole("option").map((option) => option.textContent),
    ).toEqual([
      expect.stringContaining("Claude Sonnet 5.5"),
      expect.stringContaining("GPT 6.1"),
    ]);
  });

  it("waits on the cloud's rows for a resting chat, never calling the sandbox offline", async () => {
    mocks.unreachableHosts = new Set([SANDBOX_HOST_ID]);
    mocks.cloud.data = undefined;
    mocks.cloud.isPending = true;

    renderSandboxComposerPicker(SANDBOX_HOST_ID, "resting");
    act(() => {
      expect(openActiveModelPickerForHarness("traycer", null, null)).toBe(true);
    });
    await screen.findByRole("textbox", { name: /^Search/ });

    expect(screen.getByText("Loading models")).toBeTruthy();
    expect(screen.queryByText(`${SANDBOX_HOST_ID} is offline`)).toBeNull();
  });
});
