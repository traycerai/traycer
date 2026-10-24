import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
import type { SandboxCreateFetchResult } from "@traycer-clients/shared/host-client/sandbox-control";
import type { TerminalLaunchTarget } from "@/components/epic-canvas/sidebar/new-terminal-tile-ref";
import {
  stagedSandboxFallbackName,
  useStagedSandboxSend,
  type StagedSandboxSend,
} from "@/components/composer/use-staged-sandbox-send";
import {
  readStagedSandbox,
  useStagedSandboxStore,
  type StagedSandboxFailure,
  type StagedSandboxStep,
} from "@/stores/composer/staged-sandbox-store";
import type {
  StagedRunRequest,
  StagedSandboxRunDeps,
} from "@/lib/sandboxes/staged-sandbox-run";
import { refusal } from "@/hooks/sandboxes/__tests__/sandbox-binding-fixture";

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
    auth: { createSandbox: mocks.createSandbox },
    directory: { refresh: () => Promise.resolve() },
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
    resolvedHostId: "laptop",
    canSubmit: false,
    submit: () => false,
    prepareHandoff: () => undefined,
    terminal: { epicId: "epic-1", open: props.openTerminal },
    taskId: "epic-1",
    ownerId: null,
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
  mocks.runStagedSandbox.mockReset();
  mocks.runStagedSandbox.mockImplementation(() => Promise.resolve());
  mocks.createSandbox.mockReset();
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

/** One landing draft's composer: the window's drafts share the surface. */
function DraftComposer(props: {
  readonly draftId: string;
  readonly submit: () => boolean;
  readonly onSend: (send: StagedSandboxSend) => void;
}) {
  const { onSend } = props;
  const send = useStagedSandboxSend({
    surfaceKey: SURFACE,
    resolvedHostId: NEW_HOST,
    canSubmit: true,
    submit: props.submit,
    prepareHandoff: () => undefined,
    terminal: null,
    taskId: null,
    ownerId: props.draftId,
  });
  useEffect(() => {
    onSend(send);
  }, [onSend, send]);
  return null;
}

describe("useStagedSandboxSend's handoff", () => {
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
        resolvedHostId: NEW_HOST,
        canSubmit: true,
        submit,
        prepareHandoff: () => undefined,
        terminal: null,
        taskId: null,
        ownerId: null,
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

describe("stagedSandboxFallbackName", () => {
  it("keeps a name from a long first word within the create's 191 characters", () => {
    expect(stagedSandboxFallbackName(`${"a".repeat(300)} fix`)).toBe(
      "a".repeat(191),
    );
  });
});
