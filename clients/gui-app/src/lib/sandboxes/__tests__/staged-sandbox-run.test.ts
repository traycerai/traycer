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
import { environmentStatusResponseSchemaV11 } from "@traycer/protocol/host/environment-schemas";
import type {
  SandboxCreateRequest,
  SandboxSummary,
  SandboxVerbGesture,
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
import { sandboxListQueryOptions } from "@/hooks/sandboxes/use-sandbox-list-query";
import { sandboxSummaryFixture } from "@/hooks/sandboxes/__tests__/sandbox-fixtures";
import { refusal } from "@/hooks/sandboxes/__tests__/sandbox-binding-fixture";
import { createFakeRunnerHost } from "../../../../__tests__/create-fake-runner-host";
import { authQueryKeys } from "@/lib/query-keys";
import { pendingSend } from "@/lib/sandboxes/__tests__/pending-send-fixtures";
import { holdPendingSandboxSendOwnership } from "@/lib/sandboxes/pending-sandbox-send-ownership";
import {
  pendingSendSurfaceKey,
  usePendingSandboxSendStore,
} from "@/stores/sandboxes/pending-sandbox-send-store";
import { useAuthStore } from "@/stores/auth/auth-store";

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
  const wake = vi.fn<
    (hostId: string, gesture: SandboxVerbGesture) => Promise<boolean>
  >(() => Promise.resolve(wakeResult));
  const deps: StagedSandboxRunDeps = {
    auth,
    directory,
    queryClient: new QueryClient({
      defaultOptions: { queries: { retry: false } },
    }),
    userId: null,
    wake,
    // An older host has no environment.status: the baseline fixtures keep their old reading.
    readSettings: () => Promise.resolve("unsupported"),
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
    { taskId: null, resume: false },
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
      displayName: stageOf().target.name,
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
      { taskId: "epic-1", resume: false },
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

  it("does not let a first list read still in flight, begun before a wake, read its old row as a rest", async () => {
    useStagedSandboxStore.getState().stage(surfaceKey, RESTING);
    const { auth, wake, deps } = harness(
      { entries: [{ ...DIALABLE, hostId: "host-resting" }] },
      true,
    );
    const rowOf = (state: SandboxSummary["state"]) =>
      sandboxSummaryFixture({
        id: "sbx_resting",
        hostId: "host-resting",
        state,
        guestConfigured: true,
      });
    // The first-ever read is held open; every later one answers awake. The
    // key hashes the auth's own state, which drifts as the fake runner host
    // reports events, so pin it to one value for the run's reads to join.
    Object.defineProperty(auth, "toJSON", { value: () => "scripted-auth" });
    let release: (result: SandboxListFetchResult) => void = () => undefined;
    let reads = 0;
    auth.listSandboxes = () => {
      reads += 1;
      if (reads > 1) return Promise.resolve(listOf(rowOf("awake")));
      return new Promise((resolve) => {
        release = resolve;
      });
    };
    void deps.queryClient.prefetchQuery(
      sandboxListQueryOptions(auth, deps.userId, true),
    );
    expect(reads).toBe(1);

    // The read begun before the wake answers with its old row at the moment
    // the wait asks for a fresh one: joined, it would read as a rest.
    const { queryClient } = deps;
    const original = queryClient.fetchQuery.bind(queryClient);
    vi.spyOn(queryClient, "fetchQuery").mockImplementation((options) => {
      const pending = original(options);
      release(listOf(rowOf("suspended")));
      return pending;
    });

    await run(false, deps);

    expect(wake).toHaveBeenCalledTimes(1);
    expect(stageOf().failure).toBeNull();
    expect(stageOf().phase).toBe("handoff");
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

describe("runStagedSandbox on a created sandbox the list has not shown yet", () => {
  const awake = listOf(row({ state: "awake", guestConfigured: true }));
  const missing: SandboxListFetchResult = {
    kind: "ok",
    response: { sandboxes: [] },
  };

  it("keeps the old reading for a stage that is no pending send's: no record of an accepted create, so a missing row is gone", async () => {
    useStagedSandboxStore.getState().stage(surfaceKey, PERSONAL_NEW);
    const { auth, deps } = harness({ lists: [missing, missing, awake] }, true);

    await run(false, deps);

    expect(auth.listReads).toBe(1);
    expect(stageOf().failure).toMatchObject({ kind: "failed", code: "gone" });
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
          creditSource: "personal",
        }),
      },
      true,
    );

    await run(false, deps);

    expect(stageOf().failure).toEqual({
      kind: "credits",
      shortfallMc: 1_200_000,
      creditSource: "personal",
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
      { taskId: null, resume: false },
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
      steps: { applied: [], notApplied: ["Sandbox setup"] },
    });
    expect(stageOf().phase).toBe("creating");
    expect(useSurfaceHostSelectionStore.getState().selections).toEqual({});
  });

  describe("with the host's environment status", () => {
    interface StatusItem {
      readonly kind: string;
      readonly key: string;
      readonly os: string;
      readonly desiredRevision: number;
      readonly status: string;
      readonly code: string;
      readonly args: Readonly<Record<string, null>>;
      readonly brokerEnforced: null;
      readonly minimumHostVersion: null;
      readonly appliedAs: null;
    }
    const item = (kind: string, key: string, status: string): StatusItem => ({
      kind,
      key,
      os: "any",
      desiredRevision: 3,
      status,
      code: "ok",
      args: { exitStatus: null, stage: null, durationMs: null, kind: null },
      brokerEnforced: null,
      minimumHostVersion: null,
      appliedAs: null,
    });
    const statusOf = (
      receivedRevision: number | null,
      items: readonly StatusItem[],
    ) =>
      environmentStatusResponseSchemaV11.parse({
        principal: { kind: "personal" },
        reachability: "connected",
        bindingGeneration: 1,
        desiredRevision: receivedRevision,
        receivedRevision,
        appliedRevision: receivedRevision,
        receiptAgeMs: 0,
        remoteAccess: "on",
        pendingUploads: [],
        setup: null,
        items,
      });
    const settleWith = async (
      answer: StagedSandboxRunDeps["readSettings"],
    ): Promise<void> => {
      useStagedSandboxStore.getState().stage(surfaceKey, PERSONAL_NEW);
      const { deps } = harness({}, true);
      await run(false, { ...deps, readSettings: answer });
    };

    it("fails with the failed step named, never a raw item key, when an MCP server did not apply", async () => {
      await settleWith(() =>
        Promise.resolve(
          statusOf(5, [
            item("secret", "sec-1", "applied"),
            item("mcp_server", "github", "failed"),
          ]),
        ),
      );

      expect(stageOf().failure).toMatchObject({
        kind: "settings",
        steps: { applied: ["Secrets"], notApplied: ["MCP servers"] },
      });
      expect(stageOf().phase).toBe("creating");
    });

    it("hands off past a key the sandbox does not use: not_used is neither a failure nor a wait", async () => {
      await settleWith(() =>
        Promise.resolve(
          statusOf(5, [
            item("env_override", "claude:ANTHROPIC_API_KEY", "not_used"),
            item("variable", "REGION", "applied"),
          ]),
        ),
      );

      expect(stageOf().phase).toBe("handoff");
      expect(stageOf().failure).toBeNull();
    });

    it.each([
      ["a read that failed", () => Promise.resolve(null)],
      [
        "a status before the first revision was received",
        () => Promise.resolve(statusOf(null, [])),
      ],
      [
        "an explicit settings operation still pending",
        () =>
          Promise.resolve({
            ...statusOf(5, [item("variable", "REGION", "applied")]),
            sandboxSettingsOperationId: null,
          }),
      ],
      [
        "a status with no principal, though a received revision is cached",
        () =>
          Promise.resolve({
            ...statusOf(5, [item("variable", "REGION", "applied")]),
            principal: null,
          }),
      ],
      [
        "an item with a status this app does not know",
        () =>
          Promise.resolve(
            statusOf(5, [item("variable", "REGION", "some_future_status")]),
          ),
      ],
      [
        "an item still pending",
        () =>
          Promise.resolve(statusOf(5, [item("variable", "REGION", "pending")])),
      ],
    ])("holds the send on %s, never handing off", async (_name, answer) => {
      await settleWith(answer);

      expect(stageOf().phase).not.toBe("handoff");
      expect(stageOf().failure).toMatchObject({ kind: "timed-out" });
    });
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
    expect(wake).toHaveBeenCalledWith("host-resting", "send");
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

  it("keeps the pot a refused wake was checked against, so the line can name it", async () => {
    useStagedSandboxStore.getState().stage(surfaceKey, {
      ...RESTING,
      configuration: { kind: "team", teamId: "team-acme", teamName: "Acme" },
    });
    const { deps } = harness({}, false);

    await run(false, {
      ...deps,
      wake: () =>
        Promise.resolve({
          kind: "credit-gate",
          shortfallMc: 120,
          creditSource: "team-allowance",
          burnMcPerHour: null,
        }),
    });

    expect(stageOf().failure).toEqual({
      kind: "credits",
      shortfallMc: 120,
      creditSource: "team-allowance",
    });
  });

  it("wakes a New sandbox that was already created after a failed wake instead of creating it again", async () => {
    const store = useStagedSandboxStore.getState();
    store.stage(surfaceKey, PERSONAL_NEW);
    store.begin(surfaceKey, false, 1_000_000, false);
    store.report(surfaceKey, {
      createdSandboxId: SANDBOX_ID,
      createdHostId: NEW_HOST_ID,
      failure: { kind: "failed", code: "wake", step: "booting" },
    });
    const { auth, wake, deps } = harness(
      { lists: [listOf(row({ state: "awake", guestConfigured: true }))] },
      true,
    );

    await run(false, deps);

    expect(auth.requests).toEqual([]);
    expect(wake).toHaveBeenCalledTimes(1);
    expect(wake).toHaveBeenCalledWith(NEW_HOST_ID, "send");
    expect(stageOf()).toMatchObject({
      phase: "handoff",
      createdSandboxId: SANDBOX_ID,
      createdHostId: NEW_HOST_ID,
    });
  });

  it("keeps the accepted New sandbox and request key when its wake fails again", async () => {
    const store = useStagedSandboxStore.getState();
    store.stage(surfaceKey, PERSONAL_NEW);
    store.begin(surfaceKey, false, 1_000_000, false);
    store.report(surfaceKey, {
      createdSandboxId: SANDBOX_ID,
      createdHostId: NEW_HOST_ID,
      failure: { kind: "failed", code: "wake", step: "booting" },
    });
    const requestId = stageOf().clientRequestId;
    const { auth, wake, deps } = harness({}, false);

    await run(true, deps);

    expect(auth.requests).toEqual([]);
    expect(wake).toHaveBeenCalledWith(NEW_HOST_ID, "send");
    expect(stageOf()).toMatchObject({
      phase: "creating",
      clientRequestId: requestId,
      createdSandboxId: SANDBOX_ID,
      createdHostId: NEW_HOST_ID,
      failure: { kind: "failed", code: "wake", step: "booting" },
    });
  });

  it("wakes the same created sandbox after Cancel retains it while it is resting", async () => {
    const store = useStagedSandboxStore.getState();
    store.stage(surfaceKey, PERSONAL_NEW);
    store.begin(surfaceKey, false, 1_000_000, false);
    store.report(surfaceKey, {
      createdSandboxId: SANDBOX_ID,
      createdHostId: NEW_HOST_ID,
    });
    const requestId = stageOf().clientRequestId;
    store.cancel(surfaceKey);
    const { auth, wake, deps } = harness(
      {
        lists: [
          listOf(row({ state: "suspended" })),
          listOf(row({ state: "awake", guestConfigured: true })),
        ],
      },
      true,
    );

    await run(false, deps);

    expect(auth.requests).toEqual([]);
    expect(wake).toHaveBeenCalledTimes(1);
    expect(wake).toHaveBeenCalledWith(NEW_HOST_ID, "send");
    expect(stageOf()).toMatchObject({
      phase: "handoff",
      clientRequestId: requestId,
      createdSandboxId: SANDBOX_ID,
      createdHostId: NEW_HOST_ID,
    });
  });

  describe("a run resumed after a reload", () => {
    const RESTING_ROW = (state: SandboxSummary["state"]) =>
      row({
        id: "sbx_resting",
        hostId: "host-resting",
        state,
        guestConfigured: true,
      });

    function stageWoken(step: "applying" | "booting"): void {
      const store = useStagedSandboxStore.getState();
      store.stage(surfaceKey, RESTING);
      store.begin(surfaceKey, false, 1_000_000, false);
      store.report(surfaceKey, {
        createdSandboxId: "sbx_resting",
        createdHostId: "host-resting",
        step,
        failure: null,
      });
      store.report(surfaceKey, { sendTaken: true });
      onTestFinished(holdHandoffOwner(surfaceKey, null, ownerGoneOnUnmount));
    }

    function runWith(resume: boolean, deps: StagedSandboxRunDeps) {
      return runStagedSandbox(
        surfaceKey,
        false,
        { taskId: "task-1", resume },
        deps,
      );
    }

    const resumable = (state: "suspended" | "awake") =>
      harness(
        {
          lists: [listOf(RESTING_ROW(state))],
          entries: [{ ...DIALABLE, hostId: "host-resting" }],
        },
        true,
      );

    it("makes no wake call for an existing sandbox it had already woken and finds suspended", async () => {
      stageWoken("applying");
      const { wake, deps } = resumable("suspended");

      await runWith(true, deps);

      expect(wake).not.toHaveBeenCalled();
      expect(stageOf()).toMatchObject({ phase: "creating", step: "applying" });
    });

    it("wakes the same sandbox when the person's Keep waiting restarts the wait", async () => {
      stageWoken("applying");
      const { wake, deps } = resumable("awake");

      await runWith(false, deps);

      expect(wake).toHaveBeenCalledTimes(1);
      expect(wake).toHaveBeenCalledWith("host-resting", "send");
    });

    it("makes no wake call at the booting step either, and records the rest on the stage", async () => {
      stageWoken("booting");
      const { wake, deps } = resumable("suspended");

      await runWith(true, deps);

      expect(wake).not.toHaveBeenCalled();
      expect(stageOf()).toMatchObject({
        phase: "creating",
        failure: { kind: "rested" },
      });
    });

    it("carries on to the handoff, waking nothing, when a wake that landed before the reload reads resuming and then awake", async () => {
      stageWoken("booting");
      const { wake, deps } = harness(
        {
          lists: [
            listOf(RESTING_ROW("resuming")),
            listOf(RESTING_ROW("awake")),
          ],
          entries: [{ ...DIALABLE, hostId: "host-resting" }],
        },
        true,
      );

      await runWith(true, deps);

      expect(wake).not.toHaveBeenCalled();
      expect(stageOf().phase).toBe("handoff");
    });
  });

  it("wakes once for a live Send, and a Suspend made while it waits ends the wait instead of undoing it", async () => {
    useStagedSandboxStore.getState().stage(surfaceKey, RESTING);
    const { wake, deps } = harness(
      {
        lists: [
          listOf(
            sandboxSummaryFixture({
              id: "sbx_resting",
              hostId: "host-resting",
              state: "suspended",
            }),
          ),
        ],
        entries: [{ ...DIALABLE, hostId: "host-resting" }],
      },
      true,
    );

    await run(false, deps);

    expect(wake).toHaveBeenCalledTimes(1);
    expect(wake).toHaveBeenCalledWith("host-resting", "send");
    expect(stageOf()).toMatchObject({
      phase: "creating",
      failure: { kind: "rested" },
    });
  });

  it("does not wake a sandbox that rested on its own after its settings step began", async () => {
    const store = useStagedSandboxStore.getState();
    store.stage(surfaceKey, PERSONAL_NEW);
    store.begin(surfaceKey, false, 1_000_000, false);
    store.report(surfaceKey, {
      createdSandboxId: SANDBOX_ID,
      createdHostId: NEW_HOST_ID,
    });
    const requestId = stageOf().clientRequestId;
    // The first read finds it awake, but its host is not dialable yet, so the
    // run waits at the settings step; the next read finds it suspended.
    const { auth, wake, deps } = harness(
      {
        lists: [
          listOf(row({ state: "awake", guestConfigured: true })),
          listOf(row({ state: "suspended" })),
        ],
        entries: [null],
      },
      true,
    );

    await run(false, deps);

    expect(auth.requests).toEqual([]);
    expect(wake).not.toHaveBeenCalled();
    expect(stageOf()).toMatchObject({
      phase: "creating",
      step: "applying",
      clientRequestId: requestId,
      createdSandboxId: SANDBOX_ID,
    });
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

describe("runStagedSandbox for a pending send that holds a durable Stop", () => {
  let SEND = "";
  let sendCount = 0;

  /** A pending send of the signed-in owner, this window holding its ownership. */
  async function pendingOwnerWith(stopRequested: boolean): Promise<void> {
    sendCount += 1;
    SEND = `send-stop-run-${sendCount}`;
    useAuthStore
      .getState()
      .setSignedIn(
        { userId: "user-1", userName: "U", email: "u@example.com" },
        { userId: "user-1", username: "U" },
        [],
      );
    onTestFinished(() => useAuthStore.getState().setSignedOut());
    surfaceKey = pendingSendSurfaceKey(SEND);
    usePendingSandboxSendStore
      .getState()
      .add(pendingSend({ id: SEND, stopRequested }));
    onTestFinished(() => {
      usePendingSandboxSendStore.setState({ sends: {} });
    });
    const ownership = holdPendingSandboxSendOwnership(SEND);
    onTestFinished(ownership.release);
    await ownership.ready;
  }

  it("records the accepted create on the pending send before any read, waits through two fresh misses, then marks its row seen on the read that lists it", async () => {
    await pendingOwnerWith(false);
    useStagedSandboxStore.getState().stage(surfaceKey, PERSONAL_NEW);
    const miss = (): SandboxListFetchResult => ({
      kind: "ok",
      response: { sandboxes: [] },
    });
    const { auth, deps } = harness(
      {
        lists: [
          miss(),
          miss(),
          listOf(row({ state: "awake", guestConfigured: true })),
        ],
      },
      true,
    );
    const request = usePendingSandboxSendStore.getState().sends[SEND];
    const boundary = Math.max(
      request.createdAt,
      request.observationRequestedAt ?? 0,
    );
    // Every clock sample from here on is later than the last: each read's
    // send time is after the request boundary by construction.
    let clock = boundary + 1_000;
    const now = vi.spyOn(Date, "now").mockImplementation(() => (clock += 1));
    onTestFinished(() => now.mockRestore());
    const recordAtRead: Array<unknown> = [];
    const read = auth.listSandboxes.bind(auth);
    vi.spyOn(auth, "listSandboxes").mockImplementation(() => {
      recordAtRead.push(
        usePendingSandboxSendStore.getState().sends[SEND]?.createdSandbox,
      );
      return read();
    });

    await run(false, deps);

    expect(auth.listReads).toBeGreaterThanOrEqual(3);
    // The accepted create is on the record before the first read, and the
    // two misses leave it unseen rather than calling the sandbox gone.
    expect(recordAtRead.slice(0, 3)).toEqual([
      { sandboxId: SANDBOX_ID, rowSeen: false },
      { sandboxId: SANDBOX_ID, rowSeen: false },
      { sandboxId: SANDBOX_ID, rowSeen: false },
    ]);
    expect(
      usePendingSandboxSendStore.getState().sends[SEND]?.createdSandbox,
    ).toEqual({ sandboxId: SANDBOX_ID, rowSeen: true });
    expect(stageOf()).toMatchObject({ phase: "handoff" });
    expect(stageOf().failure).toBeNull();
  });

  it("calls the sandbox gone when a fresh read misses a row an earlier read had seen, with rowSeen kept true", async () => {
    await pendingOwnerWith(false);
    useStagedSandboxStore.getState().stage(surfaceKey, PERSONAL_NEW);
    const { deps } = harness(
      {
        lists: [
          listOf(row({ state: "creating" })),
          { kind: "ok", response: { sandboxes: [] } },
        ],
      },
      true,
    );

    // Each read is sent strictly after the one before and the request boundary.
    const request = usePendingSandboxSendStore.getState().sends[SEND];
    let clock = Math.max(
      request.createdAt,
      request.observationRequestedAt ?? 0,
    );
    const now = vi
      .spyOn(Date, "now")
      .mockImplementation(() => (clock += 1_000));
    onTestFinished(() => now.mockRestore());

    await run(false, deps);

    expect(stageOf().failure).toMatchObject({ kind: "failed", code: "gone" });
    expect(
      usePendingSandboxSendStore.getState().sends[SEND]?.createdSandbox,
    ).toEqual({ sandboxId: SANDBOX_ID, rowSeen: true });
  });

  it("does not hand off while the seen marker cannot be stored, and does once storage takes it", async () => {
    await pendingOwnerWith(false);
    useStagedSandboxStore.getState().stage(surfaceKey, PERSONAL_NEW);
    const { auth, deps } = harness(
      { lists: [listOf(row({ state: "awake", guestConfigured: true }))] },
      true,
    );
    const originalSetItem = localStorage.setItem.bind(localStorage);
    // Quota: the record takes the unseen marker, then refuses the seen one.
    const failedWrite = vi
      .spyOn(Storage.prototype, "setItem")
      .mockImplementation(function (this: Storage, key, value) {
        if (key.includes(SEND) && value.includes('"rowSeen":true'))
          throw new Error("quota exceeded");
        originalSetItem.call(this, key, value);
      });
    onTestFinished(() => failedWrite.mockRestore());
    const read = auth.listSandboxes.bind(auth);
    vi.spyOn(auth, "listSandboxes").mockImplementation(() => {
      // The third read finds storage working again.
      if (auth.listReads === 2) failedWrite.mockRestore();
      return read();
    });

    await run(false, deps);

    // Handing off on the first read would leave a claim that can never use absence.
    expect(auth.listReads).toBeGreaterThanOrEqual(3);
    expect(
      usePendingSandboxSendStore.getState().sends[SEND]?.createdSandbox,
    ).toEqual({ sandboxId: SANDBOX_ID, rowSeen: true });
    expect(stageOf()).toMatchObject({ phase: "handoff" });
  });

  it("times out a never-seen create after its budget ends, rather than calling it gone", async () => {
    await pendingOwnerWith(false);
    useStagedSandboxStore.getState().stage(surfaceKey, PERSONAL_NEW);
    const { auth, deps } = harness(
      { lists: [{ kind: "ok", response: { sandboxes: [] } }] },
      true,
    );

    await run(false, deps);

    expect(auth.listReads).toBeGreaterThan(1);
    expect(stageOf().failure).toEqual({ kind: "timed-out", step: "booting" });
    expect(
      usePendingSandboxSendStore.getState().sends[SEND]?.createdSandbox,
    ).toEqual({ sandboxId: SANDBOX_ID, rowSeen: false });
  });

  it("runs a stage for a pending send that holds no Stop, which is what makes the Stop cases below a real difference", async () => {
    await pendingOwnerWith(false);
    useStagedSandboxStore.getState().stage(surfaceKey, RESTING);
    const { wake, deps } = harness(
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
    expect(stageOf().phase).toBe("handoff");
  });

  it("does not start a run, wake or create for a stage whose pending send holds a Stop", async () => {
    await pendingOwnerWith(true);
    useStagedSandboxStore.getState().stage(surfaceKey, RESTING);
    const { auth, wake, deps } = harness({}, true);

    await run(false, deps);

    expect(wake).not.toHaveBeenCalled();
    expect(auth.requests).toEqual([]);
    expect(stageOf().phase).not.toBe("handoff");
    expect(
      useSurfaceHostSelectionStore.getState().selections[surfaceKey],
    ).toBeUndefined();
  });

  it("stops a run whose Stop lands as its create is accepted: no handoff, no host pin, no wake", async () => {
    await pendingOwnerWith(false);
    useStagedSandboxStore.getState().stage(surfaceKey, PERSONAL_NEW);
    const { auth, wake, deps } = harness(
      {
        createSandbox: () => {
          usePendingSandboxSendStore.setState((state) => ({
            sends: {
              ...state.sends,
              [SEND]: { ...state.sends[SEND], stopRequested: true },
            },
          }));
          return created;
        },
      },
      true,
    );

    await run(false, deps);

    expect(auth.requests).toHaveLength(1);
    expect(stageOf().phase).not.toBe("handoff");
    expect(
      useSurfaceHostSelectionStore.getState().selections[surfaceKey],
    ).toBeUndefined();
    expect(wake).not.toHaveBeenCalled();
    expect(
      usePendingSandboxSendStore.getState().sends[SEND]?.stopRequested,
    ).toBe(true);
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
    ).toEqual({
      kind: "failure",
      failure: {
        kind: "settings",
        code: "X",
        steps: { applied: [], notApplied: ["Sandbox setup"] },
      },
    });
    expect(
      settleVerdict(
        row({ state: "awake", guestConfigured: false, failureCode: null }),
      ),
    ).toEqual({
      kind: "failure",
      failure: {
        kind: "settings",
        code: "settings",
        steps: { applied: [], notApplied: ["Sandbox setup"] },
      },
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
