import { useEffect, type ReactNode } from "react";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import type { Props as JoyrideProps } from "react-joyride";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type Mock,
} from "vitest";
import { OnboardingFlowHost } from "@/components/onboarding/onboarding-flow-host";
import { ONBOARDING_COMPLETION_TOAST_ID } from "@/components/onboarding/tour/onboarding-completion-toast";
import { resetActivationForTests } from "@/components/onboarding/tour/tour-activation";
import { resetTourDismissalForTests } from "@/components/onboarding/tour/use-onboarding-tour-controller";
import { resetTourNavigationForTests } from "@/components/onboarding/tour/use-onboarding-tour-navigation";
import { resetModalPresenceForTests } from "@/components/ui/modal-presence";
import { TRAYCER_GITHUB_URL } from "@/lib/onboarding-links";
import { useAuthStore } from "@/stores/auth/auth-store";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import { useLandingDraftStore } from "@/stores/home/landing-draft-store";
import {
  INITIAL_FLOW,
  useOnboardingFlowStore,
} from "@/stores/onboarding/onboarding-flow-store";
import { useOnboardingPresenceStore } from "@/stores/onboarding/onboarding-presence-store";
import { useLandingReceiptsStore } from "@/stores/onboarding/landing-receipts-store";
import { useFeatureAnnouncementsStore } from "@/stores/settings/feature-announcements-store";
import { tabItemId } from "@/stores/tabs/layout";
import { setSystemTabModalApi } from "@/stores/tabs/system-tab-modal-bridge";
import type { SystemTabModalApi } from "@/stores/tabs/use-system-tab-modal";
import { useTabsStore } from "@/stores/tabs/store";
import {
  emit,
  focusDraftTab,
  joyride,
  props,
  mountDraftSurface,
  mountEpicSurface,
  next,
  type Surface,
} from "@/components/onboarding/tour/__tests__/joyride-test-harness";

/**
 * The shell-level wiring end to end: the flow host's gates, launch resume,
 * entry navigation through the tab-navigation seam, and the completion
 * toast - against the real flow / presence / receipts / draft / tab /
 * announcement stores. Faked at the boundaries only: host readiness (the
 * gate renders its children), the router's `navigate`, the seam's
 * `activateTabIntent` (what is asked of it is the contract), the OS link
 * opener, sonner (the element it is handed is rendered here) and Joyride
 * (the harness fires its events).
 */

const seam = vi.hoisted(() => ({
  activateTabIntent: vi.fn(),
  navigate: vi.fn(),
  openLink: vi.fn(),
  toast:
    vi.fn<(element: ReactNode, options: { readonly id: string }) => void>(),
  toastDismiss: vi.fn(),
}));

vi.mock("react-joyride", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-joyride")>();
  const harness =
    await import("@/components/onboarding/tour/__tests__/joyride-test-harness");
  function FakeJoyride(props: JoyrideProps): null {
    harness.joyride.props = props;
    useEffect(() => {
      harness.joyride.mounts += 1;
    }, []);
    return null;
  }
  return { ...actual, Joyride: FakeJoyride };
});

vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => seam.navigate,
}));

vi.mock("@/lib/tab-navigation", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/tab-navigation")>();
  return { ...actual, activateTabIntent: seam.activateTabIntent };
});

vi.mock("@/components/layout/host-readiness-controller", () => ({
  HostScopeReady: (props: { readonly children: ReactNode }) => props.children,
}));

vi.mock("@/lib/links/open-link", () => ({
  useOpenLink: () => seam.openLink,
}));

vi.mock("sonner", () => ({
  toast: Object.assign(seam.toast, { dismiss: seam.toastDismiss }),
}));

