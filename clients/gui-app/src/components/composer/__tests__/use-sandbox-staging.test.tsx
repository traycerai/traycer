import { useSandboxesPageStore } from "@/stores/sandboxes/sandboxes-page-store";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useEffect } from "react";
import { QueryClient } from "@tanstack/react-query";
import { AuthService } from "@/lib/auth/auth-service";
import { HostDirectoryService } from "@/lib/host";
import { createFakeRunnerHost } from "../../../../__tests__/create-fake-runner-host";
import { refusal } from "@/hooks/sandboxes/__tests__/sandbox-binding-fixture";
import { SANDBOX_REFUSAL_CODE_INSUFFICIENT_CREDIT } from "@traycer/protocol/host/sandbox-control";
import { runStagedSandbox } from "@/lib/sandboxes/staged-sandbox-run";
import {
  handPendingSandboxSend,
  endPendingSandboxSend,
} from "@/lib/sandboxes/pending-sandbox-send";
import {
  PICKED_SETTINGS,
  MESSAGE_CONTENT,
} from "@/lib/sandboxes/__tests__/pending-send-fixtures";
import {
  pendingSendSurfaceKey,
  usePendingSandboxSendStore,
} from "@/stores/sandboxes/pending-sandbox-send-store";
import {
  openLandingStagedTerminal,
  type StagedSandboxRunner,
} from "@/components/composer/use-staged-sandbox-send";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import type { AuthenticatedUser } from "@traycer/protocol/auth";
import type { HostListItem } from "@traycer/protocol/host/host-status";
import type {
  SandboxCreateRequest,
  SandboxCatalogue,
  SandboxCatalogueProvider,
  SandboxCost,
  UserSandboxCost,
} from "@traycer/protocol/host/sandbox-control";
import {
  useSandboxStaging,
  type SandboxStagingTask,
  type SandboxStaging,
} from "@/components/composer/use-sandbox-staging";
import { ConsequencesBlock } from "@/components/composer/consequences-block";
import { hostScopeOptionFixture } from "@/components/settings/host-scope/host-scope-fixture";
import type {
  HostScopeOption,
  HostScopeSandbox,
} from "@/components/settings/host-scope/host-scope-model";
import { sandboxSummaryFixture } from "@/hooks/sandboxes/__tests__/sandbox-fixtures";
import {
  teamSubscription,
  userSubscription,
  userWith,
} from "@/lib/sandboxes/__tests__/auth-user-fixture";
import type {
  SandboxConfigurationDefaults,
  StageShape,
} from "@/lib/sandboxes/sandbox-stage-model";
import {
  idleAndRestingLine,
  SANDBOXES_CANT_BE_CREATED,
  WAKE_STRING_MEMORY,
} from "@/lib/sandboxes/sandbox-strings";
import { useSandboxShapeMemoryStore } from "@/stores/composer/sandbox-shape-memory-store";
import {
  readStagedSandbox,
  useStagedSandboxStore,
} from "@/stores/composer/staged-sandbox-store";
import { useAuthStore } from "@/stores/auth/auth-store";
import {
  emptyLandingDraftWorkspaceSnapshot,
  useLandingDraftStore,
} from "@/stores/home/landing-draft-store";
import { useLandingReturnedSandbox } from "@/hooks/sandboxes/use-returned-sandbox-stage";
import type { ReturnedSandbox } from "@/lib/sandboxes/returned-sandbox";

const mocks = vi.hoisted(() => ({
  user: null as AuthenticatedUser | null,
  catalogue: null as SandboxCatalogue | null,
  defaults: {} as Record<string, SandboxConfigurationDefaults>,
  costs: null as UserSandboxCost | null,
  openSettings: vi.fn<(opts: { readonly section: string | null }) => void>(),
}));

vi.mock("@/hooks/auth/use-auth-user-query", () => ({
  useAuthUser: () => ({ data: mocks.user }),
}));
vi.mock("@/hooks/sandboxes/use-sandbox-catalogue-query", () => ({
  useSandboxCatalogue: () => ({ data: mocks.catalogue }),
}));
vi.mock("@/hooks/sandboxes/use-sandbox-costs-query", () => ({
  useSandboxCosts: () => ({ data: mocks.costs }),
}));
vi.mock("@/hooks/sandboxes/use-sandbox-defaults", () => ({
  useSandboxDefaultsLookup: () => (key: string) => mocks.defaults[key] ?? null,
}));
// The open task's chats name the agent that created an agent sandbox.
vi.mock("@/hooks/use-epic-store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/hooks/use-epic-store")>()),
  useMaybeEpicStore: (
    selector: (state: unknown) => unknown,
    _fallback: unknown,
  ) =>
    selector({
      chats: {
        byId: {
          "agent-26": {
            id: "agent-26",
            title: "Create Sandbox e2e-sbx-agent26",
          },
        },
      },
      tuiAgents: { byId: {} },
    }),
}));
vi.mock("@/stores/tabs/use-system-tab-modal", () => ({
  useSystemTabModalActions: () => ({ openSettings: mocks.openSettings }),
}));

