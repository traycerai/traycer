import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render as renderUi,
  type RenderResult,
  screen,
  waitFor,
} from "@testing-library/react";
import { LazyMotion, domAnimation } from "motion/react";
import { MockRunnerHost } from "@traycer-clients/shared/host-client/mock/mock-runner-host";
import { traycerInfo } from "@traycer-clients/shared/platform/traycer-info";
import { useOnboardingStore } from "@/stores/onboarding/onboarding-store";
import { useFeatureAnnouncementsStore } from "@/stores/settings/feature-announcements-store";
import {
  ONBOARDING_ACTS,
  onboardingActsFor,
  type OnboardingAct,
  type OnboardingActId,
} from "@/components/onboarding/onboarding-acts";
import type { OnboardingAgentGuideState } from "@/components/onboarding/onboarding-agent-guide-pane";
import {
  hostScopeFixture,
  hostScopeOptionFixture,
} from "@/components/settings/host-scope/host-scope-fixture";
import type {
  HostScope,
  HostScopeSelection,
} from "@/components/settings/host-scope/use-host-scope";
import type { IHostStreamClient } from "@traycer-clients/shared/host-transport/host-stream-client";
import type { HostStreamRpcRegistry } from "@traycer/protocol/host/registry";
import {
  useStreamHostId,
  type StreamRuntimeBinding,
} from "@/lib/host/stream-runtime-context";
import { RunnerHostContext } from "@/providers/runner-host-context";
import { SessionImportProgress } from "@/components/session-import/session-import-progress";
import { sessionImportTone } from "@/components/session-import/session-import-tone";
import { useSessionImportRun } from "@/stores/session-import/session-import-run-store";

type GuideQueryState = {
  readonly data:
    | {
        readonly content: string | null;
        readonly generatedDefaultContent: string;
        readonly providersSettled: boolean;
      }
    | undefined;
  readonly isError: boolean;
};

// Stub heavy layout-only sub-trees that have no bearing on navigation logic.
vi.mock("@/components/auth/cinematic-backdrop", () => ({
  PhotoBloom: () => <div data-testid="photo-bloom-stub" />,
  BrandMark: () => <span data-testid="brand-mark-stub" />,
}));

vi.mock("@/components/onboarding/onboarding-detected-agents", () => ({
  OnboardingDetectedAgents: () => <div data-testid="detected-agents-stub" />,
}));

vi.mock("@/components/onboarding/onboarding-theme-picker", () => ({
  OnboardingThemePicker: () => <div data-testid="theme-picker-stub" />,
}));

vi.mock("@/components/session-import/session-import-wizard", () => ({
  // Prints the host of the stream binding the tour re-provided above it, which
  // is the whole point of the picker: the wizard's scan, and the run it starts,
  // must move to whichever machine the title bar names. Also renders the real
  // (unmocked) `SessionImportProgress` behind the same `runIdle` gate the real
  // wizard uses, so a suite about switching between two importing hosts can
  // drive the actual run store and read the actual progress copy instead of a
  // second, hand-rolled stand-in for it.
  SessionImportWizard: () => {
    const hostId = useStreamHostId();
    const runIdle = useSessionImportRun(hostId).status === "idle";
    return (
      <div
        data-testid="session-import-wizard-stub"
        data-stream-host={hostId ?? ""}
      >
        {runIdle ? null : (
          <SessionImportProgress
            tone={sessionImportTone("onboarding")}
            hostId={hostId}
          />
        )}
      </div>
    );
  },
}));

// The scan subscribes over the stream transport the moment one exists, and
// this suite provides a stub client with no server behind it. The tour only
// hands the handle on to the (stubbed) wizard.
vi.mock("@/components/session-import/use-session-import-scan", () => ({
  useSessionImportScan: () => ({
    state: { kind: "scan-stub" },
    dispatch: () => undefined,
  }),
}));

/**
 * The tour re-provides the picked host's runtimes, so the six hooks a
 * `HostScope` composes (both host lists, the runner host, the plan gate) would
 * all have to stand up for a suite about act navigation. Mocked at the scope
 * boundary, exactly as the Settings panels' and the usage popover's suites do.
 */
const hostsMock = vi.hoisted(() => ({ ids: ["host-a"] as readonly string[] }));

vi.mock(
  "@/components/settings/host-scope/use-host-scope",
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import("@/components/settings/host-scope/use-host-scope")
    >()),
    useHostScopeFor: (selection: HostScopeSelection) => tourScope(selection),
  }),
);

// The unary half needs no client here: every host RPC the tour makes is
// mocked above, so what matters is only that the tour keeps rendering.
vi.mock("@/components/settings/host-scope/use-scoped-host-binding", () => ({
  useScopedHostBinding: () => null,
}));

// The stream half is this suite's subject, so it answers the way the real hook
// does: a binding of its own for an explicit pick, `null` while following.
//
// `streamStallMock` reproduces the window that makes the tour's agreement
// check necessary. The real hook holds its binding in STATE and replaces it in
// an effect, so for at least the commit after a pick it still answers for the
// host being left - or `null` - while the scope has already moved.
const streamStallMock = vi.hoisted(() => ({ hostId: null as string | null }));

vi.mock("@/components/settings/host-scope/use-scoped-stream-binding", () => ({
  useScopedStreamBinding: (scope: HostScope) =>
    scope.isViewingActive ||
    scope.hostId === null ||
    scope.hostId === streamStallMock.hostId
      ? null
      : streamBindingFor(scope.hostId),
}));

// The picker's two collaborators outside this suite's subject: the registry
// liveness poll (a query with no client behind it) and the Settings jump (a
// router this harness has no route tree for).
vi.mock("@/hooks/auth/use-registered-hosts-query", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/hooks/auth/use-registered-hosts-query")
  >()),
  useRegisteredHostsPollLiveness: () => undefined,
}));

vi.mock("@/stores/tabs/use-system-tab-modal", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/stores/tabs/use-system-tab-modal")
  >()),
  useSystemTabModalActions: () => ({
    openSettings: () => undefined,
    openHistory: () => undefined,
    close: () => undefined,
    setSection: () => undefined,
  }),
}));

