import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  onTestFinished,
  vi,
} from "vitest";
import { QueryClient } from "@tanstack/react-query";
import type {
  SandboxCreateRequest,
  SandboxSummary,
} from "@traycer/protocol/host/sandbox-control";
import {
  SANDBOX_REFUSAL_CODE_INSUFFICIENT_CREDIT,
  SANDBOX_REFUSAL_CODE_PROVIDER_UNAVAILABLE,
  SANDBOX_REFUSAL_CODE_SHAPE_NOT_OFFERED,
} from "@traycer/protocol/host/sandbox-control";
import type { HostDirectoryEntry } from "@traycer-clients/shared/host-client/host-directory";
import type {
  SandboxCreateFetchResult,
  SandboxListFetchResult,
} from "@traycer-clients/shared/host-client/sandbox-control";
import type { TeamEnvironmentFetchResult } from "@traycer-clients/shared/host-client/sandbox-secrets";
import { AuthService } from "@/lib/auth/auth-service";
import { HostDirectoryService } from "@/lib/host";
import {
  createFailure,
  runStagedSandbox,
  settleVerdict,
  STAGED_CREATE_BUDGET_MS,
  type StagedSandboxRunDeps,
} from "@/lib/sandboxes/staged-sandbox-run";
import { useSurfaceHostSelectionStore } from "@/stores/host/surface-host-selection-store";
import { useLandingPanelStore } from "@/stores/home/landing-panel-store";
import {
  holdHandoffOwner,
  ownerGoneOnUnmount,
  readStagedSandbox,
  useStagedSandboxStore,
  type StagedSandboxTarget,
} from "@/stores/composer/staged-sandbox-store";
import { sandboxSummaryFixture } from "@/hooks/sandboxes/__tests__/sandbox-fixtures";
import { refusal } from "@/hooks/sandboxes/__tests__/sandbox-binding-fixture";
import { createFakeRunnerHost } from "../../../../__tests__/create-fake-runner-host";
import { authQueryKeys } from "@/lib/query-keys";

const NEW_HOST_ID = "host-new";
const SANDBOX_ID = "sbx_new";

const SHAPE = {
  os: "linux",
  cpus: 2,
  memoryMb: 4096,
  diskMb: null,
  region: "us-east",
  idleMinutes: 30,
  destroyAfterRestingMinutes: 4_320,
} as const;

const PERSONAL_NEW: StagedSandboxTarget = {
  kind: "new",
  configuration: { kind: "personal" },
  shape: SHAPE,
  name: "",
  wakeString: null,
};

const TEAM_NEW: StagedSandboxTarget = {
  kind: "new",
  configuration: { kind: "team", teamId: "team-acme", teamName: "Acme" },
  shape: SHAPE,
  name: "review-box",
  wakeString: null,
};

const RESTING: StagedSandboxTarget = {
  kind: "existing",
  hostId: "host-resting",
  sandboxId: "sbx_resting",
  name: "build-box",
  configuration: { kind: "personal" },
  verb: "resume",
};

function row(overrides: Partial<SandboxSummary>): SandboxSummary {
  return sandboxSummaryFixture({
    id: SANDBOX_ID,
    hostId: NEW_HOST_ID,
    ...overrides,
  });
}

const DIALABLE: HostDirectoryEntry = {
  hostId: NEW_HOST_ID,
  label: "review-box",
  kind: "remote",
  websocketUrl: "ws://host-new.test",
  version: null,
  transportDialability: "dialable",
};

/** The control plane's answers, scripted per test. */
interface Script {
  createSandbox: (request: SandboxCreateRequest) => SandboxCreateFetchResult;
  teamEnvironment: TeamEnvironmentFetchResult;
  /** One list answer per read; the last repeats. */
  lists: SandboxListFetchResult[];
  /** One directory answer per `findById`; the last repeats. */
  entries: Array<HostDirectoryEntry | null>;
}

const created: SandboxCreateFetchResult = {
  kind: "ok",
  accepted: {
    sandboxId: SANDBOX_ID,
    hostId: NEW_HOST_ID,
    sandbox: row({ state: "creating" }),
  },
};

