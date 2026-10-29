import type { SandboxVerbOutcome } from "@/hooks/sandboxes/use-sandbox-verb-mutation";
import type { SandboxLifecycleVerb } from "@traycer/protocol/host/sandbox-control";
import { sandboxMutationKeys } from "@/lib/query-keys";
import { useAuthStore } from "@/stores/auth/auth-store";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  onTestFinished,
  vi,
} from "vitest";
import { useEffect } from "react";
import {
  QueryClient,
  QueryClientProvider,
  useMutation,
} from "@tanstack/react-query";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import type { AuthenticatedUser } from "@traycer/protocol/auth";
import {
  SANDBOX_REFUSAL_CODE_INSUFFICIENT_CREDIT,
  type SandboxCatalogue,
  type SandboxCreateRequest,
  type SandboxSummary,
  type SandboxVerbGesture,
} from "@traycer/protocol/host/sandbox-control";
import { hostQueryKeys } from "@/lib/query-keys";
import type { HostRpcRegistry } from "@/lib/host";
import { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import type { HostDirectoryEntry } from "@traycer-clients/shared/host-client/host-directory";
import type {
  SandboxCreateFetchResult,
  SandboxListFetchResult,
} from "@traycer-clients/shared/host-client/sandbox-control";
import type { SandboxWakeOutcome } from "@traycer-clients/shared/host-client/sandbox-control";
import type { TerminalLaunchTarget } from "@/components/epic-canvas/sidebar/new-terminal-tile-ref";
import {
  openLandingStagedTerminal,
  startStagedTerminal,
  useStagedSandboxHandoff,
  useStagedSandboxRunner,
  useStagedSandboxSend,
  stagedSandboxFallbackName,
  type StagedResubmit,
  type StagedSandboxRunner,
  type StagedSandboxSend,
} from "@/components/composer/use-staged-sandbox-send";
import {
  ownerGoneOnUnmount,
  readStagedSandbox,
  useStagedSandboxStore,
  type HandoffOwnerWatch,
  type StagedSandboxFailure,
  type StagedSandboxStep,
} from "@/stores/composer/staged-sandbox-store";
import type {
  StagedRunRequest,
  StagedSandboxRunDeps,
} from "@/lib/sandboxes/staged-sandbox-run";
import { refusal } from "@/hooks/sandboxes/__tests__/sandbox-binding-fixture";
import { sandboxSummaryFixture } from "@/hooks/sandboxes/__tests__/sandbox-fixtures";
import { useSurfaceHostSelectionStore } from "@/stores/host/surface-host-selection-store";
import { useLandingPanelStore } from "@/stores/home/landing-panel-store";
import {
  userSubscription,
  userWith,
} from "@/lib/sandboxes/__tests__/auth-user-fixture";
import { notEnoughCreditsLine } from "@/lib/sandboxes/sandbox-strings";
import {
  recordNegotiatedHostManifest,
  resetNegotiatedManifests,
} from "@traycer-clients/shared/host-transport/negotiated-manifest-registry";

const mocks = vi.hoisted(() => ({
  runVerb: vi.fn<(verb: SandboxLifecycleVerb) => Promise<SandboxVerbOutcome>>(),
  /** The named host's environment.status answer, as its client throws or returns it. */
  environmentStatus: vi.fn<() => Promise<unknown>>(),
  /** The viewer and the catalogue the setup line's facts are read from. */
  user: null as AuthenticatedUser | null,
  catalogue: null as SandboxCatalogue | null,
  runStagedSandbox: vi.fn<
    (
      surfaceKey: string,
      fresh: boolean,
      request: StagedRunRequest,
      deps: StagedSandboxRunDeps,
    ) => Promise<void>
  >(() => Promise.resolve()),
  /** The control plane's create, for the cases that run phase 1 for real. */
  createSandbox:
    vi.fn<
      (request: SandboxCreateRequest) => Promise<SandboxCreateFetchResult>
    >(),
  /** The control plane's sandbox list, read while a create settles. */
  listSandboxes: vi.fn<() => Promise<SandboxListFetchResult>>(),
  /** The sandbox list rows the setup line prices a resting sandbox from. */
  sandboxes: null as SandboxSummary[] | null,
  /** When the listed rows answered; `0` is an answer older than any verb. */
  sandboxesAt: 0,
  /** The account's host directory, which names the new host once it dials. */
  findById: vi.fn<(hostId: string) => HostDirectoryEntry | null>(),
  repairHostIds: [] as string[],
  retrySupported: true,
  legacySupported: false,
  legacyHostIds: [] as string[],
  legacyMutate: vi.fn(),
  repairMutate: vi.fn(
    (
      _variables: object,
      options: {
        readonly onSuccess: (outcome: {
          readonly guestConfigured: boolean;
          readonly settingsApplied: boolean;
        }) => void;
      },
    ) => {
      options.onSuccess({ guestConfigured: true, settingsApplied: true });
    },
  ),
  startSandboxWake: vi.fn<
    (
      client: QueryClient,
      binding: unknown,
      hostId: string,
      gesture: SandboxVerbGesture | null,
    ) => Promise<SandboxWakeOutcome | null>
  >(() => Promise.resolve({ kind: "failed", detail: "Test wake stopped" })),
}));

vi.mock("@/lib/host/binding-host-client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/host/binding-host-client")>()),
  resolveNamedHostClient: () => ({
    request: (method: string) =>
      method === "environment.status"
        ? mocks.environmentStatus()
        : Promise.reject(new Error(`unexpected ${method}`)),
  }),
}));
vi.mock("@/lib/sandboxes/staged-sandbox-run", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/lib/sandboxes/staged-sandbox-run")
  >()),
  runStagedSandbox: mocks.runStagedSandbox,
}));
vi.mock("@/lib/sandboxes/sandbox-wake", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/sandboxes/sandbox-wake")>()),
  startSandboxWake: mocks.startSandboxWake,
}));
vi.mock(
  "@/hooks/sandboxes/use-sandbox-repair-guest-configuration-mutation",
  () => ({
    useSandboxRepairGuestConfigurationOnHost: (hostId: string) => {
      mocks.repairHostIds.push(hostId);
      return { mutate: mocks.repairMutate };
    },
    useSandboxRetryApplyingSupported: () => mocks.retrySupported,
    useSandboxGuestSetupRepairSupported: () => mocks.legacySupported,
    useSandboxRepairGuestSetupOnHost: (hostId: string) => {
      mocks.legacyHostIds.push(hostId);
      return { mutate: mocks.legacyMutate };
    },
    useSandboxSettingsOperation: () => null,
  }),
);
// The new host answers with its default cwd as soon as it is named.
vi.mock(
  "@/components/epic-canvas/sidebar/use-folderless-terminal-target",
  () => ({
    useFolderlessTerminalTarget: (_epicId: string, hostId: string | null) =>
      hostId === null ? null : { hostId, cwd: "/home/sandbox" },
  }),
);
vi.mock("@/lib/host", () => ({
  useHostBinding: () => ({
    auth: {
      createSandbox: mocks.createSandbox,
      listSandboxes: mocks.listSandboxes,
    },
    directory: { refresh: () => Promise.resolve(), findById: mocks.findById },
  }),
}));
vi.mock("@/hooks/auth/use-auth-user-query", () => ({
  useAuthUser: () => ({ data: mocks.user }),
}));
vi.mock("@/hooks/sandboxes/use-sandbox-catalogue-query", () => ({
  useSandboxCatalogue: () => ({ data: mocks.catalogue }),
}));
// The list the setup line prices a resting sandbox from: the real query unless
// a case names the rows, so the cases that run a create keep the reads it makes.
vi.mock("@/hooks/sandboxes/use-sandbox-list-query", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("@/hooks/sandboxes/use-sandbox-list-query")
    >();
  return {
    ...actual,
    useSandboxList: (...args: Parameters<typeof actual.useSandboxList>) =>
      mocks.sandboxes === null
        ? actual.useSandboxList(...args)
        : {
            data: { sandboxes: mocks.sandboxes },
            dataUpdatedAt: mocks.sandboxesAt,
          },
  };
});
vi.mock("@/hooks/sandboxes/use-sandbox-verb-mutation", () => ({
  useSandboxVerb: (sandboxId: string) =>
    useMutation({
      mutationKey: sandboxMutationKeys.verb(sandboxId),
      mutationFn: mocks.runVerb,
      onMutate: () => ({
        userId: useAuthStore.getState().contextMetadata?.userId ?? null,
      }),
    }),
}));
vi.mock("@/hooks/sandboxes/use-configuration-billing-url", () => ({
  useConfigurationBillingUrl: () => "https://example.test/billing",
}));
vi.mock("@/lib/links/open-link", () => ({
  useOpenLink: () => vi.fn(),
}));