const SURFACE = "landing:window-test";
const MEMORY_HOST = "laptop";

const PROVIDER: SandboxCatalogueProvider = {
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
  shapes: null,
  dockerInGuest: true,
  creatable: true,
  notCreatableReason: null,
  regions: [
    {
      id: "us-east",
      label: "US East",
      fromPriceMcPerHour: { awakeMc: 120, suspendedMc: 4, stoppedMc: 2 },
      pricing: null,
    },
  ],
};

const CATALOGUE: SandboxCatalogue = { providers: [PROVIDER] };

const DEFAULT_SHAPE: StageShape = {
  os: "linux",
  cpus: 2,
  memoryMb: 4096,
  diskMb: null,
  region: "us-east",
  idleMinutes: 30,
  destroyAfterRestingMinutes: 10_080,
};

const TEAM_DEFAULTS: SandboxConfigurationDefaults = {
  os: "linux",
  cpus: 4,
  memoryMb: 8192,
  diskMb: 40_960,
  idleMinutes: 2,
  restingMinutes: 120,
};

function teamOwnedItem(): HostListItem {
  return {
    hostId: "team-box",
    displayName: "team-box",
    platform: "linux",
    kind: "sandbox",
    publicKey: "pk",
    createdAt: "2026-10-01T00:00:00.000Z",
    updatePolicy: "manual",
    status: {
      connectivity: "connectable",
      viewerReachability: "unknown",
      clientCloud: "ok",
      updateState: "current",
      appVersion: "1.5.0",
      lastSeenAt: null,
    },
    owner: { kind: "team", id: "team-1", name: "acme" },
  };
}

function sandboxHost(
  hostId: string,
  sandbox: Partial<HostScopeSandbox> & Pick<HostScopeSandbox, "state">,
  item: HostListItem | null,
): HostScopeOption {
  return hostScopeOptionFixture({
    hostId,
    name: hostId,
    isLocalMachine: false,
    isActive: false,
    connectable: sandbox.state === "awake",
    kind: "sandbox",
    item,
    sandbox: {
      frozen: false,
      summary: sandboxSummaryFixture({ id: `sbx-${hostId}`, hostId }),
      teamOwned: item !== null,
      ...sandbox,
    },
  });
}

const LAPTOP = hostScopeOptionFixture({ hostId: MEMORY_HOST, name: "Laptop" });
const SUSPENDED = sandboxHost("box-suspended", { state: "suspended" }, null);
const STOPPED = sandboxHost("box-stopped", { state: "stopped" }, null);
const AWAKE = sandboxHost("box-awake", { state: "awake" }, null);
const FROZEN = sandboxHost(
  "box-frozen",
  { state: "suspended", frozen: true },
  null,
);
const TEAM_SUSPENDED = sandboxHost(
  "team-box",
  { state: "suspended" },
  teamOwnedItem(),
);

let latest: SandboxStaging | null = null;

function Harness(props: {
  readonly surfaceKey: string | null;
  readonly hosts: readonly HostScopeOption[];
}) {
  const result = useSandboxStaging({
    surface:
      props.surfaceKey === null
        ? null
        : {
            surfaceKey: props.surfaceKey,
            task: null,
            openTerminalInstead: null,
          },
    memoryHostId: MEMORY_HOST,
    hosts: props.hosts,
    forkOnNew: null,
  });
  useEffect(() => {
    latest = result;
  }, [result]);
  return result === null ? null : result.sheet;
}

function mount(hosts: readonly HostScopeOption[]): SandboxStaging {
  render(<Harness surfaceKey={SURFACE} hosts={hosts} />);
  return staging();
}

function staging(): SandboxStaging {
  if (latest === null) throw new Error("the surface staged nothing");
  return latest;
}