function listOf(summary: SandboxSummary): SandboxListFetchResult {
  return { kind: "ok", response: { sandboxes: [summary] } };
}

function scriptFor(overrides: Partial<Script>): Script {
  return {
    createSandbox: () => created,
    teamEnvironment: { kind: "ok", environmentId: "env-acme" },
    lists: [listOf(row({ state: "awake", guestConfigured: true }))],
    entries: [DIALABLE],
    ...overrides,
  };
}

/** The real `AuthService`, its three sandbox reads answered by the script. */
class ScriptedAuth extends AuthService {
  readonly requests: SandboxCreateRequest[] = [];
  readonly environmentReads: string[] = [];
  listReads = 0;
  private readonly answers: Script;

  constructor(answers: Script) {
    super({ runnerHost: createFakeRunnerHost({}) });
    this.answers = answers;
  }

  override createSandbox(
    request: SandboxCreateRequest,
  ): Promise<SandboxCreateFetchResult> {
    this.requests.push(request);
    return Promise.resolve(this.answers.createSandbox(request));
  }

  override getTeamEnvironment(
    teamId: string,
  ): Promise<TeamEnvironmentFetchResult> {
    this.environmentReads.push(teamId);
    return Promise.resolve(this.answers.teamEnvironment);
  }

  override listSandboxes(): Promise<SandboxListFetchResult> {
    const { lists } = this.answers;
    const answer = lists[Math.min(this.listReads, lists.length - 1)];
    this.listReads += 1;
    return Promise.resolve(answer);
  }
}

/** The real `HostDirectoryService`, its lookups answered by the script. */
class ScriptedDirectory extends HostDirectoryService {
  refreshes = 0;
  lookups = 0;
  private readonly answers: Script;

  constructor(answers: Script) {
    super({
      runnerHost: createFakeRunnerHost({}),
      remoteFetcher: null,
      onRegistryPollTick: null,
      authContextId: null,
      credentialGeneration: null,
      localHostIdSeeder: () => Promise.resolve(null),
    });
    this.answers = answers;
  }

  override refresh(): Promise<readonly HostDirectoryEntry[]> {
    this.refreshes += 1;
    return Promise.resolve([]);
  }

  override findById(): HostDirectoryEntry | null {
    const { entries } = this.answers;
    const answer = entries[Math.min(this.lookups, entries.length - 1)];
    this.lookups += 1;
    return answer;
  }
}

let surfaceCount = 0;
let surfaceKey = "";
const directories: ScriptedDirectory[] = [];

function harness(overrides: Partial<Script>, wakeResult: boolean) {
  const script = scriptFor(overrides);
  const auth = new ScriptedAuth(script);
  const directory = new ScriptedDirectory(script);
  directories.push(directory);
  const clock = { now: 1_000_000, sleeps: 0 };
  const wake = vi.fn<(hostId: string) => Promise<boolean>>(() =>
    Promise.resolve(wakeResult),
  );
  const deps: StagedSandboxRunDeps = {
    auth,
    directory,
    queryClient: new QueryClient({
      defaultOptions: { queries: { retry: false } },
    }),
    userId: null,
    wake,
    now: () => clock.now,
    sleep: (ms) => {
      clock.now += ms;
      clock.sleeps += 1;
      return Promise.resolve();
    },
  };
  return { auth, directory, wake, deps, clock };
}

function run(fresh: boolean, deps: StagedSandboxRunDeps): Promise<void> {
  // A run starts from a send, made by a draft whose composer is mounted,
  // unless the case set up its own ask.
  const stage = readStagedSandbox(surfaceKey);
  if (stage !== null && !stage.sendTaken && !stage.openTerminal) {
    useStagedSandboxStore.getState().report(surfaceKey, { sendTaken: true });
    onTestFinished(holdHandoffOwner(surfaceKey, null, ownerGoneOnUnmount));
  }
  return runStagedSandbox(
    surfaceKey,
    fresh,
    { fallbackName: "fallback-box", taskId: null, resume: false },
    deps,
  );
}

function stageOf() {
  const stage = readStagedSandbox(surfaceKey);
  if (stage === null) throw new Error("nothing staged");
  return stage;
}