// The welcome modal's SHAPE, not its pages: a modal shadcn Dialog (so it
// registers as a presented modal exactly as the real one does), `startModal`
// on mount, `modalOpen` presence while mounted, Esc → pauseModal + onPaused,
// and a Continue that finishes into the no-sessions chain. Its pages have
// their own suites; what is under test here is the seam with the tour.
vi.mock("@/components/onboarding/welcome/welcome-modal", async () => {
  const react = await import("react");
  const dialog = await import("@/components/ui/dialog");
  const presence =
    await import("@/stores/onboarding/onboarding-presence-store");
  const flowStore = await import("@/stores/onboarding/onboarding-flow-store");
  function WelcomeModal(props: { readonly onPaused: () => void }) {
    const setModalOpen = presence.useOnboardingPresenceStore(
      (state) => state.setModalOpen,
    );
    react.useEffect(() => {
      const flow = flowStore.useOnboardingFlowStore.getState();
      if (flow.modal === "pending") flow.startModal();
    }, []);
    react.useEffect(() => {
      setModalOpen(true);
      return () => {
        setModalOpen(false);
      };
    }, [setModalOpen]);
    return (
      <dialog.Dialog
        open
        onOpenChange={(open) => {
          if (open) return;
          flowStore.useOnboardingFlowStore.getState().pauseModal();
          props.onPaused();
        }}
      >
        <dialog.DialogContent
          data-testid="welcome-modal"
          showCloseButton={false}
        >
          <dialog.DialogTitle>Welcome</dialog.DialogTitle>
          <dialog.DialogDescription>stand-in</dialog.DialogDescription>
          <button
            type="button"
            onClick={() => {
              flowStore.useOnboardingFlowStore
                .getState()
                .finishModal("no-sessions");
            }}
          >
            Continue
          </button>
        </dialog.DialogContent>
      </dialog.Dialog>
    );
  }
  return { WelcomeModal };
});

vi.mock("@/lib/analytics", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/analytics")>();
  return {
    ...actual,
    Analytics: {
      getInstance: () => ({
        track: () => undefined,
        identify: () => undefined,
        reset: () => undefined,
      }),
    },
  };
});

const DRAFT_ID = "draft-flow";
const EPIC_TAB_ID = "tab-flow";

function flow() {
  return useOnboardingFlowStore.getState();
}

function signIn(): void {
  useAuthStore
    .getState()
    .setSignedIn(
      { userId: "user-flow", userName: "U", email: "u@example.com" },
      { userId: "user-flow", username: "U" },
      [],
    );
}

function fakeSettingsApi(): SystemTabModalApi & {
  readonly openSettings: Mock<SystemTabModalApi["openSettings"]>;
} {
  return {
    active: null,
    openSettings: vi.fn<SystemTabModalApi["openSettings"]>(),
    openHistory: () => undefined,
    close: () => undefined,
    setSection: () => undefined,
    promoteToTab: () => undefined,
    isOverlayActive: () => false,
  };
}

/** The element the toast was handed, rendered so its buttons can be clicked. */
function renderShownToast(): HTMLElement {
  const call = seam.toast.mock.calls.at(-1);
  if (call === undefined) throw new Error("no toast shown");
  const [element, options] = call;
  expect(options).toMatchObject({ id: ONBOARDING_COMPLETION_TOAST_ID });
  render(<>{element}</>);
  return screen.getByTestId("onboarding-completion-toast");
}

const surfaces: Surface[] = [];
function keep(surface: Surface): Surface {
  surfaces.push(surface);
  return surface;
}

beforeEach(() => {
  window.localStorage.clear();
  seam.activateTabIntent.mockReset();
  seam.navigate.mockReset();
  seam.openLink.mockReset();
  seam.toast.mockReset();
  seam.toastDismiss.mockReset();
  joyride.props = null;
  joyride.mounts = 0;
  resetTourDismissalForTests();
  resetTourNavigationForTests();
  resetActivationForTests();
  resetModalPresenceForTests();
  setSystemTabModalApi(null);
  useOnboardingFlowStore.setState({ ...INITIAL_FLOW });
  useOnboardingPresenceStore.setState({ modalOpen: false, tourBusy: false });
  useLandingReceiptsStore.getState().reset();
  useFeatureAnnouncementsStore.setState({ consumed: {} });
  useLandingDraftStore.setState({ drafts: [], activeDraftId: null });
  useTabsStore.setState({
    items: [],
    activeItemId: null,
    systemTabs: { history: null, settings: null },
    stripOrder: [],
  });
  useEpicCanvasStore.setState({
    tabsById: {},
    openTabOrder: [],
    activeTabId: null,
    mostRecentTabIdByEpicId: {},
  });
  if (typeof Element.prototype.checkVisibility !== "function") {
    Object.defineProperty(Element.prototype, "checkVisibility", {
      configurable: true,
      value(this: Element) {
        return !this.closest("[hidden]");
      },
    });
  }
  signIn();
});