/** A listed 1 vCPU · 1 GB rung at $0.12 an hour under the staged 2 vCPU · 4 GB. */
const LADDER: SandboxCatalogue = {
  providers: [
    {
      provider: "tensorlake",
      os: ["linux"],
      shape: {
        cpuMin: 1,
        cpuMax: 16,
        cpuStep: 1,
        memoryPerCpuMinMb: 1024,
        memoryPerCpuMaxMb: 8192,
        memoryMinMb: 1024,
        memoryMaxMb: 65536,
        memoryStepMb: 512,
        diskMinMb: 10240,
        diskMaxMb: 102400,
        diskDefaultMb: 20480,
      },
      suspendFidelity: "memory",
      stoppedStorage: "snapshot",
      wakeClass: "resume",
      shapes: [
        { cpus: 1, memoryMb: 1024, diskMb: 10_240, default: false },
        { cpus: 2, memoryMb: 4096, diskMb: 20_480, default: true },
      ],
      dockerInGuest: true,
      creatable: true,
      notCreatableReason: null,
      regions: [
        {
          id: "us-east",
          label: "US East",
          fromPriceMcPerHour: {
            awakeMc: 120,
            suspendedMc: 4,
            stoppedMc: 2,
          },
          pricing: null,
        },
      ],
    },
  ],
};

const SURFACE = "tab:epic-1";
const NEW_HOST = "sbx-host";

// A stable callback, as the surfaces pass one.
const noPrepare = (): void => undefined;

function stageCreated(
  step: StagedSandboxStep,
  failure: StagedSandboxFailure | null,
): void {
  const store = useStagedSandboxStore.getState();
  store.stage(SURFACE, {
    kind: "new",
    configuration: { kind: "personal" },
    shape: {
      os: "linux",
      cpus: 2,
      memoryMb: 4096,
      diskMb: null,
      region: "us-east",
      idleMinutes: 30,
      destroyAfterRestingMinutes: 10_080,
    },
    name: "api-refactor",
    wakeString: null,
  });
  store.begin(SURFACE, false, Date.now(), false);
  store.report(SURFACE, {
    createdSandboxId: "sbx-1",
    createdHostId: NEW_HOST,
    step,
    stepAt: Date.now(),
    failure,
  });
}

/**
 * A settings failure is reported only after the run's own read saw the new
 * row awake, and that read fills the list every surface reads.
 */
function listCreatedAwake(): void {
  mocks.sandboxes = [
    sandboxSummaryFixture({ id: "sbx-1", hostId: NEW_HOST, state: "awake" }),
  ];
}

function Harness(props: {
  readonly openTerminal: (target: TerminalLaunchTarget) => void;
}) {
  const send = useStagedSandboxSend({
    surfaceKey: SURFACE,
    terminal: { epicId: "epic-1", open: props.openTerminal },
    taskId: "epic-1",
    ownerId: null,
    claimsSend: false,
  });
  const runner = useStagedSandboxRunner();
  useEffect(() => {
    latestSend = send;
  }, [send]);
  useEffect(() => {
    latestRunner = runner;
  }, [runner]);
  return <>{send.line}</>;
}

let latestSend: StagedSandboxSend | null = null;
let latestRunner: StagedSandboxRunner | null = null;

function mount(openTerminal: (target: TerminalLaunchTarget) => void): void {
  render(
    <QueryClientProvider client={new QueryClient()}>
      <Harness openTerminal={openTerminal} />
    </QueryClientProvider>,
  );
}

function unsupportedEnvironmentStatus(): HostRpcError {
  return new HostRpcError({
    code: "E_HOST_UNSUPPORTED",
    message: "Unsupported.",
    requestId: "request-1",
    method: "environment.status",
    fatalDetails: null,
  });
}

beforeEach(() => {
  mocks.runVerb.mockReset();
  mocks.runVerb.mockResolvedValue({ kind: "settled", state: "stopped" });
  // The host named by the run answers environment.status as an older build does.
  mocks.environmentStatus.mockReset();
  mocks.environmentStatus.mockRejectedValue(unsupportedEnvironmentStatus());
  // The new host is a known older build with no environment.status; an unrecorded
  // manifest would hold a real staged run's handoff.
  resetNegotiatedManifests();
  recordNegotiatedHostManifest(NEW_HOST, {
    "epic.createChat": { major: 1, minor: 2 },
  });
  mocks.user = null;
  mocks.catalogue = null;
  mocks.sandboxes = null;
  mocks.sandboxesAt = 0;
  localStorage.clear();
  useStagedSandboxStore.setState({ bySurface: {} });
  useSurfaceHostSelectionStore.setState({ selections: {} });
  mocks.runStagedSandbox.mockReset();
  mocks.runStagedSandbox.mockImplementation(() => Promise.resolve());
  mocks.createSandbox.mockReset();
  mocks.listSandboxes.mockReset();
  mocks.findById.mockReset();
  mocks.repairMutate.mockClear();
  mocks.repairHostIds.length = 0;
  mocks.retrySupported = true;
  mocks.legacySupported = false;
  mocks.legacyHostIds.length = 0;
  mocks.legacyMutate.mockReset();
  mocks.startSandboxWake.mockReset();
  mocks.startSandboxWake.mockResolvedValue({
    kind: "failed",
    detail: "Test wake stopped",
  });
});

afterEach(() => {
  cleanup();
  latestSend = null;
  latestRunner = null;
});