beforeEach(() => {
  surfaceCount += 1;
  surfaceKey = `landing:test-${surfaceCount}`;
  useStagedSandboxStore.setState({ bySurface: {} });
  useSurfaceHostSelectionStore.setState({ selections: {} });
  useLandingPanelStore.getState().resetForTests();
});

afterEach(() => {
  while (directories.length > 0) directories.pop()?.dispose();
});

describe("runStagedSandbox creating", () => {
  it("sends the create with the stage's idempotency key, no task, not burst, and the resting window", async () => {
    useStagedSandboxStore.getState().stage(surfaceKey, PERSONAL_NEW);
    const { auth, deps } = harness({}, true);

    await run(false, deps);

    expect(auth.requests).toHaveLength(1);
    const [request] = auth.requests;
    expect(request).toMatchObject({
      os: "linux",
      cpus: 2,
      memoryMb: 4096,
      region: "us-east",
      idleMinutes: 30,
      burst: false,
      createdByTaskId: null,
      createdByHostId: null,
      createdByAgentId: null,
      environmentId: null,
      destroyAfterRestingMinutes: 4_320,
      displayName: "fallback-box",
    });
    expect(request.clientRequestId).not.toBeNull();
    expect(request.clientRequestId).toBe(stageOf().clientRequestId);
    expect(auth.environmentReads).toEqual([]);
  });

  it("sends a resting period the sheet cleared as 0, never as the configuration default", async () => {
    useStagedSandboxStore.getState().stage(surfaceKey, {
      kind: "new",
      configuration: { kind: "personal" },
      shape: { ...SHAPE, destroyAfterRestingMinutes: null },
      name: "",
      wakeString: null,
    });
    const { auth, deps } = harness({}, true);

    await run(false, deps);

    expect(auth.requests[0].destroyAfterRestingMinutes).toBe(0);
  });

  it("names the surface's task on a create made inside one", async () => {
    useStagedSandboxStore.getState().stage(surfaceKey, PERSONAL_NEW);
    const { auth, deps } = harness({}, true);

    await runStagedSandbox(
      surfaceKey,
      false,
      { fallbackName: "fallback-box", taskId: "epic-1", resume: false },
      deps,
    );

    expect(auth.requests[0].createdByTaskId).toBe("epic-1");
  });

  it("creates a team sandbox in the team's environment under the name the sheet set", async () => {
    useStagedSandboxStore.getState().stage(surfaceKey, TEAM_NEW);
    const { auth, deps } = harness({}, true);

    await run(false, deps);

    expect(auth.environmentReads).toEqual(["team-acme"]);
    expect(auth.requests[0]).toMatchObject({
      environmentId: "env-acme",
      displayName: "review-box",
    });
  });

  it("says unavailable and creates nothing when the team's environment cannot be read", async () => {
    useStagedSandboxStore.getState().stage(surfaceKey, TEAM_NEW);
    const { auth, deps } = harness(
      { teamEnvironment: { kind: "not-a-member" } },
      true,
    );

    await run(false, deps);

    expect(auth.requests).toEqual([]);
    expect(stageOf().failure).toEqual({ kind: "unavailable" });
  });

  it("repeats the create with the same key after a refusal, and a fresh run mints a new one", async () => {
    useStagedSandboxStore.getState().stage(surfaceKey, PERSONAL_NEW);
    const { auth, deps } = harness(
      {
        createSandbox: () => ({
          kind: "network-error",
          detail: "the request never completed",
        }),
      },
      true,
    );

    await run(false, deps);
    await run(false, deps);
    await run(true, deps);

    const [first, second, third] = auth.requests.map(
      (request) => request.clientRequestId,
    );
    expect(second).toBe(first);
    expect(third).not.toBe(first);
  });
});