beforeEach(() => {
  localStorage.clear();
  mocks.user = userWith(
    userSubscription({
      totalPlanCredits: 1_000,
      consumedFromPlan: 0,
      bonusCredits: 0,
      consumedFromBonus: 0,
      bundleRemaining: 0,
    }),
    [teamSubscription(1_000)],
  );
  mocks.catalogue = CATALOGUE;
  mocks.defaults = {};
  mocks.costs = null;
  mocks.openSettings.mockClear();
  useStagedSandboxStore.setState({ bySurface: {} });
  usePendingSandboxSendStore.setState({ sends: {} });
  useSandboxShapeMemoryStore.setState({
    byHost: {},
    lastConfigurationByHost: {},
  });
  useAuthStore.setState({
    status: "signed-in",
    contextMetadata: { userId: "u1", username: "ada" },
  });
  latest = null;
});

afterEach(() => {
  cleanup();
  useAuthStore.setState({ status: "signed-out", contextMetadata: null });
});

describe("a staged name at create", () => {
  async function createFromStage(
    action: "send" | "terminal" | "pending-terminal",
  ): Promise<SandboxCreateRequest> {
    const runnerHost = createFakeRunnerHost({});
    const auth = new AuthService({ runnerHost });
    const directory = new HostDirectoryService({
      runnerHost,
      remoteFetcher: null,
      onRegistryPollTick: null,
      authContextId: null,
      credentialGeneration: null,
      localHostIdSeeder: () => Promise.resolve(null),
    });
    const create = vi
      .spyOn(auth, "createSandbox")
      .mockResolvedValue(
        refusal(402, SANDBOX_REFUSAL_CODE_INSUFFICIENT_CREDIT),
      );
    const client = new QueryClient();
    let completed = Promise.resolve();
    let pendingId: string | null = null;
    const runner: StagedSandboxRunner = (surfaceKey, fresh, request) => {
      completed = runStagedSandbox(surfaceKey, fresh, request, {
        auth,
        directory,
        queryClient: client,
        userId: null,
        wake: () => Promise.resolve(false),
        readSettings: () => Promise.resolve("unsupported"),
        now: Date.now,
        sleep: () => Promise.resolve(),
      });
    };
    try {
      if (action === "terminal") openLandingStagedTerminal(SURFACE, runner);
      else {
        pendingId = handPendingSandboxSend({
          fromSurfaceKey: SURFACE,
          epicId: "epic-1",
          request:
            action === "pending-terminal"
              ? { kind: "terminal" }
              : { kind: "chat", parentId: null, placement: null },
          content: MESSAGE_CONTENT,
          text: action === "pending-terminal" ? "" : "a different message name",
          settings: PICKED_SETTINGS,
          epicConfirmed: true,
          now: Date.now(),
        });
        if (pendingId === null) throw new Error("expected a handed stage");
        runner(pendingSendSurfaceKey(pendingId), true, {
          taskId: "epic-1",
          resume: false,
        });
      }
      await completed;
      expect(create).toHaveBeenCalledTimes(1);
      return create.mock.calls[0][0];
    } finally {
      if (pendingId !== null) endPendingSandboxSend(pendingId);
      directory.dispose();
      auth.dispose();
      client.clear();
      create.mockRestore();
    }
  }

  it.each([
    { action: "terminal", reselect: false },
    { action: "terminal", reselect: true },
    { action: "pending-terminal", reselect: true },
  ] as const)(
    "$action keeps the applied typed name (reselect New: $reselect)",
    async ({ action, reselect }) => {
      mount([LAPTOP]);
      act(() => staging().composer.onPickNew("personal"));
      act(() => staging().composer.onOpenShape("personal"));
      fireEvent.change(screen.getByRole("textbox", { name: "Name" }), {
        target: { value: "typed-terminal-box" },
      });
      fireEvent.click(screen.getByRole("button", { name: "Use this shape" }));
      if (reselect) act(() => staging().composer.onPickNew("personal"));

      const request = await createFromStage(action);

      expect(request.displayName).toBe("typed-terminal-box");
    },
  );

  it.each(["send", "terminal", "pending-terminal"] as const)(
    "%s uses the generated name shown in the untouched stage's shape sheet",
    async (action) => {
      mount([LAPTOP]);
      act(() => staging().composer.onPickNew("personal"));
      act(() => staging().composer.onOpenShape("personal"));
      const name = screen.getByRole<HTMLInputElement>("textbox", {
        name: "Name",
      }).value;
      fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
      const request = await createFromStage(action);

      expect(name).toMatch(/^sandbox-[a-z0-9]{4}$/);
      expect(request.displayName).toBe(name);
    },
  );
});