describe("useStagedSandboxSend's setup line", () => {
  it("opens a folderless terminal on the new host from the Booting step", () => {
    stageCreated("booting", null);
    const openTerminal = vi.fn<(target: TerminalLaunchTarget) => void>();
    mount(openTerminal);

    fireEvent.click(screen.getByTestId("sandbox-setup-line-toggle"));
    fireEvent.click(screen.getByTestId("sandbox-setup-booting-open-terminal"));

    expect(openTerminal).toHaveBeenCalledWith({
      hostId: NEW_HOST,
      cwd: "/home/sandbox",
    });
  });

  it("repairs the settings on the new host, then resumes the wait", () => {
    listCreatedAwake();
    stageCreated("applying", { kind: "settings", code: "SBX-0520" });
    mount(vi.fn());

    fireEvent.click(screen.getByTestId("sandbox-setup-retry-applying"));

    expect(mocks.repairHostIds).toContain(NEW_HOST);
    expect(mocks.repairMutate).toHaveBeenCalledTimes(1);
    expect(mocks.runStagedSandbox).toHaveBeenCalledWith(
      SURFACE,
      false,
      expect.objectContaining({ taskId: "epic-1" }),
      expect.any(Object),
    );
  });

  describe("the run's settings read", () => {
    function runDeps(): StagedSandboxRunDeps {
      listCreatedAwake();
      stageCreated("applying", { kind: "settings", code: "SBX-0520" });
      mount(vi.fn());
      fireEvent.click(screen.getByTestId("sandbox-setup-retry-applying"));
      const deps = mocks.runStagedSandbox.mock.calls.at(0)?.[3];
      if (deps === undefined) throw new Error("no run started");
      return deps;
    }

    it("never releases the send on a network failure, even with the method absent from a stale manifest", async () => {
      const deps = runDeps();
      mocks.environmentStatus.mockRejectedValue(new Error("socket closed"));

      expect(await deps.readSettings(NEW_HOST)).toBeNull();
    });

    it("does not join a status read begun on the normal key before the wake", async () => {
      const deps = runDeps();
      let releaseOld: (value: string) => void = () => undefined;
      const old = new Promise<string>((resolve) => {
        releaseOld = resolve;
      });
      const oldRead = deps.queryClient.fetchQuery({
        queryKey: hostQueryKeys.method<HostRpcRegistry, "environment.status">(
          NEW_HOST,
          "environment.status",
          {},
        ),
        queryFn: () => old,
        staleTime: 0,
      });
      mocks.environmentStatus.mockClear();
      mocks.environmentStatus.mockRejectedValue(unsupportedEnvironmentStatus());

      // The held pre-wake read does not answer for this wake's.
      expect(await deps.readSettings(NEW_HOST)).toBe("unsupported");
      expect(mocks.environmentStatus).toHaveBeenCalledTimes(1);

      releaseOld("old");
      await oldRead;
    });

    it("reads a typed unsupported-method answer as an older host, and a fresh read each time", async () => {
      const deps = runDeps();

      expect(await deps.readSettings(NEW_HOST)).toBe("unsupported");
      expect(await deps.readSettings(NEW_HOST)).toBe("unsupported");
      expect(mocks.environmentStatus).toHaveBeenCalledTimes(2);
    });
  });

  it("does not resume the wait when the guest is configured but the settings did not apply", () => {
    listCreatedAwake();
    stageCreated("applying", { kind: "settings", code: "SBX-0520" });
    mocks.repairMutate.mockImplementationOnce((_variables, options) => {
      options.onSuccess({ guestConfigured: true, settingsApplied: false });
    });
    mount(vi.fn());

    fireEvent.click(screen.getByTestId("sandbox-setup-retry-applying"));

    expect(mocks.runStagedSandbox).not.toHaveBeenCalled();
  });

  it("offers no Retry applying on a host that did not negotiate the combined retry", () => {
    mocks.retrySupported = false;
    stageCreated("applying", { kind: "settings", code: "SBX-0520" });
    listCreatedAwake();
    mount(vi.fn());

    expect(screen.queryByTestId("sandbox-setup-retry-applying")).toBeNull();
    expect(screen.getByTestId("sandbox-setup-stop")).toBeTruthy();
  });

  describe("on a host that negotiated only the guest-only repair", () => {
    function mountLegacy(guestConfigured: boolean | null): void {
      mocks.retrySupported = false;
      mocks.legacySupported = true;
      mocks.sandboxes = [
        sandboxSummaryFixture({
          id: "sbx-1",
          hostId: NEW_HOST,
          guestConfigured,
        }),
      ];
      stageCreated("applying", { kind: "settings", code: "SBX-0520" });
      mount(vi.fn());
    }

    it("offers Repair setup for a guest that really failed, on that host, and never resumes the wait", () => {
      mountLegacy(false);

      expect(screen.queryByTestId("sandbox-setup-retry-applying")).toBeNull();
      fireEvent.click(screen.getByTestId("sandbox-setup-repair-setup"));

      expect(mocks.legacyHostIds).toContain(NEW_HOST);
      expect(mocks.legacyMutate).toHaveBeenCalledTimes(1);
      expect(mocks.repairMutate).not.toHaveBeenCalled();
      expect(mocks.runStagedSandbox).not.toHaveBeenCalled();
    });

    it.each([
      ["a configured guest", true],
      ["an unknown guest", null],
    ])(
      "offers neither Repair setup nor Retry applying for %s",
      (_name, guestConfigured) => {
        mountLegacy(guestConfigured);

        expect(screen.queryByTestId("sandbox-setup-repair-setup")).toBeNull();
        expect(screen.queryByTestId("sandbox-setup-retry-applying")).toBeNull();
      },
    );

    it("offers no Repair setup when the failure is a settings stage but the summary is not loaded", () => {
      mocks.retrySupported = false;
      mocks.legacySupported = true;
      mocks.sandboxes = null;
      stageCreated("applying", { kind: "settings", code: "SBX-0520" });
      mount(vi.fn());

      expect(screen.queryByTestId("sandbox-setup-repair-setup")).toBeNull();
    });

    it("never offers Repair setup beside Retry applying on a host that negotiated the combined retry", () => {
      mocks.retrySupported = true;
      mocks.legacySupported = false;
      mocks.sandboxes = [
        sandboxSummaryFixture({ hostId: NEW_HOST, guestConfigured: false }),
      ];
      stageCreated("applying", { kind: "settings", code: "SBX-0520" });
      mount(vi.fn());

      expect(screen.getByTestId("sandbox-setup-retry-applying")).toBeTruthy();
      expect(screen.queryByTestId("sandbox-setup-repair-setup")).toBeNull();
    });
  });

  it("starts nothing when another sandbox was picked while the repair ran", () => {
    listCreatedAwake();
    stageCreated("applying", { kind: "settings", code: "SBX-0520" });
    let finishRepair: () => void = () => undefined;
    mocks.repairMutate.mockImplementationOnce((_variables, options) => {
      finishRepair = () =>
        options.onSuccess({ guestConfigured: true, settingsApplied: true });
    });
    mount(vi.fn());

    fireEvent.click(screen.getByTestId("sandbox-setup-retry-applying"));
    act(() => {
      useStagedSandboxStore.getState().stage(SURFACE, {
        kind: "existing",
        hostId: "other-host",
        sandboxId: "sbx-2",
        name: "other",
        configuration: { kind: "personal" },
        verb: "resume",
      });
    });
    finishRepair();

    expect(mocks.runStagedSandbox).not.toHaveBeenCalled();
    expect(readStagedSandbox(SURFACE)?.phase).toBe("staged");
  });

  it("retries waking the already-created New sandbox without making a replacement", () => {
    stageCreated("booting", {
      kind: "failed",
      code: "wake",
      step: "booting",
    });
    mount(vi.fn());

    fireEvent.click(screen.getByTestId("sandbox-setup-retry"));

    expect(screen.queryByTestId("sandbox-setup-retry-creation")).toBeNull();
    expect(mocks.runStagedSandbox).toHaveBeenCalledWith(
      SURFACE,
      false,
      expect.objectContaining({ taskId: "epic-1" }),
      expect.any(Object),
    );
  });

  it("keeps the staged sandbox and visible remedies when its standalone Stop fails", async () => {
    // Stop is offered once the sandbox is awake and booted.
    stageCreated("applying", null);
    listCreatedAwake();
    mocks.runVerb.mockRejectedValueOnce(new Error("Stop refused"));
    mount(vi.fn());
    fireEvent.click(screen.getByTestId("sandbox-setup-stop"));
    const failure = await screen.findByRole("alert");
    expect(failure.textContent).toContain("Couldn't stop api-refactor");
    expect(
      within(failure).getByRole("button", { name: "Retry" }),
    ).toBeDefined();
    expect(
      within(failure).getByRole("button", { name: "Details" }),
    ).toBeDefined();
    expect(readStagedSandbox(SURFACE)).not.toBeNull();
  });

  describe("Stop while a start or resume is under way", () => {
    it("says awake whenever setup offers Stop, through settings and delivery", () => {
      stageCreated("booting", null);
      listCreatedAwake();
      mount(vi.fn());
      expect(screen.queryByTestId("sandbox-setup-stop")).toBeNull();
      expect(
        screen.getByTestId("sandbox-setup-line-toggle").textContent,
      ).toContain("Starting sandbox");

      for (const step of ["applying", "delivering"] as const) {
        act(() => {
          useStagedSandboxStore.getState().report(SURFACE, {
            step,
            // The awake title also survives the taking-longer threshold.
            startedAt: Date.now() - 300_000,
          });
        });
        expect(screen.getByTestId("sandbox-setup-stop")).toBeDefined();
        const title = screen.getByTestId("sandbox-setup-line-toggle");
        expect(title.textContent).toContain("Sandbox awake");
        expect(title.textContent).not.toContain("Starting");
      }
    });

    it.each(["start", "resume"] as const)(
      "offers Stop again once a list answer newer than a pending %s reads the row awake",
      async (verb) => {
        stageCreated("applying", null);
        listCreatedAwake();
        const client = new QueryClient();
        const answer = Promise.withResolvers<void>();
        const view = render(
          <QueryClientProvider client={client}>
            <Harness openTerminal={vi.fn()} />
          </QueryClientProvider>,
        );
        act(() => {
          void client
            .getMutationCache()
            .build(client, {
              mutationKey: sandboxMutationKeys.verb("sbx-1"),
              mutationFn: () => answer.promise,
              onMutate: () => ({
                userId: useAuthStore.getState().contextMetadata?.userId ?? null,
              }),
            })
            .execute(verb);
        });
        await waitFor(() => {
          expect(screen.queryByTestId("sandbox-setup-stop")).toBeNull();
        });
        expect(
          screen.getByTestId("sandbox-setup-line-toggle").textContent,
        ).toContain("Starting sandbox");

        // The verb's reply is still out; a list answer after it reads awake.
        mocks.sandboxesAt = Date.now();
        view.rerender(
          <QueryClientProvider client={client}>
            <Harness openTerminal={vi.fn()} />
          </QueryClientProvider>,
        );
        expect(screen.getByTestId("sandbox-setup-stop")).toBeTruthy();
        expect(
          screen.getByTestId("sandbox-setup-line-toggle").textContent,
        ).toContain("Sandbox awake");

        await act(async () => {
          answer.resolve();
          await answer.promise;
        });
      },
    );

    it.each(["stopped", "suspended"] as const)(
      "offers no Stop while the wake runs over a cached %s row",
      (state) => {
        const store = useStagedSandboxStore.getState();
        store.stage(SURFACE, {
          kind: "existing",
          configuration: { kind: "personal" },
          hostId: NEW_HOST,
          sandboxId: "sbx-1",
          name: "api-refactor",
          verb: state === "stopped" ? "start" : "resume",
        });
        store.begin(SURFACE, false, Date.now(), false);
        // What the runner publishes before it awaits the wake.
        store.report(SURFACE, {
          createdSandboxId: "sbx-1",
          createdHostId: NEW_HOST,
          step: "booting",
          stepAt: Date.now(),
          failure: null,
        });
        mocks.sandboxes = [
          sandboxSummaryFixture({ id: "sbx-1", hostId: NEW_HOST, state }),
        ];
        mount(vi.fn());

        expect(screen.getByTestId("sandbox-setup-line")).toBeTruthy();
        expect(screen.queryByTestId("sandbox-setup-stop")).toBeNull();
      },
    );

    it("offers no Stop on an awake row while a Start for it is pending", async () => {
      stageCreated("applying", null);
      listCreatedAwake();
      const client = new QueryClient();
      render(
        <QueryClientProvider client={client}>
          <Harness openTerminal={vi.fn()} />
        </QueryClientProvider>,
      );
      expect(screen.getByTestId("sandbox-setup-stop")).toBeTruthy();

      act(() => {
        void client
          .getMutationCache()
          .build(client, {
            mutationKey: sandboxMutationKeys.verb("sbx-1"),
            mutationFn: () => new Promise<never>(() => undefined),
            onMutate: () => ({
              userId: useAuthStore.getState().contextMetadata?.userId ?? null,
            }),
          })
          .execute("start");
      });

      await waitFor(() => {
        expect(screen.queryByTestId("sandbox-setup-stop")).toBeNull();
      });
    });
  });

  it("names the sandbox the send creates and counts as a stopwatch", () => {
    const store = useStagedSandboxStore.getState();
    store.stage(SURFACE, {
      kind: "new",
      configuration: { kind: "personal" },
      shape: {
        os: "linux",
        cpus: 2,
        memoryMb: 4096,
        diskMb: null,
        region: "us-east",
        idleMinutes: 30,
        destroyAfterRestingMinutes: 10_080,
      },
      name: "sandbox-ab12",
      wakeString: null,
    });
    mount(vi.fn());

    act(() => {
      latestSend?.intercept("fix the login bug", null);
      store.begin(SURFACE, false, Date.now() - 8_000, false);
    });

    expect(
      screen.getByTestId("sandbox-setup-line-toggle").textContent,
    ).toContain("Starting sandbox·sandbox-ab12·0:08");
  });

  it("starts each send under its own idempotency key", () => {
    useStagedSandboxStore.getState().stage(SURFACE, {
      kind: "existing",
      hostId: NEW_HOST,
      sandboxId: "sbx-1",
      name: "api-refactor",
      configuration: { kind: "personal" },
      verb: "resume",
    });
    mount(vi.fn());

    act(() => {
      latestSend?.intercept("fix the login bug", null);
    });

    expect(mocks.runStagedSandbox).toHaveBeenCalledWith(
      SURFACE,
      true,
      expect.objectContaining({ taskId: "epic-1" }),
      expect.any(Object),
    );
  });
});

