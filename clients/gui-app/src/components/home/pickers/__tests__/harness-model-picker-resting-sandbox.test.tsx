/**
 * A sandbox at rest answers nothing, so its composer's model picker lists the
 * cloud's Traycer models and keeps the person's pick, and offers Resume or
 * Start when no list is known. This renders the real `HarnessModelPicker`
 * under the real `useComposerToolbarStore`, with only the external boundaries
 * faked: the host's harness reads, the person's host directory, and the
 * window's `AuthService` (the sandbox list, the cloud's Traycer list and the
 * lifecycle verb).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Fragment, useEffect, type Key, type ReactNode } from "react";
import type {
  HarnessOption,
  ModelOption,
} from "@/components/home/data/landing-options";
import type { GuiAgentModelOption } from "@traycer/protocol/host/agent/gui/unary-schemas";
import type { HostListItem } from "@traycer/protocol/host/host-status";
import { ALL_PERMISSION_MODES } from "@traycer/protocol/persistence/epic/foundation";
import { resetPaneActivationFocusIntentsForTests } from "@/components/epic-canvas/pane-activation";
import { sandboxSummaryFixture } from "@/hooks/sandboxes/__tests__/sandbox-fixtures";
import {
  createRestingBinding,
  restingDirectory,
  type RestingBinding,
} from "@/hooks/sandboxes/__tests__/resting-directory-fixture";
import { sandboxMutationKeys } from "@/lib/query-keys";

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
  /** The picker host's harness read ends in this error, when set. */
  harnessesError: null as Error | null,
  /** Hosts the directory reads as unreachable. */
  unreachableHosts: new Set<string>(),
  binding: null as RestingBinding | null,
}));

vi.mock(
  "@traycer-clients/shared/host-client/host-connection-registry",
  async (importOriginal) => {
    const { restingDirectory: directory } =
      await import("@/hooks/sandboxes/__tests__/resting-directory-fixture");
    return {
      ...(await importOriginal<
        typeof import("@traycer-clients/shared/host-client/host-connection-registry")
      >()),
      readHostDirectoryEntry: directory.read,
      subscribeHostRowChanged: directory.subscribe,
    };
  },
);

vi.mock("@/lib/host", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/host")>()),
  useHostBinding: () => mocks.binding,
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
  ) => ({
    data: client !== null && activity.enabled ? { providers: [] } : undefined,
    isPending: client === null,
    isError: false,
    error: null,
    isFetching: false,
  }),
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
      data:
        activity.enabled && mocks.harnessesError === null
          ? { harnesses: mocks.harnesses }
          : undefined,
      isPending: false,
      isError: mocks.harnessesError !== null,
      error: mocks.harnessesError,
    };
  },
  useGuiHarnessModelsQueryForClient: (
    client: MockHostClient | null,
    harnessId: string,
    _workingDirectory: string | null,
    activity: QueryActivity,
  ) => ({
    data:
      client !== null && activity.enabled
        ? { harnessId, models: mocks.modelsByHarness.get(harnessId) ?? [] }
        : undefined,
    isPending: client === null,
    isError: false,
    error: null,
    refetch: () => Promise.resolve({ data: undefined }),
  }),
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
  ) => ({
    harnesses:
      client !== null && activity.enabled ? mocks.catalogHarnesses : [],
    harnessesLoading: false,
    harnessesError: client === null ? null : mocks.harnessesError,
    modelsLoading: false,
  }),
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
  chipModelName,
  type ComposerToolbarStore,
} from "@/stores/composer/composer-toolbar-store";
import { useComposerHarnessMemoryStore } from "@/stores/composer/composer-harness-memory-store";
import { useAuthStore } from "@/stores/auth/auth-store";
import {
  openActiveModelPickerForHarness,
  resetActiveModelPickerForTests,
} from "@/lib/commands/active-model-picker-registry";
import { TooltipProvider } from "@/components/ui/tooltip";

const HOST_ID = "host-a";
// Fresh per test: a wake in flight is shared by host across tests.
let SANDBOX_HOST_ID = "sbx-rest-host-0";
let sandboxCount = 0;
const SANDBOX_ID = "sbx_rest";
const SANDBOX_NAME = "build-box";
const STAGED_SURFACE = "landing:window-1";

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