afterEach(() => {
  cleanup();
  for (const surface of surfaces.splice(0)) surface.remove();
  useAuthStore.getState().setSignedOut();
});

describe("flow host gates and mount", () => {
  it("renders nothing signed out, nothing while the chain is pending, and exactly one tour once a chain is active", async () => {
    useAuthStore.getState().setSignedOut();
    const view = render(<OnboardingFlowHost />);
    expect(joyride.props).toBeNull();
    act(() => {
      signIn();
    });
    view.rerender(<OnboardingFlowHost />);
    expect(joyride.props).toBeNull();
    keep(mountDraftSurface(DRAFT_ID, ["landing-folder-add"], true));
    useLandingDraftStore.getState().createDraftWithId(DRAFT_ID, null);
    focusDraftTab(DRAFT_ID);
    act(() => {
      flow().finishModal("no-sessions");
    });
    // The modal's Dialog un-presents with the finish; the tour follows one
    // macrotask later.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(joyride.props?.run).toBe(true);
    expect(
      document.querySelectorAll('[data-testid="onboarding-tour-live"]'),
    ).toHaveLength(1);
    expect(useOnboardingPresenceStore.getState().tourBusy).toBe(true);
  });

  it("skipped and completed chains never start on launch", () => {
    act(() => {
      flow().finishModal("no-sessions");
      flow().skipChain();
    });
    render(<OnboardingFlowHost />);
    expect(joyride.props).toBeNull();
    expect(flow().chain).toBe("skipped");
  });
});

describe("launch resume", () => {
  it("resumes a paused checkpoint on the next launch, at the same step", () => {
    act(() => {
      flow().finishModal("no-sessions");
      flow().advance("add-folder", "add-folder", "next");
      flow().pauseChain();
    });
    expect(flow().chain).toBe("paused");
    keep(mountDraftSurface(DRAFT_ID, ["landing-terminal-switch"], true));
    useLandingDraftStore.getState().createDraftWithId(DRAFT_ID, null);
    focusDraftTab(DRAFT_ID);
    render(<OnboardingFlowHost />);
    expect(flow().chain).toBe("active");
    expect(flow().activeTourId).toBe("terminal-mode");
    expect(joyride.props?.stepIndex).toBe(1);
  });

  it("does not resume in the launch that paused it (Esc), only on the next one", () => {
    keep(mountDraftSurface(DRAFT_ID, ["landing-folder-add"], true));
    useLandingDraftStore.getState().createDraftWithId(DRAFT_ID, null);
    focusDraftTab(DRAFT_ID);
    const view = render(<OnboardingFlowHost />);
    act(() => {
      flow().finishModal("no-sessions");
    });
    emit({ type: "step:after", action: "close", origin: "keyboard" }, props());
    expect(flow().chain).toBe("paused");
    // The host re-mounting in the same launch (a host switch, say).
    view.unmount();
    render(<OnboardingFlowHost />);
    expect(flow().chain).toBe("paused");
    expect(joyride.props?.run ?? false).toBe(false);
  });
});