describe("useStagedSandboxSend's line after a refusal", () => {
  /** A create the server refused before making anything. */
  function stageRefused(failure: StagedSandboxFailure): void {
    stageCreated("creating", failure);
    useStagedSandboxStore.getState().report(SURFACE, {
      createdSandboxId: null,
      createdHostId: null,
    });
  }

  describe("for credits, from the viewer's balance and the catalogue's smallest shape", () => {
    function viewerWithCredits(totalPlanCredits: number): AuthenticatedUser {
      return userWith(
        userSubscription({
          totalPlanCredits,
          consumedFromPlan: 0,
          bonusCredits: 0,
          consumedFromBonus: 0,
          bundleRemaining: 0,
        }),
        [],
      );
    }

    function refusalButtons(): string[] {
      return within(screen.getByTestId("sandbox-refusal-line"))
        .getAllByRole("button")
        .map((button) => button.textContent);
    }

    it("offers Add credits, host choice and Cancel at a zero balance", () => {
      mocks.catalogue = LADDER;
      mocks.user = viewerWithCredits(0);
      stageRefused({ kind: "credits", shortfallMc: 120 });
      mount(vi.fn());

      expect(refusalButtons()).toEqual([
        "Add credits ↗",
        "Choose another host",
        "Cancel the message",
      ]);
    });

    it("adds Choose a smaller shape when the balance covers the smallest shape's hour", () => {
      mocks.catalogue = LADDER;
      // $0.20: under the staged shape's hour of credits, over the smallest's $0.12.
      mocks.user = viewerWithCredits(0.2);
      stageRefused({ kind: "credits", shortfallMc: 100 });
      mount(vi.fn());

      expect(refusalButtons()).toEqual([
        "Add credits ↗",
        "Choose a smaller shape",
        "Choose another host",
        "Cancel the message",
      ]);
    });
  });

  it("keeps an unknown credit source generic on a team staged refusal", () => {
    stageRefused({ kind: "credits", creditSource: null, shortfallMc: null });
    const current = readStagedSandbox(SURFACE);
    if (current === null) throw new Error("Expected the refused stage");
    useStagedSandboxStore.setState({
      bySurface: {
        [SURFACE]: {
          ...current,
          target: {
            ...current.target,
            configuration: { kind: "team", teamId: "team-1", teamName: "Acme" },
          },
        },
      },
    });
    mount(vi.fn());
    expect(screen.getByTestId("sandbox-refusal-line").textContent).toContain(
      "Not enough credits to start this sandbox for an hour.",
    );
    expect(
      screen.getByTestId("sandbox-refusal-line").textContent,
    ).not.toContain("allowance");
  });

  it("retries a create whose answer never came under its own key", () => {
    stageRefused({ kind: "unverified" });
    mount(vi.fn());

    fireEvent.click(screen.getByTestId("sandbox-refusal-retry"));

    expect(mocks.runStagedSandbox).toHaveBeenCalledWith(
      SURFACE,
      false,
      expect.any(Object),
      expect.any(Object),
    );
  });

  it("names no amount when the refusal named no shortfall", () => {
    stageRefused({ kind: "credits", shortfallMc: null });
    mount(vi.fn());

    const line = screen.getByTestId("sandbox-refusal-line").textContent;
    expect(line).toContain(notEnoughCreditsLine(null));
    expect(line).not.toContain("$0.00");
  });
});