/**
 * The negotiated capability the tour's length turns on. Driven directly here
 * rather than through the stream transport that backs the real hook.
 */
const sessionImportAvailableMock = vi.hoisted(() => ({ value: true }));

// The per-CLIENT form is the session-import stage's own gate, so it answers
// per host: each fake transport carries its host in `instanceId`, which is what
// lets this say "host B is too old" without the stage being told a host id it
// could have read from anywhere.
const scanUnsupportedMock = vi.hoisted(() => ({
  hostId: null as string | null,
}));

vi.mock("@/hooks/session-import/use-session-import-available", () => ({
  useSessionImportAvailable: () => sessionImportAvailableMock.value,
  useSessionImportAvailableFor: (
    client: IHostStreamClient<HostStreamRpcRegistry> | null,
  ) =>
    client === null ||
    scanUnsupportedMock.hostId === null ||
    client.instanceId !== streamClientInstanceId(scanUnsupportedMock.hostId),
}));

// The wizard is stubbed above, so nothing in this file can click its own
// Import button - this mock exists solely to prove the tour's own forward
// control never starts a run on its own.
const startSessionImportRunMock = vi.hoisted(() => vi.fn());
vi.mock("@/components/session-import/session-import-run-handle", () => ({
  startSessionImportRun: startSessionImportRunMock,
}));

// Off by default: the login-import act needs a browser bridge and saved
// logins on, which this harness has no desktop for. Suites that exercise
// the act flip it and stub the stage.
const loginImportAvailableMock = vi.hoisted(() => ({ value: false }));

vi.mock("@/hooks/browser/use-login-import-available", () => ({
  useLoginImportAvailable: () => loginImportAvailableMock.value,
}));

vi.mock("@/components/onboarding/onboarding-diorama", () => ({
  OnboardingDiorama: (props: {
    readonly actId: OnboardingActId;
    readonly agentGuide: OnboardingAgentGuideState;
  }) => (
    <div data-testid="onboarding-diorama-stub" data-act-id={props.actId}>
      {props.actId === "agent-guide" ? (
        <>
          <textarea
            data-testid="mock-agent-guide-input"
            aria-label="Agent selection guide"
            value={props.agentGuide.value}
            disabled={props.agentGuide.loading || props.agentGuide.saving}
            onChange={(event) =>
              props.agentGuide.onValueChange(event.target.value)
            }
          />
          <button
            type="button"
            data-testid="mock-agent-guide-revert"
            disabled={
              props.agentGuide.loading ||
              props.agentGuide.saving ||
              props.agentGuide.value ===
                props.agentGuide.generatedDefaultContent
            }
            onClick={props.agentGuide.onRevertToDefault}
          >
            Revert
          </button>
        </>
      ) : null}
    </div>
  ),
}));

let guideQueryState: GuideQueryState = {
  data: {
    content: "saved guide",
    generatedDefaultContent: "claude guide",
    providersSettled: true,
  },
  isError: false,
};
const setGlobalGuideMock = vi.fn((variables: { readonly content: string }) =>
  Promise.resolve({
    content: variables.content,
    generatedDefaultContent:
      guideQueryState.data?.generatedDefaultContent ?? "",
  }),
);
const resetSetGlobalGuideMock = vi.fn();

vi.mock(
  "@/hooks/agent/use-agent-selection-guide-global-onboarding-draft-query",
  () => ({
    useAgentSelectionGuideGlobalOnboardingDraftQuery: () => guideQueryState,
  }),
);

// `isPending` is DRIVEN, not pinned false: the page reads it as
// `agentGuideSaving`, and `saveAgentGuideDraft` reports failure while it is
// true. A suite that pins it false cannot reach the mid-save arm at all.
const guideSavingMock = vi.hoisted(() => ({ pending: false }));

vi.mock("@/hooks/agent/use-agent-selection-guide-set-global-mutation", () => ({
  useAgentSelectionGuideSetGlobalMutation: () => ({
    isError: false,
    isPending: guideSavingMock.pending,
    mutateAsync: setGlobalGuideMock,
    reset: resetSetGlobalGuideMock,
  }),
}));

/**
 * The scope the tour sees, over the selection the PAGE owns - so a pick made
 * through the picker really does re-point the tour, rather than the fixture
 * deciding the answer in advance.
 */
function tourScope(selection: HostScopeSelection): HostScope {
  const hosts = hostsMock.ids.map((hostId) =>
    hostScopeOptionFixture({ hostId, name: hostId }),
  );
  const picked =
    selection.scopedHostId === null
      ? (hosts[0] ?? null)
      : (hosts.find((host) => host.hostId === selection.scopedHostId) ?? null);
  return hostScopeFixture({
    hosts,
    host: picked,
    hostId: picked?.hostId ?? null,
    hostLabel: picked?.name ?? "No host",
    activeHostId: hosts[0]?.hostId ?? null,
    activeHost: hosts[0] ?? null,
    isViewingActive: selection.scopedHostId === null,
    status: selection.scopedHostId === null ? "following" : "ready",
    setHostId: selection.setScopedHostId,
  });
}

/**
 * One binding per host, kept rather than rebuilt: a fresh object each render
 * would hand the whole subtree a new stream client on every commit.
 */
const streamBindings = new Map<string, StreamRuntimeBinding>();

function streamBindingFor(hostId: string): StreamRuntimeBinding {
  const existing = streamBindings.get(hostId);
  if (existing !== undefined) return existing;
  const created: StreamRuntimeBinding = {
    wsStreamClient: fakeWsStreamClient(hostId),
    hostId,
    retain: null,
  };
  streamBindings.set(hostId, created);
  return created;
}

function streamClientInstanceId(hostId: string): string {
  return `fake-ws-stream-client:${hostId}`;
}