describe("runStagedSandbox through the query cache", () => {
  it("leaves the row it waited on in the list every surface reads", async () => {
    useStagedSandboxStore.getState().stage(surfaceKey, PERSONAL_NEW);
    const { deps } = harness({}, true);

    await run(false, deps);

    // The key holds the live AuthService, whose hash moves with the scripted
    // auth's counters, so the list is found by its prefix.
    expect(
      deps.queryClient
        .getQueriesData({ queryKey: ["auth", "registered-hosts", "sandboxes"] })
        .map(([, data]) => data),
    ).toEqual([
      { sandboxes: [row({ state: "awake", guestConfigured: true })] },
    ]);
  });

  it("refreshes the directory and the lists when the create is refused", async () => {
    useStagedSandboxStore.getState().stage(surfaceKey, PERSONAL_NEW);
    const { directory, deps } = harness(
      { createSandbox: () => refusal(502, "provider_failed") },
      true,
    );
    const invalidate = vi.spyOn(deps.queryClient, "invalidateQueries");

    await run(false, deps);

    expect(directory.refreshes).toBe(1);
    expect(invalidate).toHaveBeenCalledWith({
      queryKey: authQueryKeys.registeredHostsAll(),
    });
  });
});

describe("runStagedSandbox refusals", () => {
  it("stops on a create that threw instead of waiting forever", async () => {
    useStagedSandboxStore.getState().stage(surfaceKey, PERSONAL_NEW);
    const { auth, deps } = harness({}, true);
    vi.spyOn(auth, "createSandbox").mockRejectedValueOnce(
      new Error("createSandbox.request.destroyAfterRestingMinutes"),
    );

    await run(false, deps);

    expect(stageOf().failure).toEqual({ kind: "unverified" });
  });

  it("maps insufficient_credit to the credits failure with the shortfall", async () => {
    useStagedSandboxStore.getState().stage(surfaceKey, PERSONAL_NEW);
    const { deps } = harness(
      {
        createSandbox: () => ({
          ...refusal(402, SANDBOX_REFUSAL_CODE_INSUFFICIENT_CREDIT),
          shortfallMc: 1_200_000,
        }),
      },
      true,
    );

    await run(false, deps);

    expect(stageOf().failure).toEqual({
      kind: "credits",
      shortfallMc: 1_200_000,
    });
    expect(stageOf().phase).toBe("creating");
    expect(useSurfaceHostSelectionStore.getState().selections).toEqual({});
  });

  it.each([
    [
      "an unverifiable balance",
      {
        ...refusal(402, SANDBOX_REFUSAL_CODE_INSUFFICIENT_CREDIT),
        reason: "unverified",
      },
      { kind: "unverified" },
    ],
    [
      "a shape the region does not offer",
      refusal(400, SANDBOX_REFUSAL_CODE_SHAPE_NOT_OFFERED),
      { kind: "shape" },
    ],
    [
      "an unavailable provider",
      refusal(503, SANDBOX_REFUSAL_CODE_PROVIDER_UNAVAILABLE),
      { kind: "unavailable" },
    ],
    [
      "a request that never completed",
      { kind: "network-error" as const, detail: "offline" },
      { kind: "unverified" },
    ],
  ] as const)("maps %s", (_name, failure, expected) => {
    expect(createFailure(failure, null)).toEqual(expected);
  });

  it("carries any other refusal as its own sentence", () => {
    const failure = createFailure(refusal(409, "sandbox_busy"), "Acme");
    expect(failure.kind).toBe("refused");
  });
});