describe("useStagedSandboxSend's setup line prices and names what it stages", () => {
  function stageExisting(): void {
    stageCreated("booting", null);
    useStagedSandboxStore.getState().stage(SURFACE, {
      kind: "existing",
      hostId: NEW_HOST,
      sandboxId: "sbx-1",
      name: "api-refactor",
      configuration: { kind: "personal" },
      verb: "resume",
    });
    useStagedSandboxStore.getState().begin(SURFACE, false, Date.now(), false);
  }

  function detail(): string {
    fireEvent.click(screen.getByTestId("sandbox-setup-line-toggle"));
    return screen.getByTestId("sandbox-setup-line-detail").textContent;
  }

  /** The detail as it stands: open already while taking longer or failed. */
  function shownDetail(): string {
    return screen.getByTestId("sandbox-setup-line-detail").textContent;
  }

  it("prices a resting sandbox from its list row's awake rate, exactly", () => {
    mocks.sandboxes = [
      sandboxSummaryFixture({
        id: "sbx-1",
        priceMcPerHour: { awakeMc: 210, suspendedMc: 4, stoppedMc: 2 },
      }),
    ];
    stageExisting();
    mount(vi.fn());

    const text = detail();
    expect(text).toContain("$0.21 an hour while awake · uses your credits");
    expect(text).not.toContain("Billed by the hour");
    expect(text).not.toContain("from $");
  });

  it("says the hour is billed, unpriced, when the row names no rate", () => {
    mocks.sandboxes = [
      sandboxSummaryFixture({ id: "sbx-1", priceMcPerHour: null }),
    ];
    stageExisting();
    mount(vi.fn());

    expect(detail()).toContain("Billed by the hour while awake");
  });

  it("says compute is charged while it is awake once the resume is ticked, in the taking-longer line", () => {
    stageExisting();
    useStagedSandboxStore.getState().report(SURFACE, {
      startedAt: Date.now() - 200_000,
      step: "delivering",
      stepAt: Date.now() - 156_500,
    });
    mount(vi.fn());

    expect(shownDetail()).toContain(
      "Last step: Delivering your message, reported 2:36 ago · your message waits · compute is charged while it is awake",
    );
  });

  it("still says nothing is billed until it is awake while the wake has not happened", () => {
    stageExisting();
    useStagedSandboxStore.getState().report(SURFACE, {
      startedAt: Date.now() - 200_000,
      step: "booting",
      stepAt: Date.now() - 156_500,
    });
    mount(vi.fn());

    const text = shownDetail();
    expect(text).toContain(
      "Last step: Resuming, reported 2:36 ago · your message waits · nothing is billed until it is awake",
    );
    expect(text).not.toContain("compute is charged while it is awake");
  });

  it.each(["applying", "delivering"] as const)(
    "says compute is charged while it is awake when the sandbox failed at %s, not that nothing was billed",
    (step) => {
      stageExisting();
      useStagedSandboxStore.getState().report(SURFACE, {
        step,
        stepAt: Date.now(),
        failure: { kind: "failed", code: "PROVIDER_CREATE_FAILED", step },
      });
      mount(vi.fn());

      const text = shownDetail();
      expect(text).toContain("Compute is charged while it is awake.");
      expect(text).not.toContain("Nothing was");
    },
  );

  it("still says nothing was billed for a sandbox that failed before it woke", () => {
    stageExisting();
    useStagedSandboxStore.getState().report(SURFACE, {
      failure: {
        kind: "failed",
        code: "PROVIDER_CREATE_FAILED",
        step: "booting",
      },
    });
    mount(vi.fn());

    expect(shownDetail()).toContain("Nothing was charged for this wake.");
  });

  it("never prints the id of a region the catalogue does not list in the shape refusal", () => {
    mocks.catalogue = LADDER;
    stageCreated("creating", { kind: "shape" });
    useStagedSandboxStore.getState().setTarget(SURFACE, {
      kind: "new",
      configuration: { kind: "personal" },
      shape: {
        os: "linux",
        cpus: 2,
        memoryMb: 4096,
        diskMb: null,
        region: "mars-central-9",
        idleMinutes: 30,
        destroyAfterRestingMinutes: 10_080,
      },
      name: "api-refactor",
      wakeString: null,
    });
    mount(vi.fn());

    const line = screen.getByTestId("sandbox-refusal-line").textContent;
    expect(line).toContain("This region doesn't offer 2 vCPU · 4 GB.");
    expect(line).not.toContain("mars-central-9");
  });
});

/** One landing draft's composer: the window's drafts share the surface. */
function DraftComposer(props: {
  readonly draftId: string;
  readonly submit: () => StagedResubmit;
  readonly onSend: (send: StagedSandboxSend) => void;
}) {
  const { onSend } = props;
  const send = useStagedSandboxSend({
    surfaceKey: SURFACE,
    terminal: null,
    taskId: null,
    ownerId: props.draftId,
    claimsSend: false,
  });
  useStagedSandboxHandoff({
    surfaceKey: SURFACE,
    resolvedHostId: NEW_HOST,
    canSubmit: true,
    submit: props.submit,
    prepareHandoff: noPrepare,
    ownerId: props.draftId,
    watchOwner: ownerGoneOnUnmount,
  });
  useEffect(() => {
    onSend(send);
  }, [onSend, send]);
  return <>{send.line}</>;
}

/** A draft's phase 2 still waiting on its new host's catalog. */
function WaitingHandoff(props: {
  readonly draftId: string;
  readonly watchOwner: HandoffOwnerWatch;
}) {
  useStagedSandboxHandoff({
    surfaceKey: SURFACE,
    resolvedHostId: NEW_HOST,
    canSubmit: false,
    submit: () => true,
    prepareHandoff: noPrepare,
    ownerId: props.draftId,
    watchOwner: props.watchOwner,
  });
  return null;
}

function handoffWaitingOn(draftId: string): void {
  useStagedSandboxStore.getState().stage(SURFACE, {
    kind: "existing",
    hostId: NEW_HOST,
    sandboxId: "sbx-1",
    name: "api-refactor",
    configuration: { kind: "personal" },
    verb: "resume",
  });
  useStagedSandboxStore.getState().report(SURFACE, {
    phase: "handoff",
    createdHostId: NEW_HOST,
    ownerId: draftId,
    sendTaken: true,
  });
}

async function afterCommit(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
  });
}