function modelFields(slug: string, label: string) {
  return {
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

function hostModel(
  harnessId: HarnessOption["id"],
  slug: string,
  label: string,
): ModelOption {
  return { harnessId, ...modelFields(slug, label) };
}

function cloudModel(slug: string, label: string): GuiAgentModelOption {
  return { harnessId: "traycer", ...modelFields(slug, label) };
}

const CLOUD_MODELS: ReadonlyArray<GuiAgentModelOption> = [
  cloudModel("traycer:claude-sonnet-5-5", "Claude Sonnet 5.5"),
  cloudModel("traycer:gpt-6-1", "GPT 6.1"),
];

const LISTED_PICK = "traycer:claude-sonnet-5-5";
const UNLISTED_PICK = "traycer:retired-model";

/** The picker host: Codex ready and no Traycer row at all. */
function installHostWithoutTraycer(): void {
  const option = harnessOption("codex", "Codex", true);
  const models = [hostModel("codex", "codex-main", "codex-main")];
  mocks.harnesses = [option];
  mocks.catalogHarnesses = [
    { ...option, models, modelsLoading: false, modelsError: null },
  ];
  mocks.modelsByHarness = new Map([["codex", models]]);
}

function stagedTarget(verb: "resume" | "start"): StagedSandboxTarget {
  return {
    kind: "existing",
    hostId: SANDBOX_HOST_ID,
    sandboxId: SANDBOX_ID,
    name: SANDBOX_NAME,
    configuration: { kind: "personal" },
    verb,
  };
}

function traycerPick(model: string) {
  return {
    ultracode: false,
    harnessId: "traycer",
    model,
    permissionMode: "supervised",
    reasoningEffort: null,
    serviceTier: null,
    agentMode: "regular",
    profileId: null,
  } as const;
}

interface SurfaceInput {
  /** The composer's own host: the tab's, or the sandbox itself. */
  readonly hostId: string;
  readonly staged: boolean;
  /** A bound chat's resting sandbox, as `ChatComposer` passes it. */
  readonly boundResting: boolean;
  readonly tuiOnly: boolean;
  readonly pick: string;
}

const DEFAULT_SURFACE: SurfaceInput = {
  hostId: HOST_ID,
  staged: false,
  boundResting: false,
  tuiOnly: false,
  pick: LISTED_PICK,
};

let toolbar: ComposerToolbarStore | null = null;

/** The real toolbar store under the real picker, on a sandbox's run target. */
function SurfacePicker(props: SurfaceInput & { readonly runHost: string }) {
  const store = useComposerToolbarStore(
    null,
    fallbackSeedSource(traycerPick(props.pick), null),
    null,
    {
      hostClient: null,
      hostId: props.hostId,
      tuiOnly: props.tuiOnly,
      chatLineCarriesAutoMode: null,
      ultracodeCarried: false,
      stagedSurfaceKey: props.staged ? STAGED_SURFACE : null,
      restingSandbox: props.boundResting
        ? { hostId: SANDBOX_HOST_ID, name: SANDBOX_NAME, verb: "resume" }
        : null,
    },
  );
  useEffect(() => {
    toolbar = store;
  }, [store]);
  return (
    <HarnessModelPicker
      withUltracode={false}
      labelDisplay="responsive"
      store={store}
      maxModeContext={{ kind: "none" }}
      withServiceTier={false}
      withReasoning
      tuiOnly={props.tuiOnly}
      lockedHarnessId={null}
      disabled={false}
      registerActivation
      createProfileHostId={null}
      runTargetHostId={props.runHost}
      profileAdmission={null}
      terminalLoginSurface={null}
      embedding={null}
    />
  );
}

let queryClient: QueryClient;

function renderSurface(input: Partial<SurfaceInput>): ComposerToolbarStore {
  const surface = { ...DEFAULT_SURFACE, ...input };
  render(
    <QueryClientProvider client={queryClient}>
      <SurfaceActivityProvider active>
        <TooltipProvider delayDuration={0}>
          <SurfacePicker
            {...surface}
            runHost={surface.staged ? SANDBOX_HOST_ID : surface.hostId}
          />
        </TooltipProvider>
      </SurfaceActivityProvider>
    </QueryClientProvider>,
  );
  if (toolbar === null) throw new Error("the surface mounted no toolbar");
  return toolbar;
}

async function openPicker(): Promise<void> {
  act(() => {
    expect(openActiveModelPickerForHarness("traycer", null, null)).toBe(true);
  });
  await screen.findByRole("textbox", { name: /^Search/ });
}

function optionTexts(): ReadonlyArray<string | null> {
  return screen.getAllByRole("option").map((option) => option.textContent);
}

function listSandboxRow(state: "suspended" | "stopped") {
  mocks.binding?.auth.listSandboxes.mockImplementation(() =>
    Promise.resolve({
      kind: "ok",
      response: {
        sandboxes: [
          sandboxSummaryFixture({
            id: SANDBOX_ID,
            hostId: SANDBOX_HOST_ID,
            displayName: SANDBOX_NAME,
            state,
          }),
        ],
      },
    }),
  );
}

function rest(state: NonNullable<HostListItem["sandboxState"]>): void {
  restingDirectory.setSandbox(SANDBOX_HOST_ID, SANDBOX_NAME, state);
}

/** The cloud's Traycer list cannot be read. */
function cloudListUnavailable(): void {
  mocks.binding?.auth.getTraycerModels.mockImplementation(() =>
    Promise.resolve({
      kind: "network-error",
      detail: "the cloud could not be reached",
    }),
  );
}

beforeEach(() => {
  sandboxCount += 1;
  SANDBOX_HOST_ID = `sbx-rest-host-${sandboxCount}`;
  installHostWithoutTraycer();
  mocks.harnessesError = null;
  mocks.unreachableHosts = new Set([SANDBOX_HOST_ID]);
  mocks.binding = createRestingBinding(CLOUD_MODELS);
  restingDirectory.clear();
  queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  useAuthStore.setState({
    status: "signed-in",
    contextMetadata: { userId: "u1", username: "ada" },
  });
  useStagedSandboxStore.setState({ bySurface: {} });
  useComposerHarnessMemoryStore.getState().resetForTests();
  toolbar = null;
});

afterEach(() => {
  cleanup();
  queryClient.clear();
  restingDirectory.clear();
  useAuthStore.setState({ status: "signed-out", contextMetadata: null });
  useStagedSandboxStore.setState({ bySurface: {} });
  resetActiveModelPickerForTests();
  resetPaneActivationFocusIntentsForTests();
  useComposerHarnessMemoryStore.getState().resetForTests();
});

describe("the model picker of a resting sandbox that lists the cloud's models", () => {
  it("lists the cloud's rows with Traycer on the rail, keeps the pick on the chip, and commits a chosen row", async () => {
    rest("suspended");
    listSandboxRow("suspended");
    useStagedSandboxStore
      .getState()
      .stage(STAGED_SURFACE, stagedTarget("resume"));
    const store = renderSurface({ staged: true });

    await openPicker();
    await waitFor(() => expect(optionTexts()).toHaveLength(2));

    expect(store.getState().sandboxRunTarget).toBe("staged");
    expect(store.getState().restingRunHost).toMatchObject({
      hostId: SANDBOX_HOST_ID,
      verb: "resume",
    });
    expect(screen.getByRole("tab", { name: "Traycer" })).toBeTruthy();
    expect(optionTexts()).toEqual([
      expect.stringContaining("Claude Sonnet 5.5"),
      expect.stringContaining("GPT 6.1"),
    ]);
    expect(screen.queryByText(`${SANDBOX_HOST_ID} is offline`)).toBeNull();
    expect(screen.queryByText("Couldn't load providers")).toBeNull();
    expect(store.getState().selection).toMatchObject({
      harnessId: "traycer",
      modelSlug: LISTED_PICK,
    });
    expect(chipModelName(store.getState())).toBe("Claude Sonnet 5.5");

    fireEvent.click(screen.getByRole("option", { name: /GPT 6\.1/ }));

    expect(store.getState().selection).toMatchObject({
      harnessId: "traycer",
      modelSlug: "traycer:gpt-6-1",
    });
  });

  it("lists the cloud's rows for a composer whose own host rests with no stage, as a fork does", async () => {
    rest("suspended");
    const store = renderSurface({ hostId: SANDBOX_HOST_ID });

    await openPicker();
    await waitFor(() => expect(optionTexts()).toHaveLength(2));

    expect(store.getState().sandboxRunTarget).toBe("resting");
    expect(store.getState().restingRunHost).toMatchObject({
      hostId: SANDBOX_HOST_ID,
      name: SANDBOX_NAME,
    });
    expect(screen.queryByText(`${SANDBOX_HOST_ID} is offline`)).toBeNull();
  });

  it("holds a bound chat's unlisted slug in the selection, and a generic name on the chip, while the host's harness read is rejected", async () => {
    mocks.harnessesError = new Error("harnesses refused");
    const store = renderSurface({ boundResting: true, pick: UNLISTED_PICK });

    await openPicker();
    await waitFor(() => expect(optionTexts()).toHaveLength(2));

    expect(store.getState().sandboxRunTarget).toBe("resting");
    expect(screen.queryByText("Couldn't load providers")).toBeNull();
    expect(screen.queryByText(`${SANDBOX_HOST_ID} is offline`)).toBeNull();
    expect(store.getState().selection).toMatchObject({
      harnessId: "traycer",
      modelSlug: UNLISTED_PICK,
    });
    // No list ever named the slug on this device, so the chip never shows it.
    expect(chipModelName(store.getState())).toBe("Traycer model");
  });

  it("keeps the rows when a later cloud read fails with the list held", async () => {
    rest("suspended");
    const store = renderSurface({ hostId: SANDBOX_HOST_ID });
    await openPicker();
    await waitFor(() => expect(optionTexts()).toHaveLength(2));

    mocks.binding?.auth.getTraycerModels.mockImplementation(() =>
      Promise.resolve({ kind: "network-error", detail: "offline" }),
    );
    await act(() => queryClient.refetchQueries());

    expect(optionTexts()).toHaveLength(2);
    expect(
      screen.queryByText(`Resume ${SANDBOX_NAME} to choose a model.`),
    ).toBe(null);
    expect(store.getState().selection.modelSlug).toBe(LISTED_PICK);
  });
});

describe("the model picker of a resting sandbox with no list known", () => {
  it.each([
    { state: "suspended", verb: "resume", button: "Resume" },
    { state: "stopped", verb: "start", button: "Start" },
  ] as const)(
    "reads the $button line and wakes the sandbox with the $verb verb, pending while it runs",
    async ({ state, verb, button }) => {
      rest(state);
      listSandboxRow(state);
      cloudListUnavailable();
      const verbRequest = new Promise<never>(() => undefined);
      mocks.binding?.auth.runSandboxVerb.mockImplementation(() => verbRequest);
      renderSurface({ hostId: SANDBOX_HOST_ID });

      await openPicker();

      expect(
        await screen.findByText(`${button} ${SANDBOX_NAME} to choose a model.`),
      ).toBeTruthy();
      expect(screen.queryByText(`${SANDBOX_HOST_ID} is offline`)).toBeNull();
      expect(screen.queryByText("Couldn't load providers")).toBeNull();
      expect(screen.queryByText(/is offline/)).toBeNull();
      const wake = screen.getByRole("button", { name: button });
      expect(wake).toHaveProperty("disabled", false);

      fireEvent.click(wake);

      await waitFor(() =>
        expect(mocks.binding?.auth.runSandboxVerb).toHaveBeenCalledTimes(1),
      );
      expect(
        mocks.binding?.auth.runSandboxVerb.mock.calls[0].slice(0, 2),
      ).toEqual([SANDBOX_ID, verb]);
      expect(
        queryClient.isMutating({
          mutationKey: sandboxMutationKeys.wake(SANDBOX_HOST_ID),
        }),
      ).toBe(1);
      await waitFor(() =>
        expect(screen.getByRole("button", { name: button })).toHaveProperty(
          "disabled",
          true,
        ),
      );
    },
  );

  it("reads the Resume line, not an offline host, for a staged sandbox the host cannot answer for", async () => {
    rest("suspended");
    listSandboxRow("suspended");
    cloudListUnavailable();
    useStagedSandboxStore
      .getState()
      .stage(STAGED_SURFACE, stagedTarget("resume"));
    renderSurface({ staged: true });

    await openPicker();

    expect(
      await screen.findByText(`Resume ${SANDBOX_NAME} to choose a model.`),
    ).toBeTruthy();
    expect(screen.queryByText(/is offline/)).toBeNull();
    expect(screen.queryByText("Couldn't load providers")).toBeNull();
  });

  it("shows the Resume line for a terminal picker, which lists no Traycer, and adds no Traycer to its rail", async () => {
    rest("suspended");
    renderSurface({ hostId: SANDBOX_HOST_ID, tuiOnly: true });

    await openPicker();

    expect(
      await screen.findByText(`Resume ${SANDBOX_NAME} to choose a model.`),
    ).toBeTruthy();
    expect(screen.queryByRole("tab", { name: "Traycer" })).toBeNull();
  });
});

describe("the model picker of a host that is not at rest", () => {
  it("still names an unreachable host offline", async () => {
    mocks.unreachableHosts = new Set([HOST_ID]);
    mocks.harnesses = [];
    mocks.catalogHarnesses = [];
    const store = renderSurface({ hostId: HOST_ID, pick: UNLISTED_PICK });

    expect(store.getState().sandboxRunTarget).toBeNull();
    expect(store.getState().restingRunHost).toBeNull();
    await openPicker();

    expect(await screen.findByText(`${HOST_ID} is offline`)).toBeTruthy();
  });

  it("still says it couldn't load providers when the reachable host's read fails", async () => {
    mocks.unreachableHosts = new Set();
    mocks.harnessesError = new Error("harnesses refused");
    // An awake sandbox is no resting run target either.
    restingDirectory.setSandbox(HOST_ID, "up-box", "awake");
    const store = renderSurface({ hostId: HOST_ID });
    expect(store.getState().sandboxRunTarget).toBeNull();

    await openPicker();

    expect(await screen.findByText("Couldn't load providers")).toBeTruthy();
    expect(screen.queryByText(/to choose a model\./)).toBeNull();
  });
});