/** Honest enough for `useWsStreamClient`, which only asks whether it is open. */
function fakeWsStreamClient(
  hostId: string,
): IHostStreamClient<HostStreamRpcRegistry> {
  return {
    subscribe: () => {
      throw new Error("not exercised by this suite");
    },
    subscribeWithParamsProvider: () => {
      throw new Error("not exercised by this suite");
    },
    close: () => undefined,
    isClosed: () => false,
    isReady: () => true,
    notifyBearerRotated: () => undefined,
    reconnectAll: () => undefined,
    getMethodSupport: () => "unknown",
    subscribeMethodSupport: () => () => undefined,
    getMethodSchemaVersion: () => null,
    subscribeAvailabilityRecovered: () => () => undefined,
    getClosedReason: () => null,
    instanceId: streamClientInstanceId(hostId),
    onClosed: () => () => undefined,
  };
}

const navigateMock = vi.fn();
const historyBackMock = vi.fn();
const routerHistory = { length: 1, back: historyBackMock };

vi.mock("@tanstack/react-router", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@tanstack/react-router")>();
  return {
    ...actual,
    useNavigate: () => navigateMock,
    useRouter: () => ({ history: routerHistory }),
  };
});

// Import after mocks are registered.
import { OnboardingPage } from "@/components/onboarding/onboarding-page";
import type { ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { WithTestQueryClient } from "@/__tests__/with-test-query-client";
import { browserMutationKeys } from "@/lib/query-keys";
import {
  progressEntryFrom,
  useSessionImportRunStore,
} from "@/stores/session-import/session-import-run-store";

/**
 * Every link surface below reaches the external-link bridge mutation, which
 * needs a `QueryClientProvider` above it.
 */
function render(ui: ReactNode): RenderResult {
  return renderUi(ui, { wrapper: WithTestQueryClient });
}

function renderPage(args: { readonly replay: boolean }) {
  return render(
    <LazyMotion features={domAnimation}>
      <OnboardingPage replay={args.replay} />
    </LazyMotion>,
  );
}

function createRunnerHost() {
  return new MockRunnerHost({
    signInUrl: "https://auth.traycer.test/sign-in",
    authnBaseUrl: "https://auth.traycer.test",
    localHost: null,
    hosts: [],
    workspaceFolderPickerPaths: undefined,
    hasLocalHost: undefined,
    traycerCli: undefined,
  });
}

/** The tour the mocked host actually runs - not always the whole catalog. */
function visibleActs(): ReadonlyArray<OnboardingAct> {
  return onboardingActsFor({
    // jsdom's default window is desktop-wide, so the page resolves the same.
    phoneLayout: false,
    sessionImportAvailable: sessionImportAvailableMock.value,
    loginImportAvailable: loginImportAvailableMock.value,
  });
}

function currentActId(): string | null {
  return screen.getByTestId("onboarding-act").getAttribute("data-act-id");
}

async function advanceToAct(actId: OnboardingActId): Promise<void> {
  const acts = visibleActs();
  const target = acts.findIndex((act) => act.id === actId);
  const current = acts.findIndex((act) => act.id === currentActId());
  for (let index = current; index < target; index++) {
    fireEvent.click(screen.getByTestId("onboarding-advance"));
    await waitFor(() => {
      expect(currentActId()).toBe(acts[index + 1].id);
    });
  }
}

describe("OnboardingPage", () => {
  beforeEach(() => {
    useOnboardingStore.setState({ completedAt: null, step: 0 });
    useFeatureAnnouncementsStore.setState({ consumed: {} });
    window.localStorage.clear();
    sessionImportAvailableMock.value = true;
    hostsMock.ids = ["host-a"];
    streamStallMock.hostId = null;
    guideSavingMock.pending = false;
    scanUnsupportedMock.hostId = null;
    startSessionImportRunMock.mockClear();
    navigateMock.mockReset();
    historyBackMock.mockReset();
    setGlobalGuideMock.mockClear();
    resetSetGlobalGuideMock.mockClear();
    routerHistory.length = 1;
    guideQueryState = {
      data: {
        content: "saved guide",
        generatedDefaultContent: "claude guide",
        providersSettled: true,
      },
      isError: false,
    };
  });

  afterEach(() => {
    cleanup();
    useOnboardingStore.setState({ completedAt: null, step: 0 });
    useFeatureAnnouncementsStore.setState({ consumed: {} });
    window.localStorage.clear();
  });

  it("renders act 1 copy and the live miniature on initial mount", () => {
    renderPage({ replay: false });

    const firstAct = ONBOARDING_ACTS[0];
    expect(
      screen.getByText(firstAct.title.replace(/\s+/g, " "), {
        exact: false,
      }),
    ).not.toBeNull();
    expect(screen.getByTestId("onboarding-diorama-stub")).not.toBeNull();
  });

  it("starts a new onboarding session from act 1 instead of a stale store step", async () => {
    useOnboardingStore.setState({ completedAt: 123, step: 3 });

    renderPage({ replay: true });

    const firstAct = ONBOARDING_ACTS[0];
    await waitFor(() => {
      expect(
        screen.getByText(firstAct.title.replace(/\s+/g, " "), {
          exact: false,
        }),
      ).not.toBeNull();
      expect(useOnboardingStore.getState().completedAt).toBe(123);
      expect(useOnboardingStore.getState().step).toBe(0);
    });
  });

  it("shows the continue button (not 'Enter Traycer') on the first act", () => {
    renderPage({ replay: false });

    expect(screen.getByTestId("onboarding-advance").textContent).toContain(
      "Continue",
    );
  });

  it("shows the client version in the footer", () => {
    renderPage({ replay: false });

    expect(screen.getByText("v0.0.0")).not.toBeNull();
  });

  it("wires onboarding footer links to the website destinations", async () => {
    const host = createRunnerHost();
    render(
      <RunnerHostContext.Provider value={host}>
        <LazyMotion features={domAnimation}>
          <OnboardingPage replay={false} />
        </LazyMotion>
      </RunnerHostContext.Provider>,
    );

    const expectedLinks = [
      ["Features", traycerInfo.mainWebsiteFeatures],
      ["Enterprise", traycerInfo.mainWebsiteEnterprise],
      ["Support", traycerInfo.mainWebsiteContactUs],
    ] as const;

    expectedLinks.forEach(([label, url]) => {
      const link = screen.getByRole<HTMLAnchorElement>("link", {
        name: label,
      });
      expect(link.href).toBe(url);
      fireEvent.click(link);
    });

    // The bridge is a mutation now, so each handoff lands a microtask later.
    await waitFor(() => {
      expect(host.openedExternalLinks).toEqual(
        expectedLinks.map(([, url]) => url),
      );
    });
  });

  it("advances through every act while keeping the Figma continue label", async () => {
    renderPage({ replay: false });

    const acts = visibleActs();
    for (let index = 0; index < acts.length - 1; index++) {
      const advanceButton = screen.getByTestId("onboarding-advance");
      expect(advanceButton.textContent).toContain("Continue");
      fireEvent.click(advanceButton);
      await waitFor(() => {
        expect(currentActId()).toBe(acts[index + 1].id);
      });
    }

    expect(screen.getByTestId("onboarding-advance").textContent).toContain(
      "Start building",
    );
  });

  it("omits the session-import act entirely when the host cannot scan sessions", async () => {
    // The act's stage IS the live wizard, so an unsupported host has nothing to
    // put there: the act must be unreachable, not blank.
    sessionImportAvailableMock.value = false;
    renderPage({ replay: false });

    const acts = visibleActs();
    expect(acts.map((act) => act.id)).not.toContain("session-import");

    const walked: Array<string | null> = [currentActId()];
    for (let index = 0; index < acts.length - 1; index++) {
      expect(screen.queryByTestId("session-import-wizard-stub")).toBeNull();
      fireEvent.click(screen.getByTestId("onboarding-advance"));
      await waitFor(() => {
        expect(currentActId()).toBe(acts[index + 1].id);
      });
      walked.push(currentActId());
    }

    expect(walked).toEqual(acts.map((act) => act.id));
    expect(screen.queryByTestId("session-import-wizard-stub")).toBeNull();

    // The act after providers is now delegation, and the tour still ends on the
    // same last act - which finishes onboarding rather than overrunning.
    expect(walked[4]).toBe("agent-guide");
    expect(screen.getByTestId("onboarding-advance").textContent).toContain(
      "Start building",
    );
    fireEvent.click(screen.getByTestId("onboarding-advance"));
    await waitFor(() => {
      expect(useOnboardingStore.getState().completedAt).not.toBeNull();
    });
  });

  it("keeps the session-import act, wizard and all, when the host can scan", async () => {
    renderPage({ replay: false });

    expect(visibleActs().map((act) => act.id)).toContain("session-import");
    await advanceToAct("session-import");

    expect(currentActId()).toBe("session-import");
    expect(screen.getByTestId("session-import-wizard-stub")).not.toBeNull();
    // This act has no mock-up to preview: its diorama slot holds the live
    // wizard's own stage, not the shared `OnboardingDiorama`.
    expect(
      screen.getByTestId("onboarding-session-import-stage"),
    ).not.toBeNull();
    expect(screen.queryByTestId("onboarding-diorama-stub")).toBeNull();
  });

  it("does not start an import when 'Start building' is pressed on the session-import act", async () => {
    // The wizard's own Import button is the only thing that starts a run; an
    // earlier version made Continue do both, which imported the default
    // selection without an explicit ask.
    renderPage({ replay: false });

    const acts = visibleActs();
    await advanceToAct(acts[acts.length - 1].id);
    expect(currentActId()).toBe("session-import");
    expect(screen.getByTestId("onboarding-advance").textContent).toContain(
      "Start building",
    );

    fireEvent.click(screen.getByTestId("onboarding-advance"));

    await waitFor(() => {
      expect(useOnboardingStore.getState().completedAt).not.toBeNull();
    });
    expect(startSessionImportRunMock).not.toHaveBeenCalled();
  });

  it("first-run finish (no replay flag) marks complete and opens a fresh draft tab", async () => {
    renderPage({ replay: false });

    const acts = visibleActs();
    await advanceToAct(acts[acts.length - 1].id);

    // Now on the last act.
    expect(useOnboardingStore.getState().completedAt).toBeNull();

    fireEvent.click(screen.getByTestId("onboarding-advance"));

    await waitFor(() => {
      expect(setGlobalGuideMock).toHaveBeenCalledWith({
        content: "saved guide",
      });
    });
    await waitFor(() => {
      expect(useOnboardingStore.getState().completedAt).not.toBeNull();
    });
    expect(typeof useOnboardingStore.getState().completedAt).toBe("number");
    expect(navigateMock).toHaveBeenCalledWith({
      to: "/draft/new",
      replace: true,
    });
    expect(historyBackMock).not.toHaveBeenCalled();
  });

  it("shows the generated guide in onboarding, keeps it in memory on Continue, and saves on finish", async () => {
    guideQueryState = {
      data: {
        content: null,
        generatedDefaultContent: "claude guide",
        providersSettled: true,
      },
      isError: false,
    };
    renderPage({ replay: false });

    await advanceToAct("agent-guide");

    const input = screen.getByTestId<HTMLTextAreaElement>(
      "mock-agent-guide-input",
    );
    expect(input.value).toBe("claude guide");

    fireEvent.change(input, { target: { value: "custom onboarding guide" } });
    fireEvent.click(screen.getByTestId("onboarding-advance"));

    await waitFor(() => {
      expect(
        screen.getByTestId("onboarding-act").getAttribute("data-act-id"),
      ).toBe("command-theme");
    });
    expect(setGlobalGuideMock).not.toHaveBeenCalled();

    // command-theme is no longer the last act - session-import now follows
    // it - so Continue here only advances, and the guide is only saved once
    // "Start building" is pressed on that final act.
    fireEvent.click(screen.getByTestId("onboarding-advance"));

    await waitFor(() => {
      expect(
        screen.getByTestId("onboarding-act").getAttribute("data-act-id"),
      ).toBe("session-import");
    });
    expect(setGlobalGuideMock).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId("onboarding-advance"));

    await waitFor(() => {
      expect(setGlobalGuideMock).toHaveBeenCalledWith({
        content: "custom onboarding guide",
      });
    });
  });

  it("keeps onboarding navigation available while provider discovery settles", async () => {
    guideQueryState = {
      data: {
        content: null,
        generatedDefaultContent: "traycer guide",
        providersSettled: false,
      },
      isError: false,
    };
    renderPage({ replay: false });

    await advanceToAct("agent-guide");

    const input = screen.getByRole<HTMLTextAreaElement>("textbox", {
      name: "Agent selection guide",
    });
    expect(input.disabled).toBe(true);
    expect(
      screen.getByRole<HTMLButtonElement>("button", { name: /continue/i })
        .disabled,
    ).toBe(false);
    expect(
      screen.getByRole<HTMLButtonElement>("button", { name: /skip intro/i })
        .disabled,
    ).toBe(false);

    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => {
      expect(useOnboardingStore.getState().completedAt).not.toBeNull();
    });
    expect(setGlobalGuideMock).not.toHaveBeenCalled();
  });

  it("persists an edited existing guide even while provider discovery is still settling", async () => {
    guideQueryState = {
      data: {
        content: "saved guide",
        generatedDefaultContent: "claude guide",
        providersSettled: false,
      },
      isError: false,
    };
    renderPage({ replay: false });

    await advanceToAct("agent-guide");

    const input = screen.getByRole<HTMLTextAreaElement>("textbox", {
      name: "Agent selection guide",
    });
    expect(input.disabled).toBe(false);

    fireEvent.change(input, {
      target: { value: "edited while providers settle" },
    });
    fireEvent.click(screen.getByRole("button", { name: /skip intro/i }));

    await waitFor(() => {
      expect(setGlobalGuideMock).toHaveBeenCalledWith({
        content: "edited while providers settle",
      });
    });
    await waitFor(() => {
      expect(useOnboardingStore.getState().completedAt).not.toBeNull();
    });
  });

  it("never traps the user when the onboarding guide fails to load", async () => {
    guideQueryState = { data: undefined, isError: true };
    renderPage({ replay: false });

    await advanceToAct("agent-guide");

    // The optional guide keeps spinning (editor disabled) since the read never
    // resolved, but it must not block onboarding: Skip and Advance stay enabled.
    expect(
      screen.getByTestId<HTMLTextAreaElement>("mock-agent-guide-input")
        .disabled,
    ).toBe(true);
    expect(
      screen.getByTestId<HTMLButtonElement>("onboarding-skip").disabled,
    ).toBe(false);
    expect(
      screen.getByTestId<HTMLButtonElement>("onboarding-advance").disabled,
    ).toBe(false);

    // Skipping completes onboarding without attempting to persist an unloaded
    // guide.
    fireEvent.click(screen.getByTestId("onboarding-skip"));
    await waitFor(() => {
      expect(useOnboardingStore.getState().completedAt).not.toBeNull();
    });
    expect(setGlobalGuideMock).not.toHaveBeenCalled();
  });

  it("refreshes an untouched onboarding guide from regenerated defaults and preserves edits", async () => {
    guideQueryState = {
      data: {
        content: null,
        generatedDefaultContent: "claude guide",
        providersSettled: true,
      },
      isError: false,
    };
    const { rerender } = renderPage({ replay: false });

    await advanceToAct("agent-guide");

    const input = screen.getByTestId<HTMLTextAreaElement>(
      "mock-agent-guide-input",
    );
    expect(input.value).toBe("claude guide");

    guideQueryState = {
      data: {
        content: null,
        generatedDefaultContent: "codex guide",
        providersSettled: true,
      },
      isError: false,
    };
    rerender(
      <LazyMotion features={domAnimation}>
        <OnboardingPage replay={false} />
      </LazyMotion>,
    );

    await waitFor(() => {
      expect(
        screen.getByTestId<HTMLTextAreaElement>("mock-agent-guide-input").value,
      ).toBe("codex guide");
    });

    fireEvent.change(
      screen.getByTestId<HTMLTextAreaElement>("mock-agent-guide-input"),
      {
        target: { value: "hand-written guide" },
      },
    );
    guideQueryState = {
      data: {
        content: null,
        generatedDefaultContent: "opencode guide",
        providersSettled: true,
      },
      isError: false,
    };
    rerender(
      <LazyMotion features={domAnimation}>
        <OnboardingPage replay={false} />
      </LazyMotion>,
    );

    expect(
      screen.getByTestId<HTMLTextAreaElement>("mock-agent-guide-input").value,
    ).toBe("hand-written guide");

    fireEvent.click(screen.getByTestId("mock-agent-guide-revert"));
    expect(
      screen.getByTestId<HTMLTextAreaElement>("mock-agent-guide-input").value,
    ).toBe("opencode guide");
  });

  it("replaces cached generated onboarding content with later saved disk content", async () => {
    guideQueryState = {
      data: {
        content: null,
        generatedDefaultContent: "claude guide",
        providersSettled: true,
      },
      isError: false,
    };
    const { rerender } = renderPage({ replay: false });

    await advanceToAct("agent-guide");

    expect(
      screen.getByTestId<HTMLTextAreaElement>("mock-agent-guide-input").value,
    ).toBe("claude guide");

    guideQueryState = {
      data: {
        content: "saved disk guide",
        generatedDefaultContent: "codex guide",
        providersSettled: true,
      },
      isError: false,
    };
    rerender(
      <LazyMotion features={domAnimation}>
        <OnboardingPage replay={false} />
      </LazyMotion>,
    );

    await waitFor(() => {
      expect(
        screen.getByTestId<HTMLTextAreaElement>("mock-agent-guide-input").value,
      ).toBe("saved disk guide");
    });
  });

  it("shows existing guide content without replacing it with provider defaults", async () => {
    const { rerender } = renderPage({ replay: false });

    await advanceToAct("agent-guide");

    const input = screen.getByTestId<HTMLTextAreaElement>(
      "mock-agent-guide-input",
    );
    expect(input.value).toBe("saved guide");

    guideQueryState = {
      data: {
        content: "saved guide",
        generatedDefaultContent: "codex guide",
        providersSettled: true,
      },
      isError: false,
    };
    rerender(
      <LazyMotion features={domAnimation}>
        <OnboardingPage replay={false} />
      </LazyMotion>,
    );

    await waitFor(() => {
      expect(
        screen.getByTestId<HTMLTextAreaElement>("mock-agent-guide-input").value,
      ).toBe("saved guide");
    });

    fireEvent.click(screen.getByTestId("mock-agent-guide-revert"));
    expect(
      screen.getByTestId<HTMLTextAreaElement>("mock-agent-guide-input").value,
    ).toBe("codex guide");

    guideQueryState = {
      data: {
        content: "saved guide",
        generatedDefaultContent: "opencode guide",
        providersSettled: true,
      },
      isError: false,
    };
    rerender(
      <LazyMotion features={domAnimation}>
        <OnboardingPage replay={false} />
      </LazyMotion>,
    );

    await waitFor(() => {
      expect(
        screen.getByTestId<HTMLTextAreaElement>("mock-agent-guide-input").value,
      ).toBe("codex guide");
    });
  });

  it("replay finish (replay flag) saves the visible guide, marks complete, and returns to the prior route", async () => {
    renderPage({ replay: true });

    fireEvent.click(screen.getByTestId("onboarding-skip"));

    await waitFor(() => {
      expect(setGlobalGuideMock).toHaveBeenCalledWith({
        content: "saved guide",
      });
    });
    await waitFor(() => {
      expect(useOnboardingStore.getState().completedAt).not.toBeNull();
    });
    expect(historyBackMock).toHaveBeenCalledTimes(1);
    expect(navigateMock).not.toHaveBeenCalled();
  });

  it("clicking the skip button on a first run saves the visible guide and opens a fresh draft tab", async () => {
    guideQueryState = {
      data: {
        content: null,
        generatedDefaultContent: "claude guide",
        providersSettled: true,
      },
      isError: false,
    };
    renderPage({ replay: false });

    fireEvent.click(screen.getByTestId("onboarding-skip"));

    await waitFor(() => {
      expect(setGlobalGuideMock).toHaveBeenCalledWith({
        content: "claude guide",
      });
    });
    await waitFor(() => {
      expect(useOnboardingStore.getState().completedAt).not.toBeNull();
    });
    expect(typeof useOnboardingStore.getState().completedAt).toBe("number");
    expect(navigateMock).toHaveBeenCalledWith({
      to: "/draft/new",
      replace: true,
    });
  });

  it("consumes the login-import announcement on Skip when the import is available", async () => {
    loginImportAvailableMock.value = true;
    renderPage({ replay: false });

    fireEvent.click(screen.getByTestId("onboarding-skip"));

    await waitFor(() => {
      expect(useOnboardingStore.getState().completedAt).not.toBeNull();
    });
    expect(
      useFeatureAnnouncementsStore.getState().consumed["login-import"],
    ).toBeDefined();
  });

  it("consumes the login-import announcement on Skip even when the import is unavailable, so a pending availability read cannot resurrect the toast", async () => {
    loginImportAvailableMock.value = false;
    renderPage({ replay: false });

    fireEvent.click(screen.getByRole("button", { name: /Skip intro/ }));

    await waitFor(() => {
      expect(useOnboardingStore.getState().completedAt).not.toBeNull();
    });
    expect(
      useFeatureAnnouncementsStore.getState().consumed["login-import"],
    ).toBeDefined();
  });

  it("consumes the login-import announcement on a completed tour (Continue through the last act)", async () => {
    loginImportAvailableMock.value = true;
    renderPage({ replay: false });

    const acts = visibleActs();
    await advanceToAct(acts[acts.length - 1].id);
    fireEvent.click(screen.getByTestId("onboarding-advance"));

    await waitFor(() => {
      expect(useOnboardingStore.getState().completedAt).not.toBeNull();
    });
    expect(
      useFeatureAnnouncementsStore.getState().consumed["login-import"],
    ).toBeDefined();
  });

  it("disables Back while a login import is pending, and re-enables once it settles", async () => {
    loginImportAvailableMock.value = true;
    const client = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false },
      },
    });
    renderUi(
      <QueryClientProvider client={client}>
        <LazyMotion features={domAnimation}>
          <OnboardingPage replay={false} />
        </LazyMotion>
      </QueryClientProvider>,
    );

    await advanceToAct("login-import");
    expect(currentActId()).toBe("login-import");

    // Drives the SAME mutation cache `useIsMutating` reads, under the exact
    // key the import mutation uses - no need to walk the whole import flow's
    // UI to get a pending mutation registered.
    // A holder rather than a `let`: the assignment happens inside the
    // mutation's callback, which TypeScript's narrowing cannot see.
    const releaseImport: { current: (() => void) | null } = { current: null };
    const mutation = client.getMutationCache().build(client, {
      mutationKey: browserMutationKeys.importLogins(),
      mutationFn: () =>
        new Promise<void>((resolve) => {
          releaseImport.current = () => {
            resolve();
          };
        }),
    });
    void mutation.execute(undefined);

    await waitFor(() => {
      expect(
        screen.getByRole<HTMLButtonElement>("button", { name: /Back/ })
          .disabled,
      ).toBe(true);
    });

    // The ArrowLeft path is the same guard as the button: the step must not
    // move while the import is in flight.
    const stepBeforeArrowLeft = useOnboardingStore.getState().step;
    fireEvent.keyDown(window, { key: "ArrowLeft" });
    expect(useOnboardingStore.getState().step).toBe(stepBeforeArrowLeft);
    expect(currentActId()).toBe("login-import");

    const release = releaseImport.current;
    if (release === null) throw new Error("no import mutation to release");
    release();

    await waitFor(() => {
      expect(
        screen.getByRole<HTMLButtonElement>("button", { name: /Back/ })
          .disabled,
      ).toBe(false);
    });

    fireEvent.click(screen.getByRole("button", { name: /Back/ }));
    await waitFor(() => {
      expect(currentActId()).not.toBe("login-import");
    });
  });

  it("consumes the login-import announcement on Skip even after the act was dropped from the list mid-tour", async () => {
    loginImportAvailableMock.value = true;
    const view = renderPage({ replay: false });

    // The tour-scoped marker is set by an effect that has to observe the act
    // in the list at least once.
    await waitFor(() => {
      expect(visibleActs().map((act) => act.id)).toContain("login-import");
    });

    loginImportAvailableMock.value = false;
    view.rerender(
      <LazyMotion features={domAnimation}>
        <OnboardingPage replay={false} />
      </LazyMotion>,
    );

    await waitFor(() => {
      expect(visibleActs().map((act) => act.id)).not.toContain("login-import");
    });

    fireEvent.click(screen.getByTestId("onboarding-skip"));

    await waitFor(() => {
      expect(useOnboardingStore.getState().completedAt).not.toBeNull();
    });
    // The marker, not the live availability: the act was offered at some
    // point during this tour, even though the list held it for only part of
    // it.
    expect(
      useFeatureAnnouncementsStore.getState().consumed["login-import"],
    ).toBeDefined();
  });

  it("keeps the user on the SAME act by id when the act list changes under them", async () => {
    // The shorter tour: login import starts unavailable, so agent-guide
    // sits one index earlier than it does in the full catalog.
    loginImportAvailableMock.value = false;
    const view = renderPage({ replay: false });

    await advanceToAct("agent-guide");
    expect(currentActId()).toBe("agent-guide");

    // Login import resolves available mid-tour and a new act is inserted
    // ahead of agent-guide, which shifts its index by one.
    loginImportAvailableMock.value = true;
    view.rerender(
      <LazyMotion features={domAnimation}>
        <OnboardingPage replay={false} />
      </LazyMotion>,
    );

    await waitFor(() => {
      expect(currentActId()).toBe("agent-guide");
    });
    // The store's own position moved WITH the act, to wherever agent-guide
    // now sits in the longer tour - never left pointing at the login-import
    // act that took its old index.
    const agentGuideIndex = visibleActs().findIndex(
      (entry) => entry.id === "agent-guide",
    );
    expect(useOnboardingStore.getState().step).toBe(agentGuideIndex);
  });

  it("a normal Continue still advances to the next act after a re-seat", async () => {
    loginImportAvailableMock.value = false;
    const view = renderPage({ replay: false });
    await advanceToAct("agent-guide");

    loginImportAvailableMock.value = true;
    view.rerender(
      <LazyMotion features={domAnimation}>
        <OnboardingPage replay={false} />
      </LazyMotion>,
    );
    await waitFor(() => {
      expect(currentActId()).toBe("agent-guide");
    });

    await advanceToAct("command-theme");

    expect(currentActId()).toBe("command-theme");
  });

  function streamHostOfWizard(): string | null {
    return screen
      .getByTestId("session-import-wizard-stub")
      .getAttribute("data-stream-host");
  }

  it("re-points the import stage's stream at a newly picked host", async () => {
    hostsMock.ids = ["host-a", "host-b"];
    renderPage({ replay: false });
    await advanceToAct("session-import");

    // Following the host the tour opened on: no transport of its own, which is
    // exactly what the tour read before there was a picker.
    expect(streamHostOfWizard()).toBe("");

    fireEvent.click(screen.getByTestId("settings-host-switcher"));
    fireEvent.click(screen.getByTestId("settings-host-switcher-option-host-b"));

    await waitFor(() => {
      expect(streamHostOfWizard()).toBe("host-b");
    });
  });

  it("saves the guide draft to the host being left before the pick commits", async () => {
    hostsMock.ids = ["host-a", "host-b"];
    // Held open so the ORDER is observable rather than inferred from a promise
    // that resolves in the same tick as the click.
    const save = { release: (): void => undefined };
    setGlobalGuideMock.mockImplementationOnce(
      (variables: { readonly content: string }) =>
        new Promise((resolve) => {
          save.release = () =>
            resolve({
              content: variables.content,
              generatedDefaultContent: "claude guide",
            });
        }),
    );
    renderPage({ replay: false });

    await advanceToAct("agent-guide");
    fireEvent.change(screen.getByTestId("mock-agent-guide-input"), {
      target: { value: "notes for host a" },
    });
    await advanceToAct("session-import");

    fireEvent.click(screen.getByTestId("settings-host-switcher"));
    fireEvent.click(screen.getByTestId("settings-host-switcher-option-host-b"));

    expect(setGlobalGuideMock).toHaveBeenCalledWith({
      content: "notes for host a",
    });
    // The write is still in flight, so the tour is still on the host it is
    // writing to - a pick that committed here would land host A's draft on
    // host B.
    expect(streamHostOfWizard()).toBe("");

    act(() => save.release());
    await waitFor(() => {
      expect(streamHostOfWizard()).toBe("host-b");
    });
  });

  it("withholds the wizard while the stream still names the host being left", async () => {
    // The scope resolves a pick synchronously; the transport does not. Between
    // the two, the wizard on screen would scan - and import from - host A under
    // a title bar reading host B.
    hostsMock.ids = ["host-a", "host-b"];
    streamStallMock.hostId = "host-b";
    const view = renderPage({ replay: false });
    await advanceToAct("session-import");

    fireEvent.click(screen.getByTestId("settings-host-switcher"));
    fireEvent.click(screen.getByTestId("settings-host-switcher-option-host-b"));

    await waitFor(() => {
      expect(screen.getByTestId("host-scope-connecting")).not.toBeNull();
    });
    expect(screen.queryByTestId("session-import-wizard-stub")).toBeNull();

    // And it is a WAIT, not a dead end: the wizard returns on the host it
    // names the moment the transport catches up.
    streamStallMock.hostId = null;
    view.rerender(
      <LazyMotion features={domAnimation}>
        <OnboardingPage replay={false} />
      </LazyMotion>,
    );
    await waitFor(() => {
      expect(streamHostOfWizard()).toBe("host-b");
    });
  });

  it("honours the latest pick when a second one lands mid-save", async () => {
    hostsMock.ids = ["host-a", "host-b", "host-c"];
    const save = { release: (): void => undefined };
    setGlobalGuideMock.mockImplementationOnce(
      (variables: { readonly content: string }) =>
        new Promise((resolve) => {
          guideSavingMock.pending = true;
          save.release = () => {
            guideSavingMock.pending = false;
            resolve({
              content: variables.content,
              generatedDefaultContent: "claude guide",
            });
          };
        }),
    );
    const view = renderPage({ replay: false });

    await advanceToAct("agent-guide");
    fireEvent.change(screen.getByTestId("mock-agent-guide-input"), {
      target: { value: "notes for host a" },
    });
    await advanceToAct("session-import");

    fireEvent.click(screen.getByTestId("settings-host-switcher"));
    fireEvent.click(screen.getByTestId("settings-host-switcher-option-host-b"));

    // The page must SEE the write in flight, which is the state that used to
    // make `saveAgentGuideDraft` report failure and the next pick vanish.
    view.rerender(
      <LazyMotion features={domAnimation}>
        <OnboardingPage replay={false} />
      </LazyMotion>,
    );

    // Second thoughts, while the first pick's write is still open.
    fireEvent.click(screen.getByTestId("settings-host-switcher"));
    fireEvent.click(screen.getByTestId("settings-host-switcher-option-host-c"));

    // One write of one draft, not two: the second pick replaced the
    // destination rather than starting another save of the same content.
    expect(setGlobalGuideMock).toHaveBeenCalledTimes(1);

    act(() => save.release());
    await waitFor(() => {
      expect(streamHostOfWizard()).toBe("host-c");
    });
  });

  it("refuses the wizard on a picked host too old to scan sessions", async () => {
    // The act EXISTS because the ambient host can scan; the picked one is a
    // different machine and may predate the feature entirely.
    hostsMock.ids = ["host-a", "host-b"];
    scanUnsupportedMock.hostId = "host-b";
    renderPage({ replay: false });
    await advanceToAct("session-import");
    expect(screen.getByTestId("session-import-wizard-stub")).not.toBeNull();

    fireEvent.click(screen.getByTestId("settings-host-switcher"));
    fireEvent.click(screen.getByTestId("settings-host-switcher-option-host-b"));

    await waitFor(() => {
      expect(
        screen.getByTestId("onboarding-host-unavailable").textContent,
      ).toContain("host-b can't import sessions");
    });
    expect(screen.queryByTestId("session-import-wizard-stub")).toBeNull();
  });

  it("reads as plain text, not a picker, on a single-host account", async () => {
    renderPage({ replay: false });
    await advanceToAct("session-import");

    expect(screen.getByTestId("onboarding-host-name").textContent).toBe(
      "host-a",
    );
    expect(screen.queryByTestId("settings-host-switcher")).toBeNull();
  });

  function progressText(): string {
    return screen.getByTestId("session-import-progress").textContent;
  }

  function pickHost(hostId: string): void {
    fireEvent.click(screen.getByTestId("settings-host-switcher"));
    fireEvent.click(
      screen.getByTestId(`settings-host-switcher-option-${hostId}`),
    );
  }

  it("shows each host's own import progress when switching between two hosts that are both importing", async () => {
    hostsMock.ids = ["host-a", "host-b"];
    // Both hosts' slices are host-scoped in the run store, but the store is a
    // module singleton this suite does not otherwise touch - clear both
    // before seeding so an earlier test's run (there is none today) could
    // never bleed in.
    useSessionImportRunStore.setState({ runs: new Map() });

    renderPage({ replay: false });
    await advanceToAct("session-import");

    // The tour opens FOLLOWING host A, which rides the ambient (here: absent)
    // ws-stream transport rather than a scoped one - see
    // `useScopedStreamBinding`'s `isViewingActive` branch. Picking host A
    // explicitly through the switcher is what the real app does the moment a
    // user glances at the picker, and it is the only way this harness ever
    // resolves the wizard's stream to a real "host-a", which
    // `SessionImportProgress` needs in order to read host A's own slice
    // rather than the idle fallback a `null` host id resolves to.
    pickHost("host-a");
    await waitFor(() => {
      expect(streamHostOfWizard()).toBe("host-a");
    });

    act(() => {
      const store = useSessionImportRunStore.getState();
      store.markStarting("host-a", new Map());
      store.applyStarted("host-a", {
        runId: "run-a",
        total: 4,
        attached: false,
      });
      store.applyProgress(
        "host-a",
        progressEntryFrom({
          runId: "run-a",
          harness: "claude",
          nativeSessionId: "a1",
          outcome: { kind: "imported", epicId: "epic-a1", chatId: "chat-a1" },
        }),
      );
      store.applyProgress(
        "host-a",
        progressEntryFrom({
          runId: "run-a",
          harness: "claude",
          nativeSessionId: "a2",
          outcome: { kind: "imported", epicId: "epic-a2", chatId: "chat-a2" },
        }),
      );
    });
    expect(progressText()).toContain("Importing 2 of 4…");

    // Switch to host B, which is also mid-import - a separate slice under a
    // separate key in the same store.
    pickHost("host-b");
    await waitFor(() => {
      expect(streamHostOfWizard()).toBe("host-b");
    });

    act(() => {
      const store = useSessionImportRunStore.getState();
      store.markStarting("host-b", new Map());
      store.applyStarted("host-b", {
        runId: "run-b",
        total: 10,
        attached: false,
      });
      store.applyProgress(
        "host-b",
        progressEntryFrom({
          runId: "run-b",
          harness: "claude",
          nativeSessionId: "b1",
          outcome: { kind: "imported", epicId: "epic-b1", chatId: "chat-b1" },
        }),
      );
    });
    expect(progressText()).toContain("Importing 1 of 10…");

    // A frame lands for host A while B is the one on screen. It must be
    // folded into A's slice - the wizard reads `useSessionImportRun`, keyed
    // by host - and must not touch what B's view is showing.
    act(() => {
      useSessionImportRunStore.getState().applyProgress(
        "host-a",
        progressEntryFrom({
          runId: "run-a",
          harness: "claude",
          nativeSessionId: "a3",
          outcome: { kind: "imported", epicId: "epic-a3", chatId: "chat-a3" },
        }),
      );
    });
    expect(progressText()).toContain("Importing 1 of 10…");

    // Switching back to host A shows A's own progress, including the frame
    // that landed while B was on screen - nothing was lost, and nothing of
    // B's leaked in.
    pickHost("host-a");
    await waitFor(() => {
      expect(streamHostOfWizard()).toBe("host-a");
    });
    expect(progressText()).toContain("Importing 3 of 4…");
  });
});