describe("entry navigation", () => {
  it("binds to the visible open draft without navigating", () => {
    useLandingDraftStore.getState().createDraftWithId(DRAFT_ID, null);
    focusDraftTab(DRAFT_ID);
    render(<OnboardingFlowHost />);
    act(() => {
      flow().finishModal("no-sessions");
    });
    expect(seam.activateTabIntent).not.toHaveBeenCalled();
    expect(flow().context?.draftId).toBe(DRAFT_ID);
  });

  it("activates the saved draft when it is open but not focused, and a new draft when it is gone - once per activation", () => {
    useLandingDraftStore.getState().createDraftWithId(DRAFT_ID, null);
    // Something else is focused (an epic tab).
    keep(mountEpicSurface(EPIC_TAB_ID, false));
    const ref = { kind: "epic" as const, id: EPIC_TAB_ID };
    useTabsStore.setState({
      items: [{ kind: "tab", id: `tab:epic:${EPIC_TAB_ID}`, ref }],
      activeItemId: `tab:epic:${EPIC_TAB_ID}`,
      systemTabs: { history: null, settings: null },
      stripOrder: [ref],
    });
    act(() => {
      flow().finishModal("no-sessions");
      flow().advance("add-folder", "add-folder", "next");
      flow().setContext({ draftId: DRAFT_ID });
      flow().pauseChain();
    });
    render(<OnboardingFlowHost />);
    expect(flow().chain).toBe("active");
    expect(seam.activateTabIntent).toHaveBeenCalledTimes(1);
    expect(seam.activateTabIntent).toHaveBeenCalledWith(
      seam.navigate,
      { kind: "draft", draftId: DRAFT_ID },
      undefined,
    );
    // A later store tick / route change does not pull the user back.
    act(() => {
      flow().setContext({ hostId: "host-x" });
    });
    expect(seam.activateTabIntent).toHaveBeenCalledTimes(1);

    // The saved draft is closed: a fresh draft through the seam, never the
    // old id, and the stale context cleared for the controller to re-bind.
    act(() => {
      flow().skipChain();
      useLandingDraftStore.getState().closeDraft(DRAFT_ID);
      flow().replayTour("add-folder");
      flow().setContext({ draftId: DRAFT_ID });
    });
    expect(seam.activateTabIntent).toHaveBeenCalledTimes(2);
    expect(seam.activateTabIntent).toHaveBeenLastCalledWith(
      seam.navigate,
      { kind: "new-draft", settings: null },
      undefined,
    );
    expect(flow().context?.draftId).toBeNull();
  });

  it("the history lesson is a landing lesson too (B8): activated with an epic focused it opens a draft, and a replay from a Settings TAB navigates as well", () => {
    keep(mountEpicSurface(EPIC_TAB_ID, false));
    const ref = { kind: "epic" as const, id: EPIC_TAB_ID };
    useTabsStore.setState({
      items: [{ kind: "tab", id: `tab:epic:${EPIC_TAB_ID}`, ref }],
      activeItemId: `tab:epic:${EPIC_TAB_ID}`,
      systemTabs: { history: null, settings: null },
      stripOrder: [ref],
    });
    render(<OnboardingFlowHost />);
    act(() => {
      flow().finishModal("sessions");
    });
    expect(flow().activeTourId).toBe("history");
    expect(seam.activateTabIntent).toHaveBeenCalledTimes(1);
    expect(seam.activateTabIntent).toHaveBeenLastCalledWith(
      seam.navigate,
      { kind: "new-draft", settings: null },
      undefined,
    );

    // Settings promoted to a tab (not the overlay), replaying the lesson.
    useLandingDraftStore.getState().createDraftWithId(DRAFT_ID, null);
    const settingsRef = { kind: "settings" as const, id: "settings" };
    useTabsStore.setState({
      items: [
        { kind: "tab", id: `tab:epic:${EPIC_TAB_ID}`, ref },
        { kind: "tab", id: tabItemId(settingsRef), ref: settingsRef },
      ],
      activeItemId: tabItemId(settingsRef),
      systemTabs: {
        history: null,
        settings: {
          id: "settings",
          kind: "settings",
          name: "Settings",
          lastPath: "/settings/onboarding",
        },
      },
      stripOrder: [ref, settingsRef],
    });
    act(() => {
      flow().skipChain();
      flow().replayTour("history");
      flow().setContext({ draftId: DRAFT_ID });
    });
    expect(flow().activeTourId).toBe("history");
    expect(seam.activateTabIntent).toHaveBeenCalledTimes(2);
    expect(seam.activateTabIntent).toHaveBeenLastCalledWith(
      seam.navigate,
      { kind: "draft", draftId: DRAFT_ID },
      undefined,
    );
  });

  it("a host remount (readiness drop) during a pending terminal Start does not redirect the prompt lesson back to a draft", () => {
    useLandingDraftStore.getState().createDraftWithId(DRAFT_ID, null);
    focusDraftTab(DRAFT_ID);
    const view = render(<OnboardingFlowHost />);
    act(() => {
      flow().finishModal("no-sessions");
      flow().advance("add-folder", "add-folder", "next");
      flow().advance("terminal-mode", "terminal-mode", "next");
    });
    expect(flow().activeTourId).toBe("submit-prompt");
    expect(seam.activateTabIntent).not.toHaveBeenCalled();
    // Start dispatched: the optimistic navigation focuses the new epic tab
    // while the create is still in flight.
    act(() => {
      useLandingReceiptsStore.getState().announce({
        kind: "tui-accepted",
        attemptId: "start-pending",
        draftId: DRAFT_ID,
        hostId: "host-flow",
      });
    });
    expect(flow().context?.attemptId).toBe("start-pending");
    keep(mountEpicSurface(EPIC_TAB_ID, false));
    const ref = { kind: "epic" as const, id: EPIC_TAB_ID };
    useTabsStore.setState({
      items: [{ kind: "tab", id: `tab:epic:${EPIC_TAB_ID}`, ref }],
      activeItemId: `tab:epic:${EPIC_TAB_ID}`,
      systemTabs: { history: null, settings: null },
      stripOrder: [ref],
    });
    view.unmount();
    render(<OnboardingFlowHost />);
    expect(seam.activateTabIntent).not.toHaveBeenCalled();
    expect(flow().context?.attemptId).toBe("start-pending");
  });

  it("a replay that lands while the ready host is unmounted is a NEW activation on remount: it navigates again and drops the old attempt", () => {
    useLandingDraftStore.getState().createDraftWithId(DRAFT_ID, null);
    focusDraftTab(DRAFT_ID);
    const view = render(<OnboardingFlowHost />);
    act(() => {
      flow().finishModal("no-sessions");
    });
    expect(seam.activateTabIntent).not.toHaveBeenCalled();
    act(() => {
      useLandingReceiptsStore.getState().announce({
        kind: "prompt-accepted",
        attemptId: "old-attempt",
        draftId: DRAFT_ID,
        hostId: "host-flow",
      });
    });
    // Readiness drops; Settings replays while the host is down; the
    // focused surface is an epic by the time readiness returns.
    view.unmount();
    act(() => {
      flow().replayTour("add-folder");
    });
    keep(mountEpicSurface(EPIC_TAB_ID, false));
    const ref = { kind: "epic" as const, id: EPIC_TAB_ID };
    useTabsStore.setState({
      items: [{ kind: "tab", id: `tab:epic:${EPIC_TAB_ID}`, ref }],
      activeItemId: `tab:epic:${EPIC_TAB_ID}`,
      systemTabs: { history: null, settings: null },
      stripOrder: [ref],
    });
    render(<OnboardingFlowHost />);
    expect(seam.activateTabIntent).toHaveBeenCalledTimes(1);
    expect(seam.activateTabIntent).toHaveBeenCalledWith(
      seam.navigate,
      { kind: "new-draft", settings: null },
      undefined,
    );
    expect(useLandingReceiptsStore.getState().dispatchedByAttemptId).toEqual(
      {},
    );
  });

  it("the panels lesson waits for its surface rather than navigating", () => {
    act(() => {
      flow().finishModal("no-sessions");
      flow().replayTour("task-panels");
    });
    render(<OnboardingFlowHost />);
    expect(seam.activateTabIntent).not.toHaveBeenCalled();
    expect(joyride.props?.run).toBe(true);
  });
});

