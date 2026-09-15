import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { domAnimation, LazyMotion } from "motion/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OnboardingSettingsPanel } from "@/components/settings/panels/onboarding-settings-panel";
import { LEGACY_COMPLETED_NOTE } from "@/components/settings/panels/onboarding/onboarding-progress";
import { FakeBrowserViewBridge } from "@/lib/browser-view/__tests__/fake-browser-view-bridge";
import { setMobileApp } from "@/lib/mobile-app";
import type { SettingsSectionId } from "@/lib/settings-sections";
import {
  INITIAL_FLOW,
  useOnboardingFlowStore,
  type OnboardingFlowData,
  type OnboardingFlowState,
} from "@/stores/onboarding/onboarding-flow-store";
import {
  firstStepOf,
  LESSON_IDS,
  TOUR_IDS,
  type TourId,
} from "@/stores/onboarding/onboarding-tour-catalog";
import {
  isFeatureAnnouncementConsumed,
  useFeatureAnnouncementsStore,
} from "@/stores/settings/feature-announcements-store";
import { setSystemTabModalApi } from "@/stores/tabs/system-tab-modal-bridge";
import type {
  OpenSettingsModalOpts,
  SystemOverlayKind,
  SystemTabModalApi,
} from "@/stores/tabs/use-system-tab-modal";
import type { BrowserViewBridge } from "@traycer-clients/shared/platform/browser-view";

const trackMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/analytics", () => ({
  Analytics: { getInstance: () => ({ track: trackMock }) },
  AnalyticsEvent: { OnboardingLessonOpened: "onboarding_lesson_opened" },
}));

const browserViewState = vi.hoisted(
  (): { current: BrowserViewBridge | null } => ({ current: null }),
);
vi.mock("@/providers/use-runner-host", () => ({
  useRunnerHostOrNull: () =>
    browserViewState.current === null
      ? null
      : { browserView: browserViewState.current },
}));

/** The four guided tours a `settled()` install has already finished. */
const DONE_TOUR_IDS: readonly TourId[] = [
  "add-folder",
  "terminal-mode",
  "submit-prompt",
  "task-panels",
];

function flow(): OnboardingFlowState {
  return useOnboardingFlowStore.getState();
}

/** A settled install: chain completed, four tours done, history still open. */
function settled(): OnboardingFlowData {
  return {
    ...INITIAL_FLOW,
    modal: "done",
    chain: "completed",
    branch: "no-sessions",
    tours: {
      ...INITIAL_FLOW.tours,
      "add-folder": { status: "done", stepId: null, completedAt: 1 },
      "terminal-mode": { status: "done", stepId: null, completedAt: 1 },
      "submit-prompt": { status: "done", stepId: null, completedAt: 1 },
      "task-panels": { status: "done", stepId: null, completedAt: 1 },
    },
  };
}

function buildFakeSystemTabModalApi(opts: {
  readonly overlayActive: boolean;
}): SystemTabModalApi {
  return {
    active: null,
    openSettings: vi.fn<(opts: OpenSettingsModalOpts) => void>(),
    openHistory: vi.fn<() => void>(),
    close: vi.fn<() => void>(),
    setSection: vi.fn<(section: SettingsSectionId) => void>(),
    promoteToTab: vi.fn<() => void>(),
    isOverlayActive: vi.fn<(kind: SystemOverlayKind) => boolean>(
      () => opts.overlayActive,
    ),
  };
}

/**
 * An overlay-mode API whose `close` records the flow's `chain` at the
 * moment it fires, so a caller can prove `close` ran BEFORE the replay
 * wrote the store.
 */