describe("useSandboxStaging New rows", () => {
  it("offers Personal then each team, with the shape, price and whose credits", () => {
    const { composer } = mount([LAPTOP]);

    expect(composer.newRows.map((row) => row.configurationKey)).toEqual([
      "personal",
      "team-1",
    ]);
    expect(composer.newRows[0]).toMatchObject({
      label: "New Personal sandbox",
      configuration: { kind: "personal" },
    });
    expect(composer.newRows[1].label).toBe("New acme sandbox");
    expect(composer.newRows[1].subLine).toContain("uses your acme credits");
    expect(composer.newRows[0].subLine).toContain("2 vCPU");
  });

  describe("sub-line, from a catalogue pricing its 2 vCPU · 4 GB shape at $0.21", () => {
    const PRICED_CATALOGUE: SandboxCatalogue = {
      providers: [
        {
          ...PROVIDER,
          shapes: [
            { cpus: 2, memoryMb: 4096, diskMb: 20480, default: true },
            { cpus: 4, memoryMb: 8192, diskMb: 20480, default: false },
          ],
          regions: [
            {
              id: "us-east",
              label: "US East",
              fromPriceMcPerHour: {
                awakeMc: 210,
                suspendedMc: 4,
                stoppedMc: 2,
              },
              pricing: null,
            },
          ],
        },
      ],
    };

    function withBalances(personalCredits: number, teamCredits: number): void {
      mocks.catalogue = PRICED_CATALOGUE;
      mocks.user = userWith(
        userSubscription({
          totalPlanCredits: personalCredits,
          consumedFromPlan: 0,
          bonusCredits: 0,
          consumedFromBonus: 0,
          bundleRemaining: 0,
        }),
        [teamSubscription(teamCredits)],
      );
    }

    it("names the OS and the full price, and whose credits, at a short balance", () => {
      withBalances(0, 0);
      const { composer } = mount([LAPTOP]);

      expect(composer.newRows[0].subLine).toBe(
        "Linux · 2 vCPU · 4 GB · from $0.21 an hour · uses your credits",
      );
      expect(composer.newRows[1].subLine).toBe(
        "Linux · 2 vCPU · 4 GB · from $0.21 an hour · uses your acme credits",
      );
    });

    it("names the OS and the exact price while awake when funded", () => {
      withBalances(1_000, 1_000);
      const { composer } = mount([LAPTOP]);

      expect(composer.newRows[0].subLine).toBe(
        "Linux · 2 vCPU · 4 GB · $0.21 an hour while awake · uses your credits",
      );
      expect(composer.newRows[1].subLine).toBe(
        "Linux · 2 vCPU · 4 GB · $0.21 an hour while awake · uses your acme credits",
      );
    });
  });

  it("stages a new sandbox in the default shape and remembers the configuration", () => {
    const { composer } = mount([LAPTOP]);

    act(() => composer.onPickNew("personal"));

    const stage = readStagedSandbox(SURFACE);
    expect(stage).toMatchObject({
      phase: "staged",
      clientRequestId: null,
      target: {
        kind: "new",
        configuration: { kind: "personal" },
        shape: DEFAULT_SHAPE,
        wakeString: WAKE_STRING_MEMORY,
      },
    });
    expect(
      useSandboxShapeMemoryStore.getState().lastConfigurationByHost[
        MEMORY_HOST
      ],
    ).toBe("personal");
    expect(staging().composer.stagedConfigurationKey).toBe("personal");
  });

  it("stages the configuration's defaults, shape and periods, for everyone who picks a New row", () => {
    mocks.defaults = { "team-1": TEAM_DEFAULTS };
    const { composer } = mount([LAPTOP]);

    expect(composer.newRows[1].subLine).toContain("4 vCPU");
    act(() => composer.onPickNew("team-1"));

    expect(readStagedSandbox(SURFACE)?.target).toMatchObject({
      kind: "new",
      configuration: { kind: "team", teamId: "team-1", teamName: "acme" },
      shape: {
        cpus: 4,
        memoryMb: 8192,
        idleMinutes: 2,
        destroyAfterRestingMinutes: 120,
      },
    });
  });

  it("stages the configuration's defaults, not the person's remembered pick", () => {
    mocks.defaults = { "team-1": TEAM_DEFAULTS };
    useSandboxShapeMemoryStore.getState().remember(MEMORY_HOST, "team-1", {
      ...DEFAULT_SHAPE,
      cpus: 8,
      memoryMb: 16_384,
      idleMinutes: 45,
    });
    const { composer } = mount([LAPTOP]);

    act(() => composer.onPickNew("team-1"));

    expect(readStagedSandbox(SURFACE)?.target).toMatchObject({
      shape: { cpus: 4, memoryMb: 8192, idleMinutes: 2 },
    });
  });

  it("opens the gear on the person's remembered pick over the configuration's defaults", () => {
    mocks.defaults = { personal: TEAM_DEFAULTS };
    useSandboxShapeMemoryStore.getState().remember(MEMORY_HOST, "personal", {
      ...DEFAULT_SHAPE,
      idleMinutes: 45,
    });
    const { composer } = mount([LAPTOP]);

    act(() => composer.onOpenShape("personal"));

    expect(screen.getByText(idleAndRestingLine(45, 10_080))).toBeDefined();
    // Cancel closes the sheet, clearing the open configuration it is keyed by.
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  });

  it("opens the gear on the configuration's defaults when the person remembered nothing", () => {
    mocks.defaults = { personal: TEAM_DEFAULTS };
    const { composer } = mount([LAPTOP]);

    act(() => composer.onOpenShape("personal"));

    expect(screen.getByText(idleAndRestingLine(2, 120))).toBeDefined();
    // Cancel closes the sheet, clearing the open configuration it is keyed by.
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  });

  it("stages nothing while the catalogue has not answered", () => {
    mocks.catalogue = null;
    const { composer } = mount([LAPTOP]);

    act(() => composer.onPickNew("personal"));

    expect(readStagedSandbox(SURFACE)).toBeNull();
  });

  it("offers the New rows disabled, saying why, when the catalogue offers nothing", () => {
    mocks.catalogue = { providers: [] };
    const { composer } = mount([LAPTOP]);

    expect(composer.newRows[0]).toMatchObject({
      disabled: true,
      subLine: SANDBOXES_CANT_BE_CREATED,
    });
    act(() => composer.onPickNew("personal"));
    expect(readStagedSandbox(SURFACE)).toBeNull();
  });

  it("drops the chip's spinner when the staged create is refused", () => {
    const { composer } = mount([LAPTOP]);
    act(() => composer.onPickNew("personal"));
    act(() => {
      useStagedSandboxStore.getState().begin(SURFACE, false, Date.now(), false);
    });
    expect(staging().composer.stagedBusy).toBe(true);

    act(() => {
      useStagedSandboxStore
        .getState()
        .report(SURFACE, { failure: { kind: "credits", shortfallMc: 120 } });
    });

    expect(staging().composer.stagedBusy).toBe(false);
  });

  it("reads the staged chip, and needs credits at a short balance", () => {
    mocks.user = userWith(
      userSubscription({
        totalPlanCredits: 0,
        consumedFromPlan: 0,
        bonusCredits: 0,
        consumedFromBonus: 0,
        bundleRemaining: 0,
      }),
      [],
    );
    const { composer } = mount([LAPTOP]);
    expect(composer.newRows[0].label).toBe(
      "New Personal sandbox · needs credits",
    );

    act(() => composer.onPickNew("personal"));

    expect(staging().consequences).toMatchObject({
      configuration: { kind: "personal" },
      needsCredits: true,
      audience: "private",
    });
  });

  it("tells a team sandbox on the landing composer as shared", () => {
    const { composer } = mount([LAPTOP]);

    act(() => composer.onPickNew("team-1"));

    expect(staging().consequences).toMatchObject({
      configuration: { kind: "team", teamId: "team-1", teamName: "acme" },
      audience: "shared",
      price: { awakeMcPerHour: 120, exact: false },
    });
  });
});