function completeChainViaFinishFrom(_events: typeof fireEvent): void {
  fireEvent.click(screen.getByRole("button", { name: "Continue" }));
  keep(mountEpicSurface(EPIC_TAB_ID, false));
  const ref = { kind: "epic" as const, id: EPIC_TAB_ID };
  useEpicCanvasStore.setState({
    tabsById: {
      [EPIC_TAB_ID]: { tabId: EPIC_TAB_ID, epicId: "epic-flow", name: "E" },
    },
    openTabOrder: [EPIC_TAB_ID],
    activeTabId: EPIC_TAB_ID,
    mostRecentTabIdByEpicId: { "epic-flow": EPIC_TAB_ID },
  });
  useTabsStore.setState({
    items: [{ kind: "tab", id: `tab:epic:${EPIC_TAB_ID}`, ref }],
    activeItemId: `tab:epic:${EPIC_TAB_ID}`,
    systemTabs: { history: null, settings: null },
    stripOrder: [ref],
  });
  act(() => {
    flow().replayTour("task-panels");
  });
  next();
  expect(flow().chain).toBe("completed");
}

describe("completion toast", () => {
  function completeChainViaFinish(): void {
    keep(mountEpicSurface(EPIC_TAB_ID, false));
    const ref = { kind: "epic" as const, id: EPIC_TAB_ID };
    useEpicCanvasStore.setState({
      tabsById: {
        [EPIC_TAB_ID]: { tabId: EPIC_TAB_ID, epicId: "epic-flow", name: "E" },
      },
      openTabOrder: [EPIC_TAB_ID],
      activeTabId: EPIC_TAB_ID,
      mostRecentTabIdByEpicId: { "epic-flow": EPIC_TAB_ID },
    });
    useTabsStore.setState({
      items: [{ kind: "tab", id: `tab:epic:${EPIC_TAB_ID}`, ref }],
      activeItemId: `tab:epic:${EPIC_TAB_ID}`,
      systemTabs: { history: null, settings: null },
      stripOrder: [ref],
    });
    act(() => {
      flow().finishModal("no-sessions");
      flow().replayTour("task-panels");
    });
    next();
    expect(flow().chain).toBe("completed");
  }

  it("is held while the API is unpublished, then shows once, claims the announcement, and never repeats on a replay", () => {
    render(<OnboardingFlowHost />);
    completeChainViaFinish();
    expect(useOnboardingPresenceStore.getState().tourBusy).toBe(false);
    expect(seam.toast).not.toHaveBeenCalled();
    act(() => {
      setSystemTabModalApi(fakeSettingsApi());
    });
    expect(seam.toast).toHaveBeenCalledTimes(1);
    expect(
      useFeatureAnnouncementsStore.getState().consumed["onboarding-completion"],
    ).toBeDefined();
    // A later replay that completes again: claimed, so no second toast.
    act(() => {
      flow().replayTour("task-panels");
    });
    next();
    expect(flow().chain).toBe("completed");
    expect(seam.toast).toHaveBeenCalledTimes(1);
  });

  it("is held while the flow is busy (a running tour), and a Skip qualifies", () => {
    setSystemTabModalApi(fakeSettingsApi());
    keep(mountDraftSurface(DRAFT_ID, ["landing-folder-add"], true));
    useLandingDraftStore.getState().createDraftWithId(DRAFT_ID, null);
    focusDraftTab(DRAFT_ID);
    render(<OnboardingFlowHost />);
    act(() => {
      flow().finishModal("no-sessions");
    });
    expect(seam.toast).not.toHaveBeenCalled();
    emit({ type: "tour:end", action: "skip", status: "skipped" }, props());
    expect(flow().chain).toBe("skipped");
    expect(seam.toast).toHaveBeenCalledTimes(1);
  });

  it("does not toast on a pause, nor for the legacy migration's synthetic skipped chain", () => {
    setSystemTabModalApi(fakeSettingsApi());
    keep(mountDraftSurface(DRAFT_ID, ["landing-folder-add"], true));
    useLandingDraftStore.getState().createDraftWithId(DRAFT_ID, null);
    focusDraftTab(DRAFT_ID);
    const view = render(<OnboardingFlowHost />);
    act(() => {
      flow().finishModal("no-sessions");
    });
    emit({ type: "step:after", action: "close", origin: "keyboard" }, props());
    expect(flow().chain).toBe("paused");
    expect(seam.toast).not.toHaveBeenCalled();
    view.unmount();

    // What `migrateLegacyOnboardingKey` writes for an old-tour completer.
    useOnboardingFlowStore.setState({
      ...INITIAL_FLOW,
      modal: "done",
      chain: "skipped",
      chainScope: "single",
      legacyCompleted: true,
    });
    render(<OnboardingFlowHost />);
    expect(seam.toast).not.toHaveBeenCalled();
    // ...but a deliberate replay that ends here does qualify - even when
    // the toast is held (no Settings bridge) across a host remount.
    keep(mountEpicSurface(EPIC_TAB_ID, false));
    const ref = { kind: "epic" as const, id: EPIC_TAB_ID };
    useEpicCanvasStore.setState({
      tabsById: {
        [EPIC_TAB_ID]: { tabId: EPIC_TAB_ID, epicId: "epic-flow", name: "E" },
      },
      openTabOrder: [EPIC_TAB_ID],
      activeTabId: EPIC_TAB_ID,
      mostRecentTabIdByEpicId: { "epic-flow": EPIC_TAB_ID },
    });
    useTabsStore.setState({
      items: [{ kind: "tab", id: `tab:epic:${EPIC_TAB_ID}`, ref }],
      activeItemId: `tab:epic:${EPIC_TAB_ID}`,
      systemTabs: { history: null, settings: null },
      stripOrder: [ref],
    });
    act(() => {
      setSystemTabModalApi(null);
      flow().replayTour("task-panels");
    });
    next();
    expect(flow().chain).toBe("completed");
    expect(flow().completionPending).toBe(true);
    expect(seam.toast).not.toHaveBeenCalled();
    cleanup();
    render(<OnboardingFlowHost />);
    act(() => {
      setSystemTabModalApi(fakeSettingsApi());
    });
    expect(seam.toast).toHaveBeenCalledTimes(1);
    expect(flow().completionPending).toBe(false);
  });

  it("Star on GitHub opens the repo through openLink(url, 'app', null) exactly once; Learn more opens Settings > Onboarding", () => {
    const api = fakeSettingsApi();
    setSystemTabModalApi(api);
    render(<OnboardingFlowHost />);
    completeChainViaFinish();
    const body = renderShownToast();
    const star = screen.getByRole("button", { name: "Star on GitHub" });
    fireEvent.click(star);
    fireEvent.click(star);
    expect(seam.openLink).toHaveBeenCalledTimes(1);
    expect(seam.openLink).toHaveBeenCalledWith(TRAYCER_GITHUB_URL, "app", null);
    expect(seam.toastDismiss).toHaveBeenCalledWith(
      ONBOARDING_COMPLETION_TOAST_ID,
    );
    expect(body).toBeTruthy();
    cleanup();

    seam.toastDismiss.mockReset();
    renderShownToast();
    fireEvent.click(screen.getByRole("button", { name: "Learn more" }));
    expect(api.openSettings).toHaveBeenCalledWith({
      section: "onboarding",
      resetToGeneral: false,
    });
    expect(seam.toastDismiss).toHaveBeenCalledWith(
      ONBOARDING_COMPLETION_TOAST_ID,
    );
  });

  it("has a plain Dismiss that closes the toast without opening anything", () => {
    const api = fakeSettingsApi();
    setSystemTabModalApi(api);
    render(<OnboardingFlowHost />);
    completeChainViaFinish();
    renderShownToast();
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(seam.toastDismiss).toHaveBeenCalledWith(
      ONBOARDING_COMPLETION_TOAST_ID,
    );
    expect(seam.openLink).not.toHaveBeenCalled();
    expect(api.openSettings).not.toHaveBeenCalled();
  });

  it("Learn more is retained (disabled, not dismissed) when the Settings bridge vanished before the click", () => {
    const api = fakeSettingsApi();
    setSystemTabModalApi(api);
    render(<OnboardingFlowHost />);
    completeChainViaFinish();
    renderShownToast();
    act(() => {
      setSystemTabModalApi(null);
    });
    const learnMore = screen.getByRole("button", { name: "Learn more" });
    expect(learnMore.hasAttribute("disabled")).toBe(true);
    fireEvent.click(learnMore);
    expect(api.openSettings).not.toHaveBeenCalled();
    expect(seam.toastDismiss).not.toHaveBeenCalled();
  });
});