describe("runStagedSandbox settling", () => {
  it("hands off once the row is awake, configured and its host is dialable: the stage moves to handoff and the surface is pinned to the new host", async () => {
    useStagedSandboxStore.getState().stage(surfaceKey, PERSONAL_NEW);
    const { directory, deps } = harness({}, true);

    await run(false, deps);

    expect(stageOf()).toMatchObject({
      phase: "handoff",
      createdSandboxId: SANDBOX_ID,
      createdHostId: NEW_HOST_ID,
      step: "delivering",
      failure: null,
    });
    expect(useSurfaceHostSelectionStore.getState().selections[surfaceKey]).toBe(
      NEW_HOST_ID,
    );
    expect(directory.refreshes).toBeGreaterThan(0);
  });

  it.each([
    { sendTaken: false, owner: false, request: NEW_HOST_ID, phase: null },
    { sendTaken: true, owner: true, request: null, phase: "handoff" },
    // The sending draft's page closed while it booted: nothing resubmits it.
    { sendTaken: true, owner: false, request: NEW_HOST_ID, phase: null },
  ])(
    "on a terminal ask, hands the terminal to the landing panel, sending nothing unless a send was taken ($sendTaken) by a draft still mounted ($owner)",
    async ({ sendTaken, owner, request, phase }) => {
      useStagedSandboxStore.getState().stage(surfaceKey, PERSONAL_NEW);
      useStagedSandboxStore
        .getState()
        .report(surfaceKey, { openTerminal: true, sendTaken });
      if (owner) {
        onTestFinished(holdHandoffOwner(surfaceKey, null, ownerGoneOnUnmount));
      }
      const { deps } = harness({}, true);

      await run(false, deps);

      expect(readStagedSandbox(surfaceKey)?.phase ?? null).toBe(phase);
      expect(
        useLandingPanelStore.getState().terminalRequest?.hostId ?? null,
      ).toBe(request);
      expect(
        useSurfaceHostSelectionStore.getState().selections[surfaceKey],
      ).toBe(NEW_HOST_ID);
    },
  );

  it("ends a boot whose send was abandoned and not claimed again, on the new host with nothing sent", async () => {
    useStagedSandboxStore.getState().stage(surfaceKey, PERSONAL_NEW);
    // A send started it; its draft closed mid-create (`holdHandoffOwner`).
    useStagedSandboxStore
      .getState()
      .report(surfaceKey, { sendTaken: false, openTerminal: false });
    const { deps } = harness({}, true);
    // Straight to the run: `run` would stand a send in for the abandoned one.
    await runStagedSandbox(
      surfaceKey,
      false,
      { fallbackName: "fallback-box", taskId: null, resume: false },
      deps,
    );

    expect(readStagedSandbox(surfaceKey)).toBeNull();
    expect(useLandingPanelStore.getState().terminalRequest).toBeNull();
    expect(useSurfaceHostSelectionStore.getState().selections[surfaceKey]).toBe(
      NEW_HOST_ID,
    );
  });

  it("keeps polling until the host is dialable, then hands off", async () => {
    useStagedSandboxStore.getState().stage(surfaceKey, PERSONAL_NEW);
    const { directory, deps, clock } = harness(
      { entries: [null, null, DIALABLE] },
      true,
    );

    await run(false, deps);

    expect(clock.sleeps).toBe(2);
    expect(directory.lookups).toBe(3);
    expect(stageOf().phase).toBe("handoff");
  });

  it("fails with the settings code when the sandbox is awake but its settings did not apply, and does not hand off", async () => {
    useStagedSandboxStore.getState().stage(surfaceKey, PERSONAL_NEW);
    const { deps } = harness(
      {
        lists: [
          listOf(
            row({
              state: "awake",
              guestConfigured: false,
              failureCode: "SETTINGS_SYNC_FAILED",
            }),
          ),
        ],
      },
      true,
    );

    await run(false, deps);

    expect(stageOf().failure).toEqual({
      kind: "settings",
      code: "SETTINGS_SYNC_FAILED",
    });
    expect(stageOf().phase).toBe("creating");
    expect(useSurfaceHostSelectionStore.getState().selections).toEqual({});
  });

  it("fails with the row's code when the sandbox fails after the create was accepted", async () => {
    useStagedSandboxStore.getState().stage(surfaceKey, PERSONAL_NEW);
    const { deps } = harness(
      {
        lists: [
          listOf(
            row({ state: "failed", failureCode: "PROVIDER_CREATE_FAILED" }),
          ),
        ],
      },
      true,
    );

    await run(false, deps);

    expect(stageOf().failure).toEqual({
      kind: "failed",
      code: "PROVIDER_CREATE_FAILED",
      step: "booting",
    });
  });

  it("ignores a failed read of the list and keeps waiting", async () => {
    useStagedSandboxStore.getState().stage(surfaceKey, PERSONAL_NEW);
    const { deps, clock } = harness(
      {
        lists: [
          { kind: "network-error", detail: "offline" },
          listOf(row({ state: "awake", guestConfigured: true })),
        ],
      },
      true,
    );

    await run(false, deps);

    expect(clock.sleeps).toBe(1);
    expect(stageOf().phase).toBe("handoff");
  });

  it("times out when the budget runs out with the sandbox still on its way", async () => {
    useStagedSandboxStore.getState().stage(surfaceKey, PERSONAL_NEW);
    const { auth, deps, clock } = harness(
      { lists: [listOf(row({ state: "creating" }))] },
      true,
    );

    await run(false, deps);

    expect(stageOf().failure).toEqual({ kind: "timed-out", step: "booting" });
    expect(stageOf().phase).toBe("creating");
    // The clock only moves by the loop's own sleeps: 360 s of 2 s polls.
    expect(clock.now - 1_000_000).toBe(STAGED_CREATE_BUDGET_MS);
    expect(auth.listReads).toBe(STAGED_CREATE_BUDGET_MS / 2_000);
  });

  it("stops reporting when the stage was cancelled during the wait", async () => {
    useStagedSandboxStore.getState().stage(surfaceKey, PERSONAL_NEW);
    const { deps } = harness(
      { lists: [listOf(row({ state: "creating" }))] },
      true,
    );
    const sleep = deps.sleep;
    let cancelled = false;
    const cancelling: StagedSandboxRunDeps = {
      ...deps,
      sleep: (ms) => {
        if (!cancelled) {
          cancelled = true;
          useStagedSandboxStore.getState().cancel(surfaceKey);
        }
        return sleep(ms);
      },
    };

    await run(false, cancelling);

    expect(stageOf()).toMatchObject({ phase: "staged", failure: null });
  });
});