describe("useSandboxStaging In this task", () => {
  it("lists every host the task uses, an agent's burst sandbox included, but never Automations", () => {
    const burst = sandboxHost(
      "box-burst",
      {
        state: "awake",
        summary: sandboxSummaryFixture({
          id: "sbx-box-burst",
          hostId: "box-burst",
          burst: true,
        }),
      },
      null,
    );
    // A chat on Automations puts it in the task; it is still never a row.
    const automations = sandboxHost(
      "box-automations",
      {
        state: "awake",
        summary: sandboxSummaryFixture({
          id: "sbx-automations",
          hostId: "box-automations",
          kind: "automation",
        }),
      },
      null,
    );
    // A teammate's team sandbox the task ran on is a host it uses.
    const teammates = sandboxHost(
      "team-box",
      {
        state: "awake",
        summary: sandboxSummaryFixture({
          id: "sbx-team-box",
          hostId: "team-box",
          createdBy: { userId: "u2", displayName: "Grace" },
        }),
      },
      teamOwnedItem(),
    );
    const task: SandboxStagingTask = {
      epicId: "epic-1",
      hosts: [AWAKE, burst, automations, teammates].map((host) => ({
        hostId: host.hostId,
        label: host.name,
        principal: { kind: "user", id: "u1" },
        reach: "same_principal",
        sandboxEnd: null,
      })),
      groups: [],
      collaborators: null,
    };
    function InTask() {
      const result = useSandboxStaging({
        surface: { surfaceKey: SURFACE, task, openTerminalInstead: null },
        memoryHostId: MEMORY_HOST,
        hosts: [LAPTOP, AWAKE, burst, automations, teammates],
        forkOnNew: null,
      });
      useEffect(() => {
        latest = result;
      }, [result]);
      return null;
    }
    render(<InTask />);

    expect(staging().composer.inThisTask?.map((host) => host.hostId)).toEqual([
      "box-awake",
      "box-burst",
      "team-box",
    ]);
  });
});