describe("useStagedSandboxSend's handoff", () => {
  it("drops a handoff whose sending draft is gone as it unmounts, and keeps one across a remount", async () => {
    handoffWaitingOn("draft-a");
    const view = render(
      <>
        <WaitingHandoff
          key="mount-1"
          draftId="draft-a"
          watchOwner={ownerGoneOnUnmount}
        />
        <WaitingHandoff
          key="other"
          draftId="draft-b"
          watchOwner={ownerGoneOnUnmount}
        />
      </>,
    );

    view.rerender(
      <>
        <WaitingHandoff
          key="mount-2"
          draftId="draft-a"
          watchOwner={ownerGoneOnUnmount}
        />
        <WaitingHandoff
          key="other"
          draftId="draft-b"
          watchOwner={ownerGoneOnUnmount}
        />
      </>,
    );
    await afterCommit();
    expect(readStagedSandbox(SURFACE)?.phase).toBe("handoff");

    // Its tab closed; another draft's is still open.
    view.rerender(
      <WaitingHandoff
        key="other"
        draftId="draft-b"
        watchOwner={ownerGoneOnUnmount}
      />,
    );
    await afterCommit();
    expect(readStagedSandbox(SURFACE)).toBeNull();
  });

  it("keeps a handoff whose draft is unmounted but still open, until the draft closes", async () => {
    handoffWaitingOn("draft-a");
    const draftA: { close: (() => void) | null } = { close: null };
    const watchDraftA: HandoffOwnerWatch = (onGone) => {
      draftA.close = onGone;
      return () => {
        draftA.close = null;
      };
    };
    const view = render(
      <WaitingHandoff draftId="draft-a" watchOwner={watchDraftA} />,
    );

    // Another draft took the start page.
    view.rerender(
      <WaitingHandoff draftId="draft-b" watchOwner={ownerGoneOnUnmount} />,
    );
    await afterCommit();
    expect(readStagedSandbox(SURFACE)?.phase).toBe("handoff");

    act(() => {
      draftA.close?.();
    });
    expect(readStagedSandbox(SURFACE)).toBeNull();
  });

  it("resubmits only the draft that sent, though every draft shares the stage", () => {
    useStagedSandboxStore.getState().stage(SURFACE, {
      kind: "existing",
      hostId: NEW_HOST,
      sandboxId: "sbx-1",
      name: "api-refactor",
      configuration: { kind: "personal" },
      verb: "resume",
    });
    const submitA = vi.fn(() => true);
    const submitB = vi.fn(() => true);
    let sendA: StagedSandboxSend | null = null;
    render(
      <QueryClientProvider client={new QueryClient()}>
        <DraftComposer
          draftId="draft-a"
          submit={submitA}
          onSend={(send) => {
            sendA = send;
          }}
        />
        <DraftComposer
          draftId="draft-b"
          submit={submitB}
          onSend={() => undefined}
        />
      </QueryClientProvider>,
    );

    act(() => {
      sendA?.intercept("fix the login bug", null);
      useStagedSandboxStore.getState().report(SURFACE, {
        createdHostId: NEW_HOST,
        phase: "handoff",
      });
    });

    expect(submitA).toHaveBeenCalledTimes(1);
    expect(submitB).not.toHaveBeenCalled();
  });

  it("hands off the sending draft's action, not a Start another draft pressed while it booted", () => {
    // The whole handoff in one millisecond: the resubmit must not wait on the
    // clock moving.
    const clock = vi.spyOn(Date, "now").mockReturnValue(1_791_100_000_000);
    onTestFinished(() => clock.mockRestore());
    useStagedSandboxStore.getState().stage(SURFACE, {
      kind: "existing",
      hostId: NEW_HOST,
      sandboxId: "sbx-1",
      name: "api-refactor",
      configuration: { kind: "personal" },
      verb: "resume",
    });
    const submitA = vi.fn(() => true);
    const submitB = vi.fn(() => true);
    let sendA: StagedSandboxSend | null = null;
    let sendB: StagedSandboxSend | null = null;
    render(
      <QueryClientProvider client={new QueryClient()}>
        <DraftComposer
          draftId="draft-a"
          submit={submitA}
          onSend={(send) => {
            sendA = send;
          }}
        />
        <DraftComposer
          draftId="draft-b"
          submit={submitB}
          onSend={(send) => {
            sendB = send;
          }}
        />
      </QueryClientProvider>,
    );

    act(() => {
      sendA?.intercept("fix the login bug", null);
      // Phase 1 is under way.
      useStagedSandboxStore.getState().begin(SURFACE, false, Date.now(), false);
    });
    let takenFromB = false;
    act(() => {
      takenFromB =
        sendB?.intercept("terminal", {
          harnessId: "claude",
          model: null,
          reasoningEffort: null,
          terminalAgentArgs: null,
          profileId: null,
        }) ?? false;
    });

    // B's Start runs nowhere, and the stage still holds A's send.
    expect(takenFromB).toBe(true);
    expect(readStagedSandbox(SURFACE)).toMatchObject({
      ownerId: "draft-a",
      terminalLaunch: null,
    });

    act(() => {
      useStagedSandboxStore.getState().report(SURFACE, {
        createdHostId: NEW_HOST,
        phase: "handoff",
      });
    });

    expect(submitA).toHaveBeenCalledTimes(1);
    expect(submitB).not.toHaveBeenCalled();
  });
});

describe("useStagedSandboxSend on a boot a terminal ask started", () => {
  it("hands off the first send made while it boots, without starting a second run", () => {
    useStagedSandboxStore.getState().stage(SURFACE, {
      kind: "existing",
      hostId: NEW_HOST,
      sandboxId: "sbx-1",
      name: "api-refactor",
      configuration: { kind: "personal" },
      verb: "resume",
    });
    useStagedSandboxStore.getState().report(SURFACE, { openTerminal: true });
    useStagedSandboxStore.getState().begin(SURFACE, false, Date.now(), false);
    const submit = vi.fn(() => true);
    let send: StagedSandboxSend | null = null;
    render(
      <QueryClientProvider client={new QueryClient()}>
        <DraftComposer
          draftId="draft-a"
          submit={submit}
          onSend={(next) => {
            send = next;
          }}
        />
      </QueryClientProvider>,
    );

    let taken = false;
    act(() => {
      taken = send?.intercept("fix the login bug", null) ?? false;
    });
    expect(taken).toBe(true);
    expect(mocks.runStagedSandbox).not.toHaveBeenCalled();
    expect(readStagedSandbox(SURFACE)).toMatchObject({
      ownerId: "draft-a",
      sendTaken: true,
      openTerminal: true,
    });

    act(() => {
      useStagedSandboxStore.getState().report(SURFACE, {
        createdHostId: NEW_HOST,
        phase: "handoff",
      });
    });
    expect(submit).toHaveBeenCalledTimes(1);
  });
});

describe("useStagedSandboxSend's refused resubmit", () => {
  it("keeps the stage, the sandbox and the draft when the new host cannot run Traycer Inference, and says why", () => {
    useStagedSandboxStore.getState().stage(SURFACE, {
      kind: "existing",
      hostId: NEW_HOST,
      sandboxId: "sbx-1",
      name: "api-refactor",
      configuration: { kind: "personal" },
      verb: "resume",
    });
    const submit = vi.fn(() => false);
    let send: StagedSandboxSend | null = null;
    function Refusing() {
      const result = useStagedSandboxSend({
        surfaceKey: SURFACE,
        terminal: null,
        taskId: null,
        ownerId: null,
        claimsSend: false,
      });
      useStagedSandboxHandoff({
        surfaceKey: SURFACE,
        resolvedHostId: NEW_HOST,
        canSubmit: true,
        submit,
        prepareHandoff: noPrepare,
        ownerId: null,
        watchOwner: ownerGoneOnUnmount,
      });
      useEffect(() => {
        send = result;
      }, [result]);
      return <>{result.line}</>;
    }
    render(
      <QueryClientProvider client={new QueryClient()}>
        <Refusing />
      </QueryClientProvider>,
    );

    act(() => {
      send?.intercept("fix the login bug", null);
      useStagedSandboxStore.getState().report(SURFACE, {
        createdSandboxId: "sbx-1",
        createdHostId: NEW_HOST,
        phase: "handoff",
      });
    });

    expect(submit).toHaveBeenCalledTimes(1);
    expect(useStagedSandboxStore.getState().bySurface[SURFACE]).toMatchObject({
      phase: "handoff",
      failure: { kind: "no-provider" },
    });
    expect(screen.getByTestId("sandbox-refusal-line").textContent).toContain(
      "Agents can't run on api-refactor.",
    );
    expect(screen.getByTestId("sandbox-refusal-details")).toBeDefined();

    // The person's next send is their own, on the host the surface is on.
    let taken = true;
    act(() => {
      taken = send?.intercept("fix the login bug", null) ?? true;
    });
    expect(taken).toBe(false);
    expect(useStagedSandboxStore.getState().bySurface[SURFACE]).toBeUndefined();
  });
});

/**
 * Stages a New sandbox, sends, waits for the create to fail as `failure`,
 * then sends again: the two creates' idempotency keys.
 */
async function sendAgainAfter(
  failure: StagedSandboxFailure["kind"],
): Promise<ReadonlyArray<string | null>> {
  const actual = await vi.importActual<
    typeof import("@/lib/sandboxes/staged-sandbox-run")
  >("@/lib/sandboxes/staged-sandbox-run");
  mocks.runStagedSandbox.mockImplementation(actual.runStagedSandbox);
  useStagedSandboxStore.getState().stage(SURFACE, {
    kind: "new",
    configuration: { kind: "personal" },
    shape: {
      os: "linux",
      cpus: 2,
      memoryMb: 4096,
      diskMb: null,
      region: "us-east",
      idleMinutes: 30,
      destroyAfterRestingMinutes: 10_080,
    },
    name: "api-refactor",
    wakeString: null,
  });
  mount(vi.fn());

  act(() => {
    latestSend?.intercept("first", null);
  });
  await waitFor(() => {
    expect(readStagedSandbox(SURFACE)?.failure?.kind).toBe(failure);
  });
  let intercepted = false;
  act(() => {
    intercepted = latestSend?.intercept("second", null) ?? false;
  });
  await waitFor(() => {
    expect(mocks.createSandbox).toHaveBeenCalledTimes(2);
  });
  expect(intercepted).toBe(true);
  return mocks.createSandbox.mock.calls.map(
    ([request]) => request.clientRequestId,
  );
}