describe("welcome modal <-> tour seam", () => {
  const tick = async (): Promise<void> => {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  };

  it("first run: the modal shows, no tour; Esc hides it for this session without starting a chain; Settings brings it back", () => {
    render(<OnboardingFlowHost />);
    expect(screen.getByTestId("welcome-modal")).toBeTruthy();
    expect(flow().modal).toBe("in-progress");
    expect(joyride.props).toBeNull();
    expect(useOnboardingPresenceStore.getState().modalOpen).toBe(true);
    fireEvent.keyDown(screen.getByTestId("welcome-modal"), { key: "Escape" });
    expect(screen.queryByTestId("welcome-modal")).toBeNull();
    expect(flow().modal).toBe("in-progress");
    expect(flow().chain).toBe("pending");
    expect(joyride.props).toBeNull();
    expect(useOnboardingPresenceStore.getState().modalOpen).toBe(false);
    act(() => {
      flow().showWelcomeModalAgain();
    });
    expect(screen.getByTestId("welcome-modal")).toBeTruthy();
  });

  it("Continue finishes the modal into the chain; the tour runs only once the modal's Dialog has un-presented, one macrotask later", async () => {
    keep(mountDraftSurface(DRAFT_ID, ["landing-folder-add"], true));
    useLandingDraftStore.getState().createDraftWithId(DRAFT_ID, null);
    focusDraftTab(DRAFT_ID);
    render(<OnboardingFlowHost />);
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(flow().chain).toBe("active");
    expect(flow().modal).toBe("done");
    expect(screen.queryByTestId("welcome-modal")).toBeNull();
    // Same task as the close: still held.
    expect(props().run).toBe(false);
    await tick();
    expect(props().run).toBe(true);
    expect(props().options?.dismissKeyAction).toBe("close");
    expect(useOnboardingPresenceStore.getState().tourBusy).toBe(true);
  });

  it("the modal shown again over an active chain holds the tour (run false, Esc left to the modal); Esc pauses only the modal and the same lesson resumes", async () => {
    keep(mountDraftSurface(DRAFT_ID, ["landing-folder-add"], true));
    useLandingDraftStore.getState().createDraftWithId(DRAFT_ID, null);
    focusDraftTab(DRAFT_ID);
    render(<OnboardingFlowHost />);
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    await tick();
    expect(props().run).toBe(true);
    act(() => {
      flow().showWelcomeModalAgain();
    });
    expect(screen.getByTestId("welcome-modal")).toBeTruthy();
    expect(props().run).toBe(false);
    expect(props().options?.dismissKeyAction).toBe(false);
    fireEvent.keyDown(screen.getByTestId("welcome-modal"), { key: "Escape" });
    expect(screen.queryByTestId("welcome-modal")).toBeNull();
    expect(flow().modal).toBe("in-progress");
    expect(flow().chain).toBe("active");
    expect(flow().activeTourId).toBe("add-folder");
    await tick();
    expect(props().run).toBe(true);
  });

  it("modalOpen and tourBusy both hold the completion toast", () => {
    setSystemTabModalApi(fakeSettingsApi());
    render(<OnboardingFlowHost />);
    completeChainViaFinishFrom(fireEvent);
    expect(seam.toast).toHaveBeenCalledTimes(1);
    seam.toast.mockReset();
    useFeatureAnnouncementsStore.setState({ consumed: {} });
    act(() => {
      flow().showWelcomeModalAgain();
    });
    expect(useOnboardingPresenceStore.getState().modalOpen).toBe(true);
    act(() => {
      // The chain ends again while the modal is on screen.
      flow().replayTour("task-panels");
      flow().completeChain();
    });
    expect(flow().completionPending).toBe(true);
    expect(seam.toast).not.toHaveBeenCalled();
    fireEvent.keyDown(screen.getByTestId("welcome-modal"), { key: "Escape" });
    expect(seam.toast).toHaveBeenCalledTimes(1);
  });

  it("a pending completion is held by tourBusy across a replay and delivered once the tour pauses", () => {
    render(<OnboardingFlowHost />);
    // The chain ends with no Settings bridge yet: pending, held.
    completeChainViaFinishFrom(fireEvent);
    expect(flow().completionPending).toBe(true);
    expect(seam.toast).not.toHaveBeenCalled();
    // A replay starts before the bridge publishes: the tour has the screen.
    act(() => {
      flow().replayTour("task-panels");
    });
    expect(useOnboardingPresenceStore.getState().tourBusy).toBe(true);
    expect(useOnboardingPresenceStore.getState().modalOpen).toBe(false);
    act(() => {
      setSystemTabModalApi(fakeSettingsApi());
    });
    expect(flow().completionPending).toBe(true);
    expect(seam.toast).not.toHaveBeenCalled();
    // Esc on the tour: busy clears, the held toast is delivered.
    emit({ type: "step:after", action: "close", origin: "keyboard" }, props());
    expect(flow().chain).toBe("paused");
    expect(useOnboardingPresenceStore.getState().tourBusy).toBe(false);
    expect(seam.toast).toHaveBeenCalledTimes(1);
    expect(flow().completionPending).toBe(false);
  });
});