describe("useSandboxStaging sandbox rows' lines", () => {
  function cost(sandboxId: string, todayMillicredits: number): SandboxCost {
    return {
      sandboxId,
      currentRateMillicreditsPerHour: 0,
      state: "awake",
      frozen: false,
      charged: {
        computeMillicredits: 0,
        storageMillicredits: 0,
        sinceCreatedAt: 0,
      },
      pendingMillicredits: 0,
      segments: [],
      todayMillicredits,
      todayAwakeMs: null,
      history: [],
    };
  }

  function lineOf(host: HostScopeOption): readonly string[] {
    return mount([LAPTOP, host]).composer.subLinesFor(host.hostId);
  }

  it("says whose a Personal sandbox is and what it cost today", () => {
    mocks.costs = {
      sandboxes: [cost("sbx-box-awake", 30)],
      awakeBurnMillicreditsPerHour: 0,
      todayYoursMillicredits: 30,
      todayByEnvironment: [],
    };

    expect(lineOf(AWAKE)).toEqual(["Personal · $0.03 today"]);
  });

  it("names the team on a team sandbox's line", () => {
    mocks.costs = {
      sandboxes: [cost("sbx-team-box", 50)],
      awakeBurnMillicreditsPerHour: 0,
      todayYoursMillicredits: 0,
      todayByEnvironment: [],
    };
    const awakeTeamBox = sandboxHost(
      "team-box",
      { state: "awake" },
      teamOwnedItem(),
    );

    expect(lineOf(awakeTeamBox)).toEqual([
      "Linux · 2 vCPU · 4 GB · $0.12 an hour while awake",
      "acme · $0.05 today",
    ]);
  });
});

describe("a returned sandbox on the open landing draft", () => {
  const DRAFT_ID = "draft-returned";
  const RETURNED: ReturnedSandbox = {
    target: {
      kind: "existing",
      hostId: "box-suspended",
      sandboxId: "sbx-box-suspended",
      name: "box-suspended",
      configuration: { kind: "personal" },
      verb: "resume",
    },
    clientRequestId: null,
  };

  function ReturnedDraft(): null {
    useLandingReturnedSandbox(SURFACE, DRAFT_ID, true);
    return null;
  }

  beforeEach(() => {
    useLandingDraftStore.setState({ drafts: [], activeDraftId: null });
    useLandingDraftStore.getState().installLandingDraft({
      id: DRAFT_ID,
      content: MESSAGE_CONTENT,
      selection: null,
      lastTouchedAt: Date.now(),
      settings: PICKED_SETTINGS,
      composerMode: "chat",
      workspace: emptyLandingDraftWorkspaceSnapshot(),
      closed: false,
    });
    useLandingDraftStore.getState().setDraftReturnedSandbox(DRAFT_ID, RETURNED);
  });

  afterEach(() => {
    useLandingDraftStore.setState({ drafts: [], activeDraftId: null });
  });

  it("gives way to the person's awake-host pick, and is never staged over it", () => {
    // The window already holds another stage when the draft opens.
    useStagedSandboxStore.getState().stage(SURFACE, {
      kind: "existing",
      hostId: "box-stopped",
      sandboxId: "sbx-box-stopped",
      name: "box-stopped",
      configuration: { kind: "personal" },
      verb: "start",
    });
    render(
      <>
        <Harness surfaceKey={SURFACE} hosts={[AWAKE, SUSPENDED, STOPPED]} />
        <ReturnedDraft />
      </>,
    );
    expect(readStagedSandbox(SURFACE)?.target).toMatchObject({
      sandboxId: "sbx-box-stopped",
    });

    act(() => staging().composer.onPickHost(AWAKE));

    expect(readStagedSandbox(SURFACE)).toBeNull();
    expect(
      useLandingDraftStore
        .getState()
        .drafts.find((draft) => draft.id === DRAFT_ID)?.returnedSandbox,
    ).toBeNull();
  });
});

