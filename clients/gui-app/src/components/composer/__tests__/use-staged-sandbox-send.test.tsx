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
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import {
  SANDBOX_REFUSAL_CODE_INSUFFICIENT_CREDIT,
  type SandboxCreateRequest,
} from "@traycer/protocol/host/sandbox-control";
import type { HostDirectoryEntry } from "@traycer-clients/shared/host-client/host-directory";
import type {
  SandboxCreateFetchResult,
  SandboxListFetchResult,
} from "@traycer-clients/shared/host-client/sandbox-control";
import type { TerminalLaunchTarget } from "@/components/epic-canvas/sidebar/new-terminal-tile-ref";
import {
  stagedSandboxFallbackName,
  startStagedTerminal,
  useStagedSandboxHandoff,
  useStagedSandboxSend,
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
import { notEnoughCreditsLine } from "@/lib/sandboxes/sandbox-strings";

const mocks = vi.hoisted(() => ({
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
  /** The account's host directory, which names the new host once it dials. */
  findById: vi.fn<(hostId: string) => HostDirectoryEntry | null>(),
  repairHostIds: [] as string[],
  repairMutate: vi.fn(
    (_variables: object, options: { readonly onSuccess: () => void }) => {
      options.onSuccess();
    },
  ),
}));

vi.mock("@/lib/sandboxes/staged-sandbox-run", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/lib/sandboxes/staged-sandbox-run")
  >()),
  runStagedSandbox: mocks.runStagedSandbox,
}));
vi.mock(
  "@/hooks/sandboxes/use-sandbox-repair-guest-configuration-mutation",
  () => ({
    useSandboxRepairGuestConfigurationOnHost: (hostId: string) => {
      mocks.repairHostIds.push(hostId);
      return { mutate: mocks.repairMutate };
    },
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
  useAuthUser: () => ({ data: null }),
}));
vi.mock("@/hooks/sandboxes/use-sandbox-catalogue-query", () => ({
  useSandboxCatalogue: () => ({ data: null }),
}));
vi.mock("@/hooks/sandboxes/use-sandbox-verb-mutation", () => ({
  useSandboxVerb: () => ({ mutate: vi.fn() }),
}));
vi.mock("@/hooks/sandboxes/use-configuration-billing-url", () => ({
  useConfigurationBillingUrl: () => "https://example.test/billing",
}));
vi.mock("@/lib/links/open-link", () => ({
  useOpenLink: () => vi.fn(),
}));

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
  store.begin(SURFACE, false, Date.now());
  store.report(SURFACE, {
    createdSandboxId: "sbx-1",
    createdHostId: NEW_HOST,
    step,
    stepAt: Date.now(),
    failure,
  });
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
  useEffect(() => {
    latestSend = send;
  }, [send]);
  return <>{send.line}</>;
}

let latestSend: StagedSandboxSend | null = null;

function mount(openTerminal: (target: TerminalLaunchTarget) => void): void {
  render(
    <QueryClientProvider client={new QueryClient()}>
      <Harness openTerminal={openTerminal} />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
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
});

afterEach(() => {
  cleanup();
  latestSend = null;
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

  it("starts nothing when another sandbox was picked while the repair ran", () => {
    stageCreated("applying", { kind: "settings", code: "SBX-0520" });
    let finishRepair: () => void = () => undefined;
    mocks.repairMutate.mockImplementationOnce((_variables, options) => {
      finishRepair = options.onSuccess;
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
      name: "",
      wakeString: null,
    });
    mount(vi.fn());

    act(() => {
      latestSend?.intercept("fix the login bug", null);
      store.begin(SURFACE, false, Date.now() - 8_000);
    });

    expect(
      screen.getByTestId("sandbox-setup-line-toggle").textContent,
    ).toContain("Starting sandbox·fix-the-login-bug·0:08");
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

  it("retries a create refused for credits under a new key", () => {
    stageRefused({ kind: "credits", shortfallMc: 120 });
    mount(vi.fn());

    fireEvent.click(screen.getByTestId("sandbox-refusal-retry"));

    expect(mocks.runStagedSandbox).toHaveBeenCalledWith(
      SURFACE,
      true,
      expect.any(Object),
      expect.any(Object),
    );
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

/** One landing draft's composer: the window's drafts share the surface. */
function DraftComposer(props: {
  readonly draftId: string;
  readonly submit: () => boolean;
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
      useStagedSandboxStore.getState().begin(SURFACE, false, Date.now());
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
    useStagedSandboxStore.getState().begin(SURFACE, false, Date.now());
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
  it("keeps the stage, the sandbox and the draft when the new host refuses, and says why", () => {
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
      "api-refactor is awake, but",
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
  it("makes a new create after a refusal for credits, and offers Retry beside Add credits", async () => {
    mocks.createSandbox.mockResolvedValue(
      refusal(402, SANDBOX_REFUSAL_CODE_INSUFFICIENT_CREDIT),
    );

    const [first, second] = await sendAgainAfter("credits");

    expect(second).not.toBe(first);
    expect(screen.getByTestId("sandbox-refusal-retry")).toBeDefined();
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
        useStagedSandboxStore.getState().begin(surfaceKey, fresh, Date.now()),
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
        useStagedSandboxStore.getState().begin(surfaceKey, fresh, Date.now()),
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
    store.begin(SURFACE, false, Date.now());
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
  it("brings the sandbox up on another draft's Retry and leaves that draft's text to it", async () => {
    const actual = await vi.importActual<
      typeof import("@/lib/sandboxes/staged-sandbox-run")
    >("@/lib/sandboxes/staged-sandbox-run");
    mocks.runStagedSandbox.mockImplementation(actual.runStagedSandbox);
    const sandbox = sandboxSummaryFixture({ id: "sbx-1", hostId: NEW_HOST });
    mocks.createSandbox
      .mockResolvedValueOnce(
        refusal(402, SANDBOX_REFUSAL_CODE_INSUFFICIENT_CREDIT),
      )
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
      expect(readStagedSandbox(SURFACE)?.failure?.kind).toBe("credits");
    });
    // A closes; a fresh draft B opens on the start page.
    view.rerender(draftB(submitB));
    await afterCommit();

    // After a top-up, B presses Retry and the sandbox comes up.
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

describe("stagedSandboxFallbackName", () => {
  it("keeps a name from a long first word within the create's 191 characters", () => {
    expect(stagedSandboxFallbackName(`${"a".repeat(300)} fix`)).toBe(
      "a".repeat(191),
    );
  });
});