describe("useStagedSandboxSend's send after a failed create", () => {
  it("makes a new create after a refusal for credits, and offers Add credits and no Retry", async () => {
    mocks.createSandbox.mockResolvedValue(
      refusal(402, SANDBOX_REFUSAL_CODE_INSUFFICIENT_CREDIT),
    );

    const [first, second] = await sendAgainAfter("credits");

    expect(second).not.toBe(first);
    expect(screen.getByTestId("sandbox-refusal-add-credits")).toBeDefined();
    expect(screen.queryByTestId("sandbox-refusal-retry")).toBeNull();
  });

  it("repeats the same create after one whose answer never came, since it may have been accepted", async () => {
    mocks.createSandbox.mockRejectedValue(new Error("bridge refused"));

    const [first, second] = await sendAgainAfter("unverified");

    expect(second).toBe(first);
  });

  it("makes a new create after the sandbox the last one made failed", () => {
    stageCreated("booting", {
      kind: "failed",
      code: "PROVIDER_CREATE_FAILED",
      step: "booting",
    });
    const failed = readStagedSandbox(SURFACE)?.clientRequestId;
    const keys: (string | null)[] = [];
    mocks.runStagedSandbox.mockImplementation((surfaceKey, fresh) => {
      keys.push(
        useStagedSandboxStore
          .getState()
          .begin(surfaceKey, fresh, Date.now(), false),
      );
      return Promise.resolve();
    });
    mount(vi.fn());

    act(() => {
      latestSend?.intercept("second", null);
    });

    expect(failed).toBeDefined();
    expect(keys).toHaveLength(1);
    expect(keys[0]).not.toBe(failed);
  });

  it("repeats the same create after an accepted sandbox froze for credits while it settled", () => {
    // Accepted, then frozen on its way up: the same failure a refusal
    // reports, after a billed create.
    stageCreated("booting", { kind: "credits", shortfallMc: null });
    const accepted = readStagedSandbox(SURFACE)?.clientRequestId;
    const keys: (string | null)[] = [];
    mocks.runStagedSandbox.mockImplementation((surfaceKey, fresh) => {
      keys.push(
        useStagedSandboxStore
          .getState()
          .begin(surfaceKey, fresh, Date.now(), false),
      );
      return Promise.resolve();
    });
    mount(vi.fn());

    act(() => {
      latestSend?.intercept("second", null);
    });

    expect(accepted).toBeDefined();
    expect(keys).toEqual([accepted]);
  });
});

describe("startStagedTerminal", () => {
  const FAILED: StagedSandboxFailure = {
    kind: "failed",
    code: "PROVIDER_CREATE_FAILED",
    step: "booting",
  };
  it.each([
    { stage: "on its way", failure: null, kind: "taken", starts: null },
    { stage: "failed", failure: FAILED, kind: "taken", starts: true },
    {
      stage: "refused for credits",
      failure: { kind: "credits", shortfallMc: 100 } as const,
      kind: "taken",
      starts: true,
    },
    // Stopped short under a key that may have an accepted create behind it:
    // taken as Keep waiting or Retry takes it, never left to the fallback host.
    {
      stage: "timed out",
      failure: { kind: "timed-out", step: "booting" } as const,
      kind: "taken",
      starts: false,
    },
    {
      stage: "unverified",
      failure: { kind: "unverified" } as const,
      kind: "taken",
      starts: false,
    },
  ])(
    "on a create $stage: $kind, starting a run: $starts",
    ({ failure, kind, starts }) => {
      stageCreated("booting", failure);
      if (failure?.kind === "credits") {
        // Refused before anything was created.
        useStagedSandboxStore.getState().report(SURFACE, {
          createdSandboxId: null,
          createdHostId: null,
        });
      }
      const start = vi.fn();

      expect(startStagedTerminal(SURFACE, start).kind).toBe(kind);

      expect(start.mock.calls).toEqual(starts === null ? [] : [[starts]]);
      expect(readStagedSandbox(SURFACE)?.openTerminal).toBe(true);
    },
  );

  it("wakes again under the same key for a terminal asked after a wake that failed", () => {
    const store = useStagedSandboxStore.getState();
    store.stage(SURFACE, {
      kind: "existing",
      hostId: NEW_HOST,
      sandboxId: "sbx-1",
      name: "api-refactor",
      configuration: { kind: "personal" },
      verb: "resume",
    });
    store.begin(SURFACE, false, Date.now(), false);
    store.report(SURFACE, {
      failure: { kind: "failed", code: "wake", step: "booting" },
    });
    const start = vi.fn();

    expect(startStagedTerminal(SURFACE, start).kind).toBe("taken");
    expect(start.mock.calls).toEqual([[false]]);
  });

  it("takes the ask on a stage nothing ran for yet, starting its first run", () => {
    useStagedSandboxStore.getState().stage(SURFACE, {
      kind: "existing",
      hostId: NEW_HOST,
      sandboxId: "sbx-1",
      name: "api-refactor",
      configuration: { kind: "personal" },
      verb: "resume",
    });
    const start = vi.fn();

    expect(startStagedTerminal(SURFACE, start).kind).toBe("taken");
    expect(start.mock.calls).toEqual([[true]]);
  });

  it("opens the terminal on a sandbox that is up with settings that did not apply", () => {
    stageCreated("applying", { kind: "settings", code: "settings" });
    const start = vi.fn();

    expect(startStagedTerminal(SURFACE, start)).toEqual({
      kind: "awake",
      hostId: NEW_HOST,
    });
    expect(start).not.toHaveBeenCalled();
    expect(readStagedSandbox(SURFACE)?.openTerminal).toBe(false);
  });

  it("leaves the ask to the caller while the stage hands off", () => {
    stageCreated("delivering", null);
    useStagedSandboxStore.getState().report(SURFACE, { phase: "handoff" });

    expect(startStagedTerminal(SURFACE, vi.fn()).kind).toBe("not-taken");
  });
});

describe("openLandingStagedTerminal", () => {
  beforeEach(() => {
    useLandingPanelStore.getState().clearTerminalRequest();
  });

  it("takes the ask on a staged sandbox as its first run, folderless and nameless, without a task", () => {
    useStagedSandboxStore.getState().stage(SURFACE, {
      kind: "new",
      configuration: { kind: "personal" },
      shape: {
        os: "linux",
        cpus: 2,
        memoryMb: 4096,
        diskMb: null,
        region: "us-east",
        idleMinutes: 30,
        destroyAfterRestingMinutes: null,
      },
      name: "",
      wakeString: null,
    });
    const runner = vi.fn();

    expect(openLandingStagedTerminal(SURFACE, runner)).toEqual({
      kind: "taken",
    });

    expect(runner).toHaveBeenCalledTimes(1);
    expect(runner).toHaveBeenCalledWith(SURFACE, true, {
      taskId: null,
      resume: false,
    });
    expect(readStagedSandbox(SURFACE)?.openTerminal).toBe(true);
    expect(useLandingPanelStore.getState().terminalRequest).toBeNull();
  });

  it("opens the start page's terminal on a sandbox that is up with settings that did not apply, and pins the surface to it", () => {
    stageCreated("applying", { kind: "settings", code: "settings" });
    const runner = vi.fn();

    expect(openLandingStagedTerminal(SURFACE, runner)).toEqual({
      kind: "awake",
      hostId: NEW_HOST,
    });

    expect(runner).not.toHaveBeenCalled();
    expect(useLandingPanelStore.getState().terminalRequest).toEqual({
      surfaceKey: SURFACE,
      hostId: NEW_HOST,
      landingPageId: null,
    });
    expect(useSurfaceHostSelectionStore.getState().selections[SURFACE]).toBe(
      NEW_HOST,
    );
  });

  it("wakes the staged host with the landing terminal gesture", async () => {
    const actual = await vi.importActual<
      typeof import("@/lib/sandboxes/staged-sandbox-run")
    >("@/lib/sandboxes/staged-sandbox-run");
    mocks.runStagedSandbox.mockImplementation(actual.runStagedSandbox);
    useStagedSandboxStore.getState().stage(SURFACE, {
      kind: "existing",
      hostId: NEW_HOST,
      sandboxId: "sbx-1",
      name: "api-refactor",
      configuration: { kind: "personal" },
      verb: "resume",
    });
    mount(vi.fn());
    const runner = latestRunner;
    if (runner === null) throw new Error("expected the staged sandbox runner");

    expect(openLandingStagedTerminal(SURFACE, runner).kind).toBe("taken");

    await waitFor(() => {
      expect(mocks.startSandboxWake).toHaveBeenCalledWith(
        expect.any(QueryClient),
        expect.any(Object),
        NEW_HOST,
        "open-terminal",
      );
    });
    await waitFor(() => {
      expect(readStagedSandbox(SURFACE)?.failure).toMatchObject({
        kind: "failed",
        code: "wake",
      });
    });
  });
});