describe("useSandboxStaging host picks", () => {
  it("stages a suspended sandbox of the person's to resume, with no create", () => {
    const { composer } = mount([LAPTOP, SUSPENDED]);

    act(() => composer.onPickHost(SUSPENDED));

    expect(readStagedSandbox(SURFACE)).toMatchObject({
      phase: "staged",
      clientRequestId: null,
      target: {
        kind: "existing",
        hostId: "box-suspended",
        sandboxId: "sbx-box-suspended",
        name: "box-suspended",
        configuration: { kind: "personal" },
        verb: "resume",
      },
    });
    expect(staging().composer.stagedLabel).toContain("suspended");
  });

  it("reads the suspended label until the wake is ticked, then 'awake' as the stage moves past booting", () => {
    const { composer } = mount([LAPTOP, SUSPENDED]);
    act(() => composer.onPickHost(SUSPENDED));
    const store = useStagedSandboxStore.getState();
    store.begin(SURFACE, false, Date.now(), false);
    store.report(SURFACE, { step: "booting", stepAt: Date.now() });
    expect(staging().composer.stagedLabel).toBe(
      "box-suspended · suspended, resumes on send",
    );

    act(() => store.report(SURFACE, { step: "applying", stepAt: Date.now() }));
    expect(staging().composer.stagedLabel).toBe("box-suspended · awake");

    act(() =>
      store.report(SURFACE, { step: "delivering", stepAt: Date.now() }),
    );
    expect(staging().composer.stagedLabel).toBe("box-suspended · awake");
  });

  it("reads 'awake' for a started sandbox once its stage is at its handoff", () => {
    const { composer } = mount([LAPTOP, STOPPED]);
    act(() => composer.onPickHost(STOPPED));
    const store = useStagedSandboxStore.getState();
    store.begin(SURFACE, false, Date.now(), false);

    act(() => store.report(SURFACE, { phase: "handoff", step: "delivering" }));

    expect(staging().composer.stagedLabel).toBe("box-stopped · awake");
  });

  it("stages a stopped sandbox to start", () => {
    const { composer } = mount([LAPTOP, STOPPED]);

    act(() => composer.onPickHost(STOPPED));

    expect(readStagedSandbox(SURFACE)?.target).toMatchObject({
      kind: "existing",
      verb: "start",
    });
    expect(staging().composer.stagedLabel).toContain("stopped");
  });

  it.each([
    { state: "suspending", verb: "resume" },
    { state: "stopping", verb: "start" },
  ] as const)(
    "stages a sandbox still $state to $verb, so the first send wakes it",
    ({ state, verb }) => {
      const moving = sandboxHost("box-moving", { state }, null);
      const { composer } = mount([LAPTOP, moving]);

      act(() => composer.onPickHost(moving));

      expect(readStagedSandbox(SURFACE)?.target).toMatchObject({
        kind: "existing",
        hostId: "box-moving",
        verb,
      });
    },
  );

  it("stages a team's sandbox under its team", () => {
    const { composer } = mount([LAPTOP, TEAM_SUSPENDED]);

    act(() => composer.onPickHost(TEAM_SUSPENDED));

    expect(readStagedSandbox(SURFACE)?.target).toMatchObject({
      kind: "existing",
      configuration: { kind: "team", teamId: "team-1", teamName: "acme" },
    });
  });

  it.each([
    ["a personal computer", LAPTOP],
    ["an awake sandbox", AWAKE],
    ["a frozen sandbox", FROZEN],
  ])("clears the stage when %s is picked", (_name, host) => {
    const { composer } = mount([LAPTOP, AWAKE, FROZEN, SUSPENDED]);
    act(() => composer.onPickNew("personal"));
    expect(readStagedSandbox(SURFACE)).not.toBeNull();

    act(() => staging().composer.onPickHost(host));

    expect(readStagedSandbox(SURFACE)).toBeNull();
    expect(staging().composer.stagedLabel).toBeNull();
  });

  it("replaces a staged new sandbox with the resting one picked after it", () => {
    const { composer } = mount([LAPTOP, SUSPENDED]);
    act(() => composer.onPickNew("personal"));

    act(() => staging().composer.onPickHost(SUSPENDED));

    expect(readStagedSandbox(SURFACE)?.target.kind).toBe("existing");
  });
});