function buildOverlayApiCapturingChainAtClose(): {
  readonly api: SystemTabModalApi;
  readonly chainAtClose: () => string | null;
} {
  let captured: string | null = null;
  const api: SystemTabModalApi = {
    active: null,
    openSettings: vi.fn<(opts: OpenSettingsModalOpts) => void>(),
    openHistory: vi.fn<() => void>(),
    close: vi.fn<() => void>(() => {
      captured = flow().chain;
    }),
    setSection: vi.fn<(section: SettingsSectionId) => void>(),
    promoteToTab: vi.fn<() => void>(),
    isOverlayActive: vi.fn<(kind: SystemOverlayKind) => boolean>(() => true),
  };
  return { api, chainAtClose: () => captured };
}

function renderPanel(): void {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  render(
    <QueryClientProvider client={queryClient}>
      <LazyMotion features={domAnimation}>
        <OnboardingSettingsPanel />
      </LazyMotion>
    </QueryClientProvider>,
  );
}

describe("<OnboardingSettingsPanel />", () => {
  beforeEach(() => {
    useOnboardingFlowStore.setState(INITIAL_FLOW);
    useFeatureAnnouncementsStore.setState({ consumed: {} });
    localStorage.clear();
    setMobileApp(false);
    browserViewState.current = null;
    trackMock.mockReset();
    setSystemTabModalApi(buildFakeSystemTabModalApi({ overlayActive: false }));
  });

  afterEach(() => {
    cleanup();
    setSystemTabModalApi(null);
    setMobileApp(false);
  });

  describe("progress", () => {
    it("shows an untouched fresh install", () => {
      renderPanel();

      expect(screen.getByText("0 of 5 tours completed")).toBeTruthy();
      expect(
        screen.getByText("0 done · 5 available · 0 bypassed · 0 active"),
      ).toBeTruthy();
      const progressGroup = screen.getByTestId("onboarding-progress");
      expect(progressGroup.textContent).toContain("Welcome · Not started");
      expect(screen.getByText("Tours: Not started")).toBeTruthy();
      const progressbar = screen.getByRole("progressbar");
      expect(progressbar.getAttribute("aria-valuenow")).toBe("0");
      expect(screen.queryByTestId("onboarding-legacy-note")).toBeNull();
    });

    it("shows a legacy-migrated install", () => {
      useOnboardingFlowStore.setState({
        ...INITIAL_FLOW,
        modal: "done",
        chain: "skipped",
        chainScope: "single",
        legacyCompleted: true,
      });

      renderPanel();

      expect(screen.getByTestId("onboarding-legacy-note").textContent).toBe(
        LEGACY_COMPLETED_NOTE,
      );
      expect(screen.getByText("0 of 5 tours completed")).toBeTruthy();
      const progressGroup = screen.getByTestId("onboarding-progress");
      expect(progressGroup.textContent).toContain("Welcome · Done");
      expect(screen.getByText("Tours: Skipped")).toBeTruthy();
      for (const tourId of TOUR_IDS) {
        expect(
          screen.getByTestId(`onboarding-replay-${tourId}`).textContent,
        ).toBe("Start tour");
      }
    });

    it("shows a chain paused mid-way", () => {
      useOnboardingFlowStore.setState({
        ...INITIAL_FLOW,
        modal: "done",
        chain: "paused",
        branch: "no-sessions",
        activeTourId: "terminal-mode",
        tours: {
          ...INITIAL_FLOW.tours,
          "add-folder": { status: "done", stepId: null, completedAt: 1 },
          "terminal-mode": {
            status: "active",
            stepId: "terminal-mode",
            completedAt: null,
          },
        },
      });

      renderPanel();

      expect(screen.getByText("1 of 5 tours completed")).toBeTruthy();
      expect(
        screen.getByText("Tours: Paused at Start a terminal agent"),
      ).toBeTruthy();
      const card = screen.getByTestId("onboarding-lesson-terminal-mode");
      expect(card.textContent).toContain(
        "Start a terminal agent · Paused here",
      );
      expect(
        screen.getByTestId("onboarding-replay-terminal-mode").textContent,
      ).toBe("Restart tour");
    });

    it("counts a bypassed tour on its own, and never as done", () => {
      useOnboardingFlowStore.setState({
        ...INITIAL_FLOW,
        modal: "done",
        chain: "completed",
        branch: "no-sessions",
        tours: {
          ...INITIAL_FLOW.tours,
          "add-folder": { status: "done", stepId: null, completedAt: 1 },
          "terminal-mode": { status: "done", stepId: null, completedAt: 1 },
          "submit-prompt": {
            status: "bypassed",
            stepId: null,
            completedAt: null,
          },
          "task-panels": { status: "done", stepId: null, completedAt: 1 },
        },
      });

      renderPanel();

      expect(screen.getByText("3 of 5 tours completed")).toBeTruthy();
      expect(
        screen.getByText("3 done · 1 available · 1 bypassed · 0 active"),
      ).toBeTruthy();
      const card = screen.getByTestId("onboarding-lesson-submit-prompt");
      expect(card.textContent).toContain("Send your first prompt · Bypassed");
      expect(
        screen.getByTestId("onboarding-replay-submit-prompt").textContent,
      ).toBe("Replay tour");
      const progressbar = screen.getByRole("progressbar");
      expect(progressbar.getAttribute("aria-valuemax")).toBe("5");
    });
  });

  describe("replay", () => {
    it.each(TOUR_IDS)(
      "replays %s from a settled install and finishes it back to completed",
      (tourId) => {
        useOnboardingFlowStore.setState(settled());
        renderPanel();

        fireEvent.click(screen.getByTestId(`onboarding-replay-${tourId}`));

        const afterReplay = flow();
        expect(afterReplay.activeTourId).toBe(tourId);
        expect(afterReplay.chain).toBe("active");
        expect(afterReplay.chainScope).toBe("single");
        expect(afterReplay.tours[tourId]).toEqual({
          status: "active",
          stepId: firstStepOf(tourId),
          completedAt: null,
        });
        expect(afterReplay.context).toBeNull();
        expect(afterReplay.modal).toBe("done");

        const unrelated =
          DONE_TOUR_IDS.find((id) => id !== tourId) ?? "add-folder";
        expect(afterReplay.tours[unrelated].status).toBe("done");

        expect(trackMock).toHaveBeenCalledExactlyOnceWith(
          "onboarding_lesson_opened",
          { lesson: tourId },
        );

        act(() => {
          flow().advance(tourId, firstStepOf(tourId), "next");
        });

        const afterAdvance = flow();
        expect(afterAdvance.chain).toBe("completed");
        expect(afterAdvance.activeTourId).toBeNull();
        expect(afterAdvance.tours[tourId].status).toBe("done");
        for (const other of TOUR_IDS) {
          if (other === tourId) continue;
          expect(afterAdvance.tours[other].status).not.toBe("active");
        }
      },
    );

    it("closes an open Settings overlay before replaying, and leaves a tab alone", () => {
      useOnboardingFlowStore.setState(settled());
      const { api: overlayApi, chainAtClose } =
        buildOverlayApiCapturingChainAtClose();
      setSystemTabModalApi(overlayApi);
      renderPanel();

      fireEvent.click(screen.getByTestId("onboarding-replay-add-folder"));

      expect(overlayApi.close).toHaveBeenCalledTimes(1);
      expect(chainAtClose()).toBe("completed");

      cleanup();
      useOnboardingFlowStore.setState(settled());
      const tabApi = buildFakeSystemTabModalApi({ overlayActive: false });
      setSystemTabModalApi(tabApi);
      renderPanel();

      fireEvent.click(screen.getByTestId("onboarding-replay-add-folder"));

      expect(tabApi.close).not.toHaveBeenCalled();
    });

    it("disables every gated control until the modal API publishes", () => {
      setSystemTabModalApi(null);
      useOnboardingFlowStore.setState(settled());
      renderPanel();

      for (const tourId of TOUR_IDS) {
        expect(
          screen
            .getByTestId(`onboarding-replay-${tourId}`)
            .hasAttribute("disabled"),
        ).toBe(true);
      }
      expect(
        screen
          .getByTestId("onboarding-show-welcome-again")
          .hasAttribute("disabled"),
      ).toBe(true);
      expect(
        screen
          .getByTestId("onboarding-open-agent-guide")
          .hasAttribute("disabled"),
      ).toBe(true);

      fireEvent.click(screen.getByTestId("onboarding-replay-add-folder"));
      expect(flow().chain).toBe("completed");
      expect(trackMock).not.toHaveBeenCalled();

      act(() => {
        setSystemTabModalApi(
          buildFakeSystemTabModalApi({ overlayActive: false }),
        );
      });

      expect(
        screen
          .getByTestId("onboarding-replay-add-folder")
          .hasAttribute("disabled"),
      ).toBe(false);
      expect(
        screen
          .getByTestId("onboarding-show-welcome-again")
          .hasAttribute("disabled"),
      ).toBe(false);
      expect(
        screen
          .getByTestId("onboarding-open-agent-guide")
          .hasAttribute("disabled"),
      ).toBe(false);
    });
  });

  describe("welcome", () => {
    it("shows the welcome modal again without touching tour progress", () => {
      useOnboardingFlowStore.setState(settled());
      useFeatureAnnouncementsStore.getState().consume("onboarding-completion");
      const { api: overlayApi } = buildOverlayApiCapturingChainAtClose();
      setSystemTabModalApi(overlayApi);
      renderPanel();

      fireEvent.click(screen.getByTestId("onboarding-show-welcome-again"));

      const data = flow();
      expect(data.modal).toBe("pending");
      expect(data.modalPage).toBe(1);
      expect(data.tours["add-folder"].status).toBe("done");
      expect(data.chain).toBe("completed");
      expect(
        isFeatureAnnouncementConsumed(
          useFeatureAnnouncementsStore.getState().consumed,
          "onboarding-completion",
        ),
      ).toBe(true);
      expect(trackMock).not.toHaveBeenCalled();
      expect(overlayApi.close).toHaveBeenCalledTimes(1);
    });
  });

  describe("demos", () => {
    it("renders one card per lesson and no diorama initially", () => {
      renderPanel();

      for (const id of LESSON_IDS) {
        expect(screen.getByTestId(`onboarding-lesson-${id}`)).toBeTruthy();
      }
      expect(screen.queryByTestId("lesson-diorama-frame")).toBeNull();
    });

    it("opens exactly one demo at a time and never fires the lesson event on an idle tick", () => {
      vi.useFakeTimers({
        toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"],
      });
      try {
        renderPanel();
        const splitToggle = screen.getByTestId(
          "onboarding-demo-toggle-split-screen",
        );

        fireEvent.click(splitToggle);

        expect(splitToggle.textContent).toBe("Close demo");
        expect(splitToggle.getAttribute("aria-expanded")).toBe("true");
        expect(splitToggle.getAttribute("aria-controls")).toBe(
          "onboarding-demo-split-screen",
        );
        expect(
          screen.getByTestId("lesson-diorama-frame").getAttribute("data-scene"),
        ).toBe("split-screen");
        expect(screen.getByTestId("lesson-diorama-caption")).toBeTruthy();
        expect(trackMock).toHaveBeenCalledTimes(1);
        expect(trackMock).toHaveBeenNthCalledWith(
          1,
          "onboarding_lesson_opened",
          { lesson: "split-screen" },
        );

        const taskTabsToggle = screen.getByTestId(
          "onboarding-demo-toggle-task-tabs",
        );

        fireEvent.click(taskTabsToggle);

        expect(
          screen.getByTestId("lesson-diorama-frame").getAttribute("data-scene"),
        ).toBe("task-tabs");
        expect(splitToggle.textContent).toBe("Watch demo");
        expect(splitToggle.getAttribute("aria-expanded")).toBe("false");
        expect(trackMock).toHaveBeenCalledTimes(2);
        expect(trackMock).toHaveBeenNthCalledWith(
          2,
          "onboarding_lesson_opened",
          { lesson: "task-tabs" },
        );

        act(() => {
          vi.advanceTimersByTime(1900);
        });
        expect(trackMock).toHaveBeenCalledTimes(2);

        fireEvent.click(taskTabsToggle);

        expect(screen.queryByTestId("lesson-diorama-frame")).toBeNull();
        expect(trackMock).toHaveBeenCalledTimes(2);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe("agent guide", () => {
    it("navigates through whichever surface hosts Settings", () => {
      const overlayApi = buildFakeSystemTabModalApi({ overlayActive: true });
      setSystemTabModalApi(overlayApi);
      renderPanel();

      fireEvent.click(screen.getByTestId("onboarding-open-agent-guide"));

      expect(overlayApi.setSection).toHaveBeenCalledWith("agents");
      expect(overlayApi.openSettings).not.toHaveBeenCalled();
      expect(trackMock).toHaveBeenCalledExactlyOnceWith(
        "onboarding_lesson_opened",
        { lesson: "agent-guide" },
      );

      cleanup();
      trackMock.mockReset();
      const tabApi = buildFakeSystemTabModalApi({ overlayActive: false });
      setSystemTabModalApi(tabApi);
      renderPanel();

      fireEvent.click(screen.getByTestId("onboarding-open-agent-guide"));

      expect(tabApi.openSettings).toHaveBeenCalledWith({
        section: "agents",
        resetToGeneral: false,
      });
      expect(tabApi.setSection).not.toHaveBeenCalled();
      expect(trackMock).toHaveBeenCalledExactlyOnceWith(
        "onboarding_lesson_opened",
        { lesson: "agent-guide" },
      );
    });
  });

  describe("login import", () => {
    it("opens the dialog once the bridge is present and saving is on", async () => {
      browserViewState.current = new FakeBrowserViewBridge({});
      renderPanel();

      expect(screen.queryByTestId("import-logins-dialog")).toBeNull();

      const button = screen.getByTestId("onboarding-import-logins");
      await waitFor(() => {
        expect(button.hasAttribute("disabled")).toBe(false);
      });

      fireEvent.click(button);

      await screen.findByTestId("import-logins-dialog");
      expect(trackMock).toHaveBeenCalledExactlyOnceWith(
        "onboarding_lesson_opened",
        { lesson: "login-import" },
      );
    });

    it("disables the button with an explanation when there is no bridge", () => {
      browserViewState.current = null;
      renderPanel();

      const button = screen.getByTestId("onboarding-import-logins");
      expect(button.hasAttribute("disabled")).toBe(true);
      expect(
        screen.getByText(
          "Available in the desktop app, where the browser can keep logins.",
        ),
      ).toBeTruthy();
    });

    it("disables the button with an explanation when saving is off", async () => {
      browserViewState.current = new FakeBrowserViewBridge({
        saveLogins: false,
      });
      renderPanel();

      const button = screen.getByTestId("onboarding-import-logins");
      await waitFor(() => {
        expect(screen.getByText(/^Turn on Saved logins/)).toBeTruthy();
      });
      expect(button.hasAttribute("disabled")).toBe(true);

      fireEvent.click(button);

      expect(trackMock).not.toHaveBeenCalled();
    });
  });

  describe("mobile", () => {
    it("shows no lessons in the installed mobile app", () => {
      setMobileApp(true);
      renderPanel();

      const root = screen.getByTestId("onboarding-settings-panel");
      expect(root.getAttribute("data-lessons")).toBe("unavailable");
      for (const id of LESSON_IDS) {
        expect(screen.queryByTestId(`onboarding-lesson-${id}`)).toBeNull();
      }
      expect(screen.queryByRole("button")).toBeNull();
    });
  });
});
