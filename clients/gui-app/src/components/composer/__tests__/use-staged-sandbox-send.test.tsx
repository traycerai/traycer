import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useEffect } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import type { TerminalLaunchTarget } from "@/components/epic-canvas/sidebar/new-terminal-tile-ref";
import {
  stagedSandboxFallbackName,
  useStagedSandboxSend,
  type StagedSandboxSend,
} from "@/components/composer/use-staged-sandbox-send";
import {
  useStagedSandboxStore,
  type StagedSandboxFailure,
  type StagedSandboxStep,
} from "@/stores/composer/staged-sandbox-store";

const mocks = vi.hoisted(() => ({
  runStagedSandbox: vi.fn(() => Promise.resolve()),
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
  useHostBinding: () => ({ auth: {}, directory: {} }),
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
  mocks.runStagedSandbox.mockClear();
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
      latestSend?.intercept("fix the login bug");
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
      latestSend?.intercept("fix the login bug");
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
      sendA?.intercept("fix the login bug");
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
      send?.intercept("fix the login bug");
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
      taken = send?.intercept("fix the login bug") ?? true;
    });
    expect(taken).toBe(false);
    expect(useStagedSandboxStore.getState().bySurface[SURFACE]).toBeUndefined();
  });
});

describe("stagedSandboxFallbackName", () => {
  it("keeps a name from a long first word within the create's 191 characters", () => {
    expect(stagedSandboxFallbackName(`${"a".repeat(300)} fix`)).toBe(
      "a".repeat(191),
    );
  });
});