describe("useSandboxStaging In this task, agent sandboxes the task's hosts omit", () => {
  function agentSandbox(
    hostId: string,
    createdByTaskId: string,
  ): HostScopeOption {
    return sandboxHost(
      hostId,
      {
        state: "awake",
        summary: sandboxSummaryFixture({
          id: `sbx-${hostId}`,
          hostId,
          burst: true,
          idleMinutes: 30,
          createdByTaskId,
          createdByAgentId: "agent-26",
        }),
      },
      null,
    );
  }

  function InTask(props: { readonly hosts: readonly HostScopeOption[] }) {
    const result = useSandboxStaging({
      surface: {
        surfaceKey: SURFACE,
        // The task's hosts list is empty of every sandbox here: none owns a
        // chat on the task yet.
        task: { epicId: "epic-1", hosts: [], groups: [], collaborators: null },
        openTerminalInstead: null,
      },
      memoryHostId: MEMORY_HOST,
      hosts: props.hosts,
      forkOnNew: null,
    });
    useEffect(() => {
      latest = result;
    }, [result]);
    return null;
  }

  it("lists the agent sandbox created for the task, with who created it and when it goes", () => {
    const mine = agentSandbox("box-agent26", "epic-1");
    render(<InTask hosts={[LAPTOP, mine]} />);

    expect(staging().composer.inThisTask?.map((host) => host.hostId)).toEqual([
      "box-agent26",
    ]);
    expect(staging().composer.subLinesFor("box-agent26")).toEqual([
      "Agent sandbox · created by Create Sandbox e2e-sbx-agent26 · destroys itself after 30 idle min",
    ]);
  });

  it("leaves out an agent sandbox created for another task", () => {
    const theirs = agentSandbox("box-other", "epic-other");
    render(<InTask hosts={[LAPTOP, theirs]} />);

    expect(staging().composer.inThisTask).toEqual([]);
  });
});

describe("useSandboxStaging a staged resting sandbox's block", () => {
  const PRICED = { awakeMc: 210, suspendedMc: 4, stoppedMc: 2 };

  function pricedHost(
    hostId: string,
    state: "suspended" | "stopped",
    item: HostListItem | null,
  ): HostScopeOption {
    return sandboxHost(
      hostId,
      {
        state,
        summary: sandboxSummaryFixture({
          id: `sbx-${hostId}`,
          hostId,
          state,
          priceMcPerHour: PRICED,
        }),
      },
      item,
    );
  }

  function stagedPrice(host: HostScopeOption): string {
    const { composer } = mount([LAPTOP, host]);
    act(() => composer.onPickHost(host));
    const { consequences } = staging();
    if (consequences === null) throw new Error("nothing was staged");
    render(
      <ConsequencesBlock
        input={consequences}
        onMoveFirst={null}
        onOpenTerminalInstead={null}
      />,
    );
    return screen.getByTestId("consequences-price").textContent;
  }

  it("prices a suspended Personal sandbox from its own row", () => {
    expect(stagedPrice(pricedHost("box-suspended", "suspended", null))).toBe(
      "$0.21 an hour while awake · uses your credits",
    );
  });

  it("prices a stopped Personal sandbox from its own row", () => {
    expect(stagedPrice(pricedHost("box-stopped", "stopped", null))).toBe(
      "$0.21 an hour while awake · uses your credits",
    );
  });

  it("names the team on a team sandbox's price", () => {
    expect(
      stagedPrice(pricedHost("team-box", "suspended", teamOwnedItem())),
    ).toBe("Waking team-box uses your acme allowance and makes you the payer.");
  });
});

describe("useSandboxStaging surfaces", () => {
  it("stages nothing for a picker that is not a composer's", () => {
    render(<Harness surfaceKey={null} hosts={[LAPTOP]} />);
    expect(latest).toBeNull();
  });

  it("opens Settings › Sandboxes on Personal when nothing is staged", () => {
    useSandboxesPageStore.setState({
      requestedConfiguration: { kind: "team", teamId: "stale-team" },
    });
    const { composer } = mount([LAPTOP]);

    composer.onManage();

    expect(mocks.openSettings).toHaveBeenCalledTimes(1);
    expect(mocks.openSettings.mock.calls[0][0].section).toBe("sandboxes");
    expect(useSandboxesPageStore.getState().requestedConfiguration).toEqual({
      kind: "personal",
    });
  });

  it("opens Settings › Sandboxes on the staged configuration", () => {
    mount([LAPTOP, TEAM_SUSPENDED]);
    act(() => staging().composer.onPickHost(TEAM_SUSPENDED));
    const staged = readStagedSandbox(SURFACE)?.target.configuration;
    if (staged?.kind !== "team") throw new Error("expected a team stage");

    act(() => staging().composer.onManage());

    expect(mocks.openSettings.mock.calls[0][0].section).toBe("sandboxes");
    expect(useSandboxesPageStore.getState().requestedConfiguration).toEqual({
      kind: "team",
      teamId: staged.teamId,
    });
  });
});