/** A modal tab's composer: its line, its send and its phase 2. */
function TabComposer(props: {
  readonly tabId: string;
  readonly submit: () => boolean;
}) {
  const send = useStagedSandboxSend({
    surfaceKey: SURFACE,
    terminal: null,
    taskId: null,
    ownerId: props.tabId,
    claimsSend: true,
  });
  useStagedSandboxHandoff({
    surfaceKey: SURFACE,
    resolvedHostId: NEW_HOST,
    canSubmit: true,
    submit: props.submit,
    prepareHandoff: noPrepare,
    ownerId: props.tabId,
    watchOwner: ownerGoneOnUnmount,
  });
  return <>{send.line}</>;
}

describe("useStagedSandboxSend after the sending tab is gone", () => {
  it("hands off another tab's Retry once the tab whose send failed closed", async () => {
    stageCreated("creating", { kind: "unverified" });
    useStagedSandboxStore.getState().report(SURFACE, {
      createdSandboxId: null,
      createdHostId: null,
      ownerId: "tab-a",
      sendTaken: true,
    });
    const submitA = vi.fn(() => true);
    const submitB = vi.fn(() => true);
    const client = new QueryClient();
    const view = render(
      <QueryClientProvider client={client}>
        <TabComposer tabId="tab-a" submit={submitA} />
      </QueryClientProvider>,
    );
    view.rerender(
      <QueryClientProvider client={client}>
        <TabComposer tabId="tab-b" submit={submitB} />
      </QueryClientProvider>,
    );
    await act(async () => {
      await Promise.resolve();
    });
    expect(readStagedSandbox(SURFACE)).toMatchObject({
      ownerId: null,
      sendTaken: false,
    });

    fireEvent.click(screen.getByTestId("sandbox-refusal-retry"));
    expect(readStagedSandbox(SURFACE)).toMatchObject({
      ownerId: "tab-b",
      sendTaken: true,
    });
    expect(mocks.runStagedSandbox).toHaveBeenCalledWith(
      SURFACE,
      false,
      expect.any(Object),
      expect.any(Object),
    );

    act(() => {
      useStagedSandboxStore.getState().report(SURFACE, {
        failure: null,
        createdHostId: NEW_HOST,
        phase: "handoff",
      });
    });
    expect(submitB).toHaveBeenCalledTimes(1);
    expect(submitA).not.toHaveBeenCalled();
  });
});

describe("useStagedSandboxSend after the start page draft that sent is closed", () => {
  it("brings the sandbox up on another draft's Retry of a create whose answer never came and leaves that draft's text to it", async () => {
    const actual = await vi.importActual<
      typeof import("@/lib/sandboxes/staged-sandbox-run")
    >("@/lib/sandboxes/staged-sandbox-run");
    mocks.runStagedSandbox.mockImplementation(actual.runStagedSandbox);
    const sandbox = sandboxSummaryFixture({ id: "sbx-1", hostId: NEW_HOST });
    mocks.createSandbox
      .mockRejectedValueOnce(new Error("bridge refused"))
      .mockResolvedValue({
        kind: "ok",
        accepted: {
          sandboxId: "sbx-1",
          hostId: NEW_HOST,
          sandbox: { ...sandbox, state: "creating" },
        },
      });
    mocks.listSandboxes.mockResolvedValue({
      kind: "ok",
      response: {
        sandboxes: [{ ...sandbox, state: "awake", guestConfigured: true }],
      },
    });
    mocks.findById.mockImplementation((hostId) => ({
      hostId,
      label: "api-refactor",
      kind: "remote",
      websocketUrl: "ws://sbx-host.test",
      version: null,
      transportDialability: "dialable",
    }));
    useStagedSandboxStore.getState().stage(SURFACE, {
      kind: "new",
      configuration: { kind: "personal" },
      shape: {
        os: "linux",
        cpus: 2,
        memoryMb: 4096,
        diskMb: null,
        region: "us-east",
        idleMinutes: 30,
        destroyAfterRestingMinutes: 10_080,
      },
      name: "api-refactor",
      wakeString: null,
    });
    const submitA = vi.fn(() => true);
    const submitB = vi.fn(() => true);
    const sends: { a: StagedSandboxSend | null; b: StagedSandboxSend | null } =
      { a: null, b: null };
    const client = new QueryClient();
    const draftB = (submit: () => boolean) => (
      <QueryClientProvider client={client}>
        <DraftComposer
          draftId="draft-b"
          submit={submit}
          onSend={(send) => {
            sends.b = send;
          }}
        />
      </QueryClientProvider>
    );
    const view = render(
      <QueryClientProvider client={client}>
        <DraftComposer
          draftId="draft-a"
          submit={submitA}
          onSend={(send) => {
            sends.a = send;
          }}
        />
      </QueryClientProvider>,
    );

    act(() => {
      sends.a?.intercept("fix the login bug", null);
    });
    await waitFor(() => {
      expect(readStagedSandbox(SURFACE)?.failure?.kind).toBe("unverified");
    });
    // A closes; a fresh draft B opens on the start page.
    view.rerender(draftB(submitB));
    await afterCommit();

    // B presses Retry and the sandbox comes up.
    fireEvent.click(screen.getByTestId("sandbox-refusal-retry"));
    await waitFor(() => {
      expect(readStagedSandbox(SURFACE)).toBeNull();
    });

    expect(useSurfaceHostSelectionStore.getState().selections[SURFACE]).toBe(
      NEW_HOST,
    );
    // B types on: its text is its own to send, on the pinned sandbox.
    const typing = vi.fn(() => true);
    view.rerender(draftB(typing));
    await afterCommit();
    expect(sends.b?.intercept("half a thought", null)).toBe(false);
    expect(submitA).not.toHaveBeenCalled();
    expect(submitB).not.toHaveBeenCalled();
    expect(typing).not.toHaveBeenCalled();
  });
});

describe("useStagedSandboxSend's resubmit while its images are read", () => {
  it("holds the handoff until the create goes out, through a remount, and offers Retry for one that stopped short", async () => {
    handoffWaitingOn("draft-a");
    const answers: Array<(sent: boolean) => void> = [];
    const submit = vi.fn(
      (): StagedResubmit =>
        new Promise<boolean>((resolve) => {
          answers.push(resolve);
        }),
    );
    const client = new QueryClient();
    const composer = (key: string) => (
      <QueryClientProvider client={client}>
        <DraftComposer
          key={key}
          draftId="draft-a"
          submit={submit}
          onSend={() => undefined}
        />
      </QueryClientProvider>
    );
    const view = render(composer("first"));

    expect(submit).toHaveBeenCalledTimes(1);
    expect(readStagedSandbox(SURFACE)).toMatchObject({
      phase: "handoff",
      failure: null,
    });
    // The draft's page goes away and comes back while the images are read.
    view.rerender(composer("second"));
    await afterCommit();
    expect(submit).toHaveBeenCalledTimes(1);

    await act(async () => {
      answers[0]?.(false);
      await Promise.resolve();
    });
    expect(readStagedSandbox(SURFACE)).toMatchObject({
      phase: "handoff",
      failure: { kind: "not-sent" },
    });

    fireEvent.click(screen.getByTestId("sandbox-refusal-send-again"));
    expect(submit).toHaveBeenCalledTimes(2);
    await act(async () => {
      answers[1]?.(true);
      await Promise.resolve();
    });
    expect(readStagedSandbox(SURFACE)).toBeNull();
  });
});

describe("stagedSandboxFallbackName", () => {
  it("keeps a name from a long first word within the create's 191 characters", () => {
    expect(stagedSandboxFallbackName(`${"a".repeat(300)} fix`)).toBe(
      "a".repeat(191),
    );
  });
});