describe("runStagedSandbox on a resting sandbox", () => {
  it("wakes the staged host and creates nothing, then hands off on its row", async () => {
    useStagedSandboxStore.getState().stage(surfaceKey, RESTING);
    const { auth, wake, deps } = harness(
      {
        lists: [
          listOf(
            sandboxSummaryFixture({
              id: "sbx_resting",
              hostId: "host-resting",
              state: "awake",
              guestConfigured: true,
            }),
          ),
        ],
        entries: [{ ...DIALABLE, hostId: "host-resting" }],
      },
      true,
    );

    await run(false, deps);

    expect(wake).toHaveBeenCalledTimes(1);
    expect(wake).toHaveBeenCalledWith("host-resting");
    expect(auth.requests).toEqual([]);
    expect(stageOf()).toMatchObject({
      phase: "handoff",
      createdSandboxId: "sbx_resting",
      createdHostId: "host-resting",
    });
    expect(useSurfaceHostSelectionStore.getState().selections[surfaceKey]).toBe(
      "host-resting",
    );
  });

  it("fails on the wake step when the wake did not bring it up", async () => {
    useStagedSandboxStore.getState().stage(surfaceKey, RESTING);
    const { auth, deps } = harness({}, false);

    await run(false, deps);

    expect(auth.requests).toEqual([]);
    expect(stageOf().failure).toEqual({
      kind: "failed",
      code: "wake",
      step: "booting",
    });
  });
});

describe("runStagedSandbox guards", () => {
  it("does nothing when nothing is staged, or the stage is already handing off", async () => {
    const { auth, deps } = harness({}, true);
    await run(false, deps);
    expect(auth.requests).toEqual([]);

    useStagedSandboxStore.getState().stage(surfaceKey, PERSONAL_NEW);
    useStagedSandboxStore.getState().report(surfaceKey, { phase: "handoff" });
    await run(false, deps);
    expect(auth.requests).toEqual([]);
  });

  it("runs one create at a time per surface: a second click while the first waits joins it", async () => {
    useStagedSandboxStore.getState().stage(surfaceKey, PERSONAL_NEW);
    const { auth, deps } = harness({}, true);

    await Promise.all([run(false, deps), run(false, deps)]);

    expect(auth.requests).toHaveLength(1);
  });

  it("takes up a cancelled send's create still in flight on the next send, instead of racing it with a second run", async () => {
    useStagedSandboxStore.getState().stage(surfaceKey, PERSONAL_NEW);
    const { auth, deps, clock } = harness({}, true);
    let release = (): void => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.spyOn(auth, "createSandbox").mockImplementationOnce(async (request) => {
      auth.requests.push(request);
      await held;
      return created;
    });
    const listReads = vi.spyOn(auth, "listSandboxes");

    const cancelledSend = run(false, deps);
    await vi.waitFor(() => {
      expect(auth.requests).toHaveLength(1);
    });
    const { startedAt, step, stepAt } = stageOf();
    useStagedSandboxStore.getState().cancel(surfaceKey);
    clock.now += 30_000;
    // The send's key rule: the create may have been accepted.
    await run(false, deps);
    // The line goes on from where the run is, not from a new start.
    expect(stageOf()).toMatchObject({
      phase: "creating",
      clientRequestId: auth.requests[0].clientRequestId,
      startedAt,
      step,
      stepAt,
    });

    release();
    await cancelledSend;
    expect(auth.requests).toHaveLength(1);
    expect(listReads).toHaveBeenCalledTimes(1);
    expect(stageOf()).toMatchObject({
      phase: "handoff",
      clientRequestId: auth.requests[0].clientRequestId,
    });
  });

  it("starts a fresh create while a cancelled send's create is still in flight, when the stage asks for a new key", async () => {
    useStagedSandboxStore.getState().stage(surfaceKey, PERSONAL_NEW);
    const { auth, deps } = harness({}, true);
    let release = (): void => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.spyOn(auth, "createSandbox").mockImplementationOnce(async (request) => {
      auth.requests.push(request);
      await held;
      return created;
    });

    const cancelledSend = run(false, deps);
    await vi.waitFor(() => {
      expect(auth.requests).toHaveLength(1);
    });
    useStagedSandboxStore.getState().cancel(surfaceKey);
    await run(true, deps);

    expect(auth.requests).toHaveLength(2);
    expect(auth.requests[1].clientRequestId).not.toBe(
      auth.requests[0].clientRequestId,
    );
    expect(stageOf().phase).toBe("handoff");
    release();
    await cancelledSend;
    expect(stageOf()).toMatchObject({
      phase: "handoff",
      clientRequestId: auth.requests[1].clientRequestId,
    });
  });
});

describe("settleVerdict", () => {
  it("fails a row the list no longer holds", () => {
    expect(settleVerdict(null)).toEqual({
      kind: "failure",
      failure: { kind: "failed", code: "gone", step: "booting" },
    });
  });

  it.each(["failed", "destroying", "destroyed"] as const)(
    "fails a %s row with its failure code, or its state when it has none",
    (state) => {
      expect(
        settleVerdict(row({ state, failureCode: "PROVIDER_CREATE_FAILED" })),
      ).toEqual({
        kind: "failure",
        failure: {
          kind: "failed",
          code: "PROVIDER_CREATE_FAILED",
          step: "booting",
        },
      });
      expect(settleVerdict(row({ state, failureCode: null }))).toEqual({
        kind: "failure",
        failure: { kind: "failed", code: state, step: "booting" },
      });
    },
  );

  it("fails an awake row that is frozen as credits", () => {
    expect(settleVerdict(row({ state: "awake", frozen: true }))).toEqual({
      kind: "failure",
      failure: { kind: "credits", shortfallMc: null },
    });
  });

  it("fails an awake row whose settings did not apply, and names the code or settings", () => {
    expect(
      settleVerdict(
        row({ state: "awake", guestConfigured: false, failureCode: "X" }),
      ),
    ).toEqual({ kind: "failure", failure: { kind: "settings", code: "X" } });
    expect(
      settleVerdict(
        row({ state: "awake", guestConfigured: false, failureCode: null }),
      ),
    ).toEqual({
      kind: "failure",
      failure: { kind: "settings", code: "settings" },
    });
  });

  it.each([true, null])(
    "calls an awake row with guestConfigured %s ready",
    (guestConfigured) => {
      expect(settleVerdict(row({ state: "awake", guestConfigured }))).toEqual({
        kind: "awake",
      });
    },
  );

  it.each(["creating", "suspended", "stopped"] as const)(
    "keeps waiting on a %s row",
    (state) => {
      expect(settleVerdict(row({ state }))).toBeNull();
    },
  );
});
