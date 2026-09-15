import { useEffect } from "react";
import { act, cleanup, render } from "@testing-library/react";
import type { Props as JoyrideProps } from "react-joyride";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OnboardingTour } from "@/components/onboarding/tour/onboarding-tour";
import {
  armFocusNextCard,
  consumeFocusNextCard,
  resetActivationForTests,
} from "@/components/onboarding/tour/tour-activation";
import { tourStepAction } from "@/components/onboarding/tour/tour-steps";
import {
  resetTourDismissalForTests,
  wasTourDismissedThisLaunch,
} from "@/components/onboarding/tour/use-onboarding-tour-controller";
import {
  currentProps,
  emit,
  focusEpicTab,
  focusDraftTab,
  joyride,
  mountDraftSurface,
  mountEpicSurface,
  mutate,
  next,
  present,
  props,
  sized,
  type Surface,
} from "./joyride-test-harness";
import {
  registerPresentedModal,
  resetModalPresenceForTests,
} from "@/components/ui/modal-presence";
import { registerTileRect } from "@/lib/browser-view/tiles/tile-rect-registry";
import { useAuthStore } from "@/stores/auth/auth-store";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import { useLandingDraftStore } from "@/stores/home/landing-draft-store";
import {
  INITIAL_FLOW,
  useOnboardingFlowStore,
} from "@/stores/onboarding/onboarding-flow-store";
import { useOnboardingPresenceStore } from "@/stores/onboarding/onboarding-presence-store";
import { useLandingReceiptsStore } from "@/stores/onboarding/landing-receipts-store";
import { useImportedUnseenStore } from "@/stores/session-import/imported-unseen-store";
import { useSettingsStore } from "@/stores/settings/settings-store";
import { useTabsStore } from "@/stores/tabs/store";
import { useRemoteFolderPickerStore } from "@/stores/workspace/remote-folder-picker-store";
import { useWorkspaceFoldersStore } from "@/stores/workspace/workspace-folders-store";

/**
 * The controller against the REAL stores (flow, receipts, drafts, tabs,
 * modal presence, picker) with only Joyride faked - the fake records the
 * props the controller hands it and lets a test fire the exact events
 * react-joyride 3.2 emits (including the stale ones the spike measured:
 * F1's paused `step:after`, F3's `tour:end`-only skip). Geometry is not
 * under test here (the spike and the real-Joyride smoke test cover it);
 * jsdom's `checkVisibility` / `getBoundingClientRect` are stubbed so the
 * resolver's presentability filter can answer.
 */

vi.mock("react-joyride", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-joyride")>();
  const harness = await import("./joyride-test-harness");
  function FakeJoyride(props: JoyrideProps): null {
    harness.joyride.props = props;
    useEffect(() => {
      harness.joyride.mounts += 1;
    }, []);
    return null;
  }
  return { ...actual, Joyride: FakeJoyride };
});

vi.mock("@/lib/analytics", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/analytics")>();
  return {
    ...actual,
    Analytics: {
      getInstance: () => ({
        track: analyticsTrack,
        identify: () => undefined,
        reset: () => undefined,
      }),
    },
  };
});
const analyticsTrack = vi.hoisted(() => vi.fn());

// The tab-navigation seam the tour opens a task through (Next on history,
// "Open latest task"): what it is asked for is the contract.
const seam = vi.hoisted(() => ({
  activateTabIntent: vi.fn(),
  navigate: vi.fn(),
}));
vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => seam.navigate,
}));
vi.mock("@/lib/tab-navigation", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/tab-navigation")>();
  return { ...actual, activateTabIntent: seam.activateTabIntent };
});

const DRAFT_ID = "draft-tour";
const HOST_ID = "host-tour";
const EPIC_TAB_ID = "tab-epic-1";
const EPIC_ID = "epic-1";

function startChain(branch: "no-sessions" | "sessions"): void {
  act(() => {
    useOnboardingFlowStore.getState().finishModal(branch);
    useOnboardingFlowStore
      .getState()
      .setContext({ draftId: DRAFT_ID, hostId: HOST_ID });
  });
}

function flow() {
  return useOnboardingFlowStore.getState();
}

function folderInfo(path: string) {
  return { path, name: path, repoIdentifier: null, hostId: HOST_ID };
}

const surfaces: Surface[] = [];
function keep(surface: Surface): Surface {
  surfaces.push(surface);
  return surface;
}

beforeEach(() => {
  window.localStorage.clear();
  joyride.props = null;
  joyride.mounts = 0;
  analyticsTrack.mockClear();
  seam.activateTabIntent.mockReset();
  resetTourDismissalForTests();
  resetActivationForTests();
  resetModalPresenceForTests();
  useOnboardingFlowStore.setState({ ...INITIAL_FLOW });
  useOnboardingPresenceStore.setState({ modalOpen: false, tourBusy: false });
  useLandingReceiptsStore.getState().reset();
  useLandingDraftStore.setState({ drafts: [], activeDraftId: null });
  useWorkspaceFoldersStore.setState({ byHost: {} });
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
  useSettingsStore.setState({ composerMode: "chat" });
  useImportedUnseenStore.setState({ unseen: {} });
  useRemoteFolderPickerStore.getState().settle(null);
  if (typeof Element.prototype.checkVisibility !== "function") {
    // jsdom has none: `hidden` ancestors always fail, and inline
    // `visibility: hidden` fails only when the resolver asks for it, the
    // way a browser's `visibilityProperty` option does.
    Object.defineProperty(Element.prototype, "checkVisibility", {
      configurable: true,
      value(this: Element, options: CheckVisibilityOptions | undefined) {
        if (this.closest("[hidden]") !== null) return false;
        if (options?.visibilityProperty !== true) return true;
        const hiddenByStyle = (node: Element | null): boolean =>
          node !== null &&
          ((node instanceof HTMLElement &&
            node.style.visibility === "hidden") ||
            hiddenByStyle(node.parentElement));
        return !hiddenByStyle(this);
      },
    });
  }
  useAuthStore
    .getState()
    .setSignedIn(
      { userId: "user-a", userName: "A", email: "a@example.com" },
      { userId: "user-a", username: "A" },
      [],
    );
  useLandingDraftStore.getState().createDraftWithId(DRAFT_ID, null);
  focusDraftTab(DRAFT_ID);
});

afterEach(() => {
  cleanup();
  for (const surface of surfaces.splice(0)) surface.remove();
  useAuthStore.getState().setSignedOut();
});

describe("run gating and controlled props", () => {
  it("renders nothing while the chain is not active", () => {
    render(<OnboardingTour />);
    expect(joyride.props).toBeNull();
    expect(useOnboardingPresenceStore.getState().tourBusy).toBe(false);
  });

  it("runs the active chain: stepIndex is the tour's position in the branch order, tourBusy is on", () => {
    keep(mountDraftSurface(DRAFT_ID, ["landing-folder-add"], true));
    render(<OnboardingTour />);
    startChain("no-sessions");
    const p = props();
    expect(p.run).toBe(true);
    expect(p.stepIndex).toBe(0);
    expect(p.steps.map((step) => step.id)).toEqual([
      "add-folder",
      "terminal-mode",
      "submit-prompt",
      "task-panels",
    ]);
    expect(p.continuous).toBe(true);
    expect(p.options?.disableFocusTrap).toBe(true);
    expect(p.options?.overlayClickAction).toBe(false);
    expect(p.options?.zIndex).toBe(45);
    expect(p.options?.targetWaitTimeout).toBe(1500);
    expect(p.options?.dismissKeyAction).toBe("close");
    expect(useOnboardingPresenceStore.getState().tourBusy).toBe(true);
  });

  it("a Settings replay is a one-step order", () => {
    keep(mountEpicSurface(EPIC_TAB_ID, false));
    focusEpicTab(EPIC_TAB_ID, EPIC_ID);
    render(<OnboardingTour />);
    act(() => {
      flow().replayTour("task-panels");
    });
    expect(props().steps.map((step) => step.id)).toEqual(["task-panels"]);
    expect(props().stepIndex).toBe(0);
  });

  it("suspends while a modal is presented or the picker is open, and resumes one macrotask after they clear (F2)", async () => {
    keep(mountDraftSurface(DRAFT_ID, ["landing-folder-add"], true));
    render(<OnboardingTour />);
    startChain("no-sessions");
    expect(props().run).toBe(true);
    let release: () => void = () => undefined;
    act(() => {
      release = registerPresentedModal();
    });
    expect(props().run).toBe(false);
    expect(props().options?.dismissKeyAction).toBe(false);
    expect(useOnboardingPresenceStore.getState().tourBusy).toBe(true);
    act(() => {
      release();
    });
    // Same task: still suspended.
    expect(props().run).toBe(false);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(props().run).toBe(true);
    expect(props().options?.dismissKeyAction).toBe("close");

    act(() => {
      useRemoteFolderPickerStore.setState({ open: true });
    });
    expect(props().run).toBe(false);
    act(() => {
      useRemoteFolderPickerStore.setState({ open: false });
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(props().run).toBe(true);
    // The lesson never moved through any of it.
    expect(flow().activeTourId).toBe("add-folder");
  });
});

describe("event adapter", () => {
  it("Next (step:after / next / running) advances the expected step and tracks it", () => {
    keep(
      mountDraftSurface(
        DRAFT_ID,
        ["landing-folder-add", "landing-terminal-switch"],
        true,
      ),
    );
    render(<OnboardingTour />);
    startChain("no-sessions");
    present();
    next();
    expect(flow().activeTourId).toBe("terminal-mode");
    expect(flow().tours["add-folder"].status).toBe("done");
    expect(analyticsTrack).toHaveBeenCalledWith("onboarding_tour_step", {
      tour: "add-folder",
      step: "add-folder",
      action: "next",
    });
    expect(props().stepIndex).toBe(1);
  });

  it("ignores a step:after carrying a stale action during suspension (F1)", () => {
    keep(mountDraftSurface(DRAFT_ID, ["landing-folder-add"], true));
    render(<OnboardingTour />);
    startChain("no-sessions");
    emit(
      { type: "step:after", action: "next", status: "paused" },
      currentProps(),
    );
    expect(flow().activeTourId).toBe("add-folder");
    expect(analyticsTrack).not.toHaveBeenCalled();
  });

  it("ignores a duplicate / late event for a step that already advanced", () => {
    keep(
      mountDraftSurface(
        DRAFT_ID,
        ["landing-folder-add", "landing-terminal-switch"],
        true,
      ),
    );
    render(<OnboardingTour />);
    startChain("no-sessions");
    const before = currentProps();
    next();
    expect(flow().activeTourId).toBe("terminal-mode");
    // The same event again, from the renderer that was built for add-folder.
    emit(
      { type: "step:after", action: "next", origin: "button_primary" },
      before,
    );
    expect(flow().activeTourId).toBe("terminal-mode");
    expect(flow().tours["terminal-mode"].status).toBe("active");
  });

  it("ignores events from a replaced renderer (old epoch)", async () => {
    const surface = keep(
      mountDraftSurface(DRAFT_ID, ["landing-folder-add"], true),
    );
    render(<OnboardingTour />);
    startChain("no-sessions");
    const old = currentProps();
    // Detach the target: the resolver re-presents under a new epoch.
    await mutate(() => {
      surface.anchors["landing-folder-add"]?.remove();
    });
    expect(currentProps().onEvent).not.toBe(old.onEvent);
    // A replay of the old renderer's Next must not advance anything.
    emit({ type: "step:after", action: "next", origin: "button_primary" }, old);
    expect(flow().activeTourId).toBe("add-folder");
  });

  it("Esc / Pause tour (step:after / close) pauses the chain at its step and marks the launch", () => {
    keep(mountDraftSurface(DRAFT_ID, ["landing-folder-add"], true));
    render(<OnboardingTour />);
    startChain("no-sessions");
    emit(
      { type: "step:after", action: "close", origin: "keyboard" },
      currentProps(),
    );
    expect(flow().chain).toBe("paused");
    expect(flow().activeTourId).toBe("add-folder");
    expect(wasTourDismissedThisLaunch()).toBe(true);
    expect(useOnboardingPresenceStore.getState().tourBusy).toBe(false);
    expect(analyticsTrack).toHaveBeenCalledWith("onboarding_tour_step", {
      tour: "add-folder",
      step: "add-folder",
      action: "pause",
    });
    expect(joyride.props?.run ?? false).toBe(false);
  });

  it("Skip arrives as tour:end/skipped only (F3) and ends the chain for good", () => {
    keep(mountDraftSurface(DRAFT_ID, ["landing-folder-add"], true));
    render(<OnboardingTour />);
    startChain("no-sessions");
    emit(
      {
        type: "tour:end",
        action: "skip",
        status: "skipped",
        origin: "button_skip",
      },
      currentProps(),
    );
    expect(flow().chain).toBe("skipped");
    expect(analyticsTrack).toHaveBeenCalledWith("onboarding_tour_step", {
      tour: "add-folder",
      step: "add-folder",
      action: "skip",
    });
    expect(analyticsTrack).toHaveBeenCalledWith("onboarding_chain_ended", {
      reason: "skipped",
      branch: "no-sessions",
    });
  });

  it("a finished tour:end after the last Next changes nothing the flow did not already do", () => {
    keep(mountEpicSurface(EPIC_TAB_ID, false));
    focusEpicTab(EPIC_TAB_ID, EPIC_ID);
    render(<OnboardingTour />);
    act(() => {
      // A replay from Settings after the branch chain ran.
      flow().finishModal("no-sessions");
      flow().skipChain();
      flow().replayTour("task-panels");
    });
    const p = currentProps();
    next();
    expect(flow().chain).toBe("completed");
    emit({ type: "tour:end", action: "next", status: "finished" }, p);
    expect(flow().chain).toBe("completed");
    expect(analyticsTrack).toHaveBeenCalledWith("onboarding_chain_ended", {
      reason: "completed",
      branch: "no-sessions",
    });
    expect(analyticsTrack).toHaveBeenCalledTimes(2);
  });
});

describe("targets and presentation", () => {
  it("resolves the anchor inside the VISIBLE surface of the context draft, never a hidden duplicate", () => {
    keep(mountDraftSurface(DRAFT_ID, ["landing-folder-add"], false));
    const visible = keep(
      mountDraftSurface(DRAFT_ID, ["landing-folder-add"], true),
    );
    keep(mountDraftSurface("other-draft", ["landing-folder-add"], true));
    render(<OnboardingTour />);
    startChain("no-sessions");
    const step = props().steps.at(0);
    if (step === undefined || typeof step.target !== "function") {
      throw new Error("expected a function target");
    }
    expect(step.target()).toBe(visible.anchors["landing-folder-add"]);
    expect(step.placement).toBe("bottom");
  });

  it("a missing target is the centred, undimmed card at once (B3) - never a bare dim - and the anchor mounting later re-anchors it", async () => {
    render(<OnboardingTour />);
    startChain("no-sessions");
    const missing = props().steps.at(0);
    expect(missing?.id).toBe("add-folder");
    expect(missing?.placement).toBe("center");
    expect(missing?.hideOverlay).toBe(true);
    expect(missing?.target).toBeTypeOf("function");
    expect(flow().activeTourId).toBe("add-folder");
    const epochBefore = joyride.mounts;
    const surface = keep(
      mountDraftSurface(DRAFT_ID, ["landing-folder-add"], true),
    );
    await mutate(() => undefined);
    const anchored = props().steps.at(0);
    if (anchored === undefined || typeof anchored.target !== "function") {
      throw new Error("expected a function target");
    }
    expect(anchored.placement).toBe("bottom");
    expect(anchored.target()).toBe(surface.anchors["landing-folder-add"]);
    expect(joyride.mounts).toBeGreaterThan(epochBefore);
  });

  it("a visibility:hidden anchor is not a target (P2): the unanchored card shows, no overlay; once visible the anchored step keeps its overlay hidden until the card presents, then dims", async () => {
    const surface = keep(
      mountDraftSurface(DRAFT_ID, ["landing-folder-add"], true),
    );
    const anchor = surface.anchors["landing-folder-add"];
    if (anchor === undefined) throw new Error("anchor missing");
    anchor.style.visibility = "hidden";
    render(<OnboardingTour />);
    startChain("no-sessions");
    const hidden = props().steps.at(0);
    expect(hidden?.placement).toBe("center");
    expect(hidden?.hideOverlay).toBe(true);
    await mutate(() => {
      anchor.style.visibility = "";
    });
    const anchored = props().steps.at(0);
    if (anchored === undefined || typeof anchored.target !== "function") {
      throw new Error("expected a function target");
    }
    expect(anchored.target()).toBe(anchor);
    expect(anchored.placement).toBe("bottom");
    // Card first: no dim through Joyride's own wait / scroll transit.
    expect(anchored.hideOverlay).toBe(true);
    present();
    const dimmed = props().steps.at(0);
    expect(dimmed?.hideOverlay).toBe(false);
    expect(dimmed?.placement).toBe("bottom");
    expect(joyride.props?.loaderComponent).toBeNull();
  });

  it("a node Joyride refuses (target_not_found on its wait) swaps in the centred fallback without touching progress; Next still acknowledges", () => {
    keep(mountDraftSurface(DRAFT_ID, ["landing-folder-add"], true));
    render(<OnboardingTour />);
    startChain("no-sessions");
    expect(props().steps.at(0)?.placement).toBe("bottom");
    const epochBefore = joyride.mounts;
    emit(
      { type: "error:target_not_found", lifecycle: "ready" },
      currentProps(),
    );
    const fallback = props().steps.at(0);
    expect(fallback?.placement).toBe("center");
    expect(fallback?.hideOverlay).toBe(true);
    expect(fallback?.id).toBe("add-folder");
    expect(joyride.mounts).toBeGreaterThan(epochBefore);
    expect(flow().activeTourId).toBe("add-folder");
    next();
    expect(flow().activeTourId).toBe("terminal-mode");
  });

  it("a target that detaches after presenting drops to the fallback at once, and returns anchored when it is back", async () => {
    const surface = keep(
      mountDraftSurface(DRAFT_ID, ["landing-folder-add"], true),
    );
    render(<OnboardingTour />);
    startChain("no-sessions");
    present();
    const anchor = surface.anchors["landing-folder-add"];
    if (anchor === undefined) throw new Error("anchor missing");
    await mutate(() => {
      anchor.remove();
    });
    expect(props().steps.at(0)?.placement).toBe("center");
    expect(props().steps.at(0)?.hideOverlay).toBe(true);
    expect(flow().activeTourId).toBe("add-folder");
    await mutate(() => {
      surface.root.append(anchor);
    });
    const back = props().steps.at(0);
    if (back === undefined || typeof back.target !== "function") {
      throw new Error("expected a function target");
    }
    expect(back.placement).toBe("bottom");
    expect(back.target()).toBe(anchor);
  });

  it("add-folder anchors the workspace summary when the draft already has a folder bound (B4), and prefers the bare Add button when both are there", async () => {
    const surface = keep(
      mountDraftSurface(DRAFT_ID, ["landing-workspace-summary"], true),
    );
    act(() => {
      useLandingDraftStore
        .getState()
        .addDraftResolvedFolders(DRAFT_ID, [folderInfo("/bound")]);
    });
    render(<OnboardingTour />);
    startChain("no-sessions");
    const step = props().steps.at(0);
    if (step === undefined || typeof step.target !== "function") {
      throw new Error("expected a function target");
    }
    expect(step.placement).toBe("bottom");
    expect(step.target()).toBe(surface.anchors["landing-workspace-summary"]);
    expect(flow().activeTourId).toBe("add-folder");
    const addButton = sized(document.createElement("button"));
    addButton.setAttribute("data-tour", "landing-folder-add");
    await mutate(() => {
      surface.root.append(addButton);
    });
    const preferred = props().steps.at(0);
    if (preferred === undefined || typeof preferred.target !== "function") {
      throw new Error("expected a function target");
    }
    expect(preferred.target()).toBe(addButton);
  });

  it("submit-prompt falls back to the mode switch while terminal mode hides Send", () => {
    const surface = keep(
      mountDraftSurface(DRAFT_ID, ["landing-terminal-switch"], true),
    );
    render(<OnboardingTour />);
    startChain("no-sessions");
    act(() => {
      flow().advance("add-folder", "add-folder", "next");
      flow().advance("terminal-mode", "terminal-mode", "next");
    });
    expect(flow().activeTourId).toBe("submit-prompt");
    const step = props().steps.at(props().stepIndex ?? 0);
    if (step === undefined || typeof step.target !== "function") {
      throw new Error("expected a function target");
    }
    expect(step.target()).toBe(surface.anchors["landing-terminal-switch"]);
  });

  it("a live local browser guest on screen suspends the spotlight (B2): same lesson and copy, centred, no dim, a new renderer; the spotlight returns when it leaves", () => {
    const surface = keep(mountEpicSurface(EPIC_TAB_ID, false));
    focusEpicTab(EPIC_TAB_ID, EPIC_ID);
    render(<OnboardingTour />);
    act(() => {
      flow().replayTour("task-panels");
    });
    const spotlit = props().steps.at(0);
    if (spotlit === undefined || typeof spotlit.target !== "function") {
      throw new Error("expected a function target");
    }
    expect(spotlit.target()).toBe(surface.anchors.column);
    present();
    expect(props().steps.at(0)?.hideOverlay).toBe(false);
    const mountsBefore = joyride.mounts;
    let unregister: () => void = () => undefined;
    act(() => {
      unregister = registerTileRect(
        {
          viewTabId: "view-1",
          paneId: "pane-1",
          tileInstanceId: "tile-1",
          pageSessionId: "page-1",
        },
        sized(document.createElement("div")),
      );
    });
    const suspended = props().steps.at(0);
    expect(suspended?.id).toBe("task-panels");
    expect(suspended?.placement).toBe("center");
    expect(suspended?.hideOverlay).toBe(true);
    expect(suspended?.content).toBe(spotlit.content);
    expect(joyride.mounts).toBeGreaterThan(mountsBefore);
    expect(flow().activeTourId).toBe("task-panels");
    // The centred card presenting during the suspension does not pre-arm
    // the dim of the renderer that replaces it.
    present();
    act(() => {
      unregister();
    });
    const restored = props().steps.at(0);
    if (restored === undefined || typeof restored.target !== "function") {
      throw new Error("expected a function target");
    }
    expect(restored.placement).toBe("right");
    expect(restored.target()).toBe(surface.anchors.column);
    // Card first again - it presented before the suspension, not since.
    expect(restored.hideOverlay).toBe(true);
    present();
    expect(props().steps.at(0)?.hideOverlay).toBe(false);
  });

  it("task-panels spotlights the column, else the rail, inside the context epic surface; mounting never finishes it", () => {
    const surface = keep(mountEpicSurface(EPIC_TAB_ID, true));
    focusEpicTab(EPIC_TAB_ID, EPIC_ID);
    render(<OnboardingTour />);
    act(() => {
      flow().replayTour("task-panels");
    });
    const step = props().steps.at(0);
    if (step === undefined || typeof step.target !== "function") {
      throw new Error("expected a function target");
    }
    expect(step.target()).toBe(surface.anchors.rail);
    expect(flow().context).toMatchObject({
      epicId: EPIC_ID,
      tabId: EPIC_TAB_ID,
    });
    present();
    expect(flow().chain).toBe("active");
    next();
    expect(flow().chain).toBe("completed");
  });
});

describe("lesson predicates", () => {
  it("add-folder: a path absent at entry auto-advances; re-adding an existing one or an equal count does not", () => {
    keep(mountDraftSurface(DRAFT_ID, ["landing-folder-add"], true));
    act(() => {
      useLandingDraftStore
        .getState()
        .addDraftResolvedFolders(DRAFT_ID, [
          folderInfo("/a"),
          folderInfo("/b"),
        ]);
    });
    render(<OnboardingTour />);
    startChain("no-sessions");
    act(() => {
      useLandingDraftStore.getState().removeDraftFolder(DRAFT_ID, "/a");
      useLandingDraftStore
        .getState()
        .addDraftResolvedFolders(DRAFT_ID, [folderInfo("/a")]);
    });
    expect(flow().activeTourId).toBe("add-folder");
    act(() => {
      useLandingDraftStore.getState().removeDraftFolder(DRAFT_ID, "/b");
      useLandingDraftStore
        .getState()
        .addDraftResolvedFolders(DRAFT_ID, [folderInfo("/c")]);
    });
    // Count unchanged (2 -> 2), path new.
    expect(flow().activeTourId).toBe("terminal-mode");
    expect(analyticsTrack).toHaveBeenCalledWith("onboarding_tour_step", {
      tour: "add-folder",
      step: "add-folder",
      action: "auto",
    });
  });

  it("add-folder: a Settings replay starts a fresh baseline - the folders already there do not count, a new one does", () => {
    keep(mountDraftSurface(DRAFT_ID, ["landing-folder-add"], true));
    act(() => {
      useLandingDraftStore
        .getState()
        .addDraftResolvedFolders(DRAFT_ID, [folderInfo("/a")]);
    });
    render(<OnboardingTour />);
    startChain("no-sessions");
    act(() => {
      flow().skipChain();
      flow().replayTour("add-folder");
    });
    // Replay cleared the context; the focused draft is re-captured.
    expect(flow().context?.draftId).toBe(DRAFT_ID);
    expect(flow().activeTourId).toBe("add-folder");
    act(() => {
      useLandingDraftStore
        .getState()
        .addDraftResolvedFolders(DRAFT_ID, [folderInfo("/b")]);
    });
    expect(flow().chain).toBe("completed");
  });

  it("a Next that races an auto-advance of the same step cannot advance twice", () => {
    keep(
      mountDraftSurface(
        DRAFT_ID,
        ["landing-folder-add", "landing-terminal-switch"],
        true,
      ),
    );
    render(<OnboardingTour />);
    startChain("no-sessions");
    const before = currentProps();
    act(() => {
      useLandingDraftStore
        .getState()
        .addDraftResolvedFolders(DRAFT_ID, [folderInfo("/new")]);
    });
    expect(flow().activeTourId).toBe("terminal-mode");
    emit(
      { type: "step:after", action: "next", origin: "button_primary" },
      before,
    );
    expect(flow().activeTourId).toBe("terminal-mode");
    expect(flow().tours["terminal-mode"].status).toBe("active");
  });

  it("add-folder: a folder added to a DIFFERENT draft is not this lesson's", () => {
    keep(mountDraftSurface(DRAFT_ID, ["landing-folder-add"], true));
    useLandingDraftStore.getState().createDraftWithId("other", null);
    render(<OnboardingTour />);
    startChain("no-sessions");
    act(() => {
      useLandingDraftStore
        .getState()
        .addDraftResolvedFolders("other", [folderInfo("/x")]);
    });
    expect(flow().activeTourId).toBe("add-folder");
  });

  it("terminal-mode: the bound draft switching to terminal auto-advances; the mode is never reset", () => {
    keep(mountDraftSurface(DRAFT_ID, ["landing-terminal-switch"], true));
    render(<OnboardingTour />);
    startChain("no-sessions");
    act(() => {
      flow().advance("add-folder", "add-folder", "next");
    });
    expect(flow().activeTourId).toBe("terminal-mode");
    act(() => {
      useLandingDraftStore
        .getState()
        .setDraftComposerMode(DRAFT_ID, "terminal");
    });
    expect(flow().activeTourId).toBe("submit-prompt");
    expect(
      useLandingDraftStore.getState().drafts.find((d) => d.id === DRAFT_ID)
        ?.composerMode,
    ).toBe("terminal");
  });

  it("terminal-mode: a Settings replay with the composer ALREADY in terminal does not self-complete (B7); a switch into terminal after entry does, and Next still works", () => {
    keep(mountDraftSurface(DRAFT_ID, ["landing-terminal-switch"], true));
    act(() => {
      useLandingDraftStore
        .getState()
        .setDraftComposerMode(DRAFT_ID, "terminal");
    });
    render(<OnboardingTour />);
    act(() => {
      flow().finishModal("no-sessions");
      flow().skipChain();
      flow().replayTour("terminal-mode");
    });
    expect(flow().context?.draftId).toBe(DRAFT_ID);
    expect(flow().chain).toBe("active");
    expect(flow().activeTourId).toBe("terminal-mode");
    expect(props().steps.at(0)?.placement).toBe("top");
    // Chat and back: a switch into terminal observed since entry.
    act(() => {
      useLandingDraftStore.getState().setDraftComposerMode(DRAFT_ID, "chat");
    });
    expect(flow().chain).toBe("active");
    act(() => {
      useLandingDraftStore
        .getState()
        .setDraftComposerMode(DRAFT_ID, "terminal");
    });
    expect(flow().chain).toBe("completed");

    // Next acknowledges a replay that never flips.
    act(() => {
      flow().replayTour("terminal-mode");
    });
    expect(flow().chain).toBe("active");
    next();
    expect(flow().chain).toBe("completed");

    // The branch chain keeps "already there at entry counts".
    act(() => {
      flow().finishModal("no-sessions");
      flow().setContext({ draftId: DRAFT_ID, hostId: HOST_ID });
      flow().advance("add-folder", "add-folder", "next");
    });
    expect(flow().activeTourId).toBe("submit-prompt");
  });

  it("terminal-mode: a replay whose draft record loads late (null -> terminal) is not a switch (P3); a later chat -> terminal is", () => {
    const LATE_DRAFT = "draft-late";
    keep(mountDraftSurface(LATE_DRAFT, ["landing-terminal-switch"], true));
    render(<OnboardingTour />);
    act(() => {
      flow().finishModal("no-sessions");
      flow().skipChain();
      flow().replayTour("terminal-mode");
      // A saved id restored before its record exists.
      flow().setContext({ draftId: LATE_DRAFT, hostId: HOST_ID });
    });
    expect(flow().chain).toBe("active");
    act(() => {
      useLandingDraftStore.getState().createDraftWithId(LATE_DRAFT, null);
      useLandingDraftStore
        .getState()
        .setDraftComposerMode(LATE_DRAFT, "terminal");
    });
    expect(flow().chain).toBe("active");
    expect(flow().activeTourId).toBe("terminal-mode");
    act(() => {
      useLandingDraftStore.getState().setDraftComposerMode(LATE_DRAFT, "chat");
    });
    act(() => {
      useLandingDraftStore
        .getState()
        .setDraftComposerMode(LATE_DRAFT, "terminal");
    });
    expect(flow().chain).toBe("completed");
  });

  it("submit-prompt: only a prompt-accepted receipt matching draft/host/attempt advances and records the destination; optimistic navigation does not", () => {
    keep(mountDraftSurface(DRAFT_ID, ["landing-send"], true));
    render(<OnboardingTour />);
    startChain("no-sessions");
    act(() => {
      flow().advance("add-folder", "add-folder", "next");
      flow().advance("terminal-mode", "terminal-mode", "next");
    });
    expect(flow().activeTourId).toBe("submit-prompt");
    // Optimistic navigation to some epic is not acceptance.
    act(() => {
      focusEpicTab("tab-optimistic", "epic-optimistic");
    });
    expect(flow().activeTourId).toBe("submit-prompt");
    const receipts = useLandingReceiptsStore.getState();
    // A create for another draft: announced, accepted, irrelevant.
    let generation = 0;
    act(() => {
      generation = receipts.announce({
        kind: "prompt-accepted",
        attemptId: "attempt-other",
        draftId: "other-draft",
        hostId: HOST_ID,
      });
      receipts.emit(
        {
          kind: "prompt-accepted",
          attemptId: "attempt-other",
          draftId: "other-draft",
          epicId: "e-other",
          tabId: "t-other",
          hostId: HOST_ID,
        },
        generation,
      );
    });
    expect(flow().activeTourId).toBe("submit-prompt");
    expect(flow().context?.attemptId).toBeNull();
    // The same draft on the WRONG host is not this lesson's either: never
    // captured, and its receipt never matched.
    act(() => {
      generation = receipts.announce({
        kind: "prompt-accepted",
        attemptId: "attempt-host",
        draftId: DRAFT_ID,
        hostId: "host-other",
      });
    });
    expect(flow().context?.attemptId).toBeNull();
    expect(flow().context?.hostId).toBe(HOST_ID);
    act(() => {
      receipts.emit(
        {
          kind: "prompt-accepted",
          attemptId: "attempt-host",
          draftId: DRAFT_ID,
          epicId: "e-host",
          tabId: "t-host",
          hostId: "host-other",
        },
        generation,
      );
    });
    expect(flow().activeTourId).toBe("submit-prompt");
    // This draft's attempt: captured at dispatch...
    act(() => {
      generation = receipts.announce({
        kind: "prompt-accepted",
        attemptId: "attempt-1",
        draftId: DRAFT_ID,
        hostId: HOST_ID,
      });
    });
    expect(flow().context?.attemptId).toBe("attempt-1");
    // ...refused: retired, lesson stays, Next still works.
    act(() => {
      receipts.retire("attempt-1");
    });
    expect(flow().activeTourId).toBe("submit-prompt");
    // Re-sent and accepted this time.
    act(() => {
      generation = receipts.announce({
        kind: "prompt-accepted",
        attemptId: "attempt-2",
        draftId: DRAFT_ID,
        hostId: HOST_ID,
      });
      receipts.emit(
        {
          kind: "prompt-accepted",
          attemptId: "attempt-2",
          draftId: DRAFT_ID,
          epicId: EPIC_ID,
          tabId: EPIC_TAB_ID,
          hostId: HOST_ID,
        },
        generation,
      );
    });
    expect(flow().activeTourId).toBe("task-panels");
    expect(flow().context).toMatchObject({
      epicId: EPIC_ID,
      tabId: EPIC_TAB_ID,
      hostId: HOST_ID,
      attemptId: null,
    });
    // Consumed once; the unrelated draft's receipt is simply never matched.
    expect(Object.keys(useLandingReceiptsStore.getState().byAttemptId)).toEqual(
      ["attempt-other", "attempt-host"],
    );
  });

  it("A2: an accepted terminal Start during terminal-mode detours to the panels and bypasses the prompt; a rejected one keeps the checkpoint", () => {
    keep(mountDraftSurface(DRAFT_ID, ["landing-terminal-switch"], true));
    render(<OnboardingTour />);
    startChain("no-sessions");
    act(() => {
      flow().advance("add-folder", "add-folder", "next");
    });
    const receipts = useLandingReceiptsStore.getState();
    let generation = 0;
    act(() => {
      generation = receipts.announce({
        kind: "tui-accepted",
        attemptId: "start-1",
        draftId: DRAFT_ID,
        hostId: HOST_ID,
      });
    });
    expect(flow().context?.attemptId).toBe("start-1");
    // The pending Start freezes the ordinary mode predicate...
    act(() => {
      useLandingDraftStore
        .getState()
        .setDraftComposerMode(DRAFT_ID, "terminal");
    });
    expect(flow().activeTourId).toBe("terminal-mode");
    // ...a rejected create keeps the checkpoint and unfreezes it.
    act(() => {
      receipts.retire("start-1");
    });
    expect(flow().activeTourId).toBe("submit-prompt");
    // Start again from the prompt lesson, accepted: detour.
    act(() => {
      generation = receipts.announce({
        kind: "tui-accepted",
        attemptId: "start-2",
        draftId: DRAFT_ID,
        hostId: HOST_ID,
      });
      receipts.emit(
        {
          kind: "tui-accepted",
          attemptId: "start-2",
          draftId: DRAFT_ID,
          epicId: EPIC_ID,
          tabId: EPIC_TAB_ID,
          hostId: HOST_ID,
        },
        generation,
      );
    });
    expect(flow().activeTourId).toBe("task-panels");
    expect(flow().tours["submit-prompt"].status).toBe("bypassed");
    expect(analyticsTrack).toHaveBeenCalledWith("onboarding_tour_step", {
      tour: "submit-prompt",
      step: "submit-prompt",
      action: "auto",
    });
  });

  it("a prompt accepted DURING terminal-mode completes mode and prompt (both done, none bypassed) and lands on the panels", () => {
    keep(mountDraftSurface(DRAFT_ID, ["landing-terminal-switch"], true));
    render(<OnboardingTour />);
    startChain("no-sessions");
    act(() => {
      flow().advance("add-folder", "add-folder", "next");
    });
    const receipts = useLandingReceiptsStore.getState();
    let generation = 0;
    act(() => {
      generation = receipts.announce({
        kind: "prompt-accepted",
        attemptId: "prompt-early",
        draftId: DRAFT_ID,
        hostId: HOST_ID,
      });
      receipts.emit(
        {
          kind: "prompt-accepted",
          attemptId: "prompt-early",
          draftId: DRAFT_ID,
          epicId: EPIC_ID,
          tabId: EPIC_TAB_ID,
          hostId: HOST_ID,
        },
        generation,
      );
    });
    expect(flow().activeTourId).toBe("task-panels");
    expect(flow().tours["terminal-mode"].status).toBe("done");
    expect(flow().tours["submit-prompt"].status).toBe("done");
    expect(flow().context).toMatchObject({
      epicId: EPIC_ID,
      tabId: EPIC_TAB_ID,
    });
    expect(analyticsTrack).toHaveBeenCalledWith("onboarding_tour_step", {
      tour: "submit-prompt",
      step: "submit-prompt",
      action: "auto",
    });
  });

  it("a same-tour replay while the chain is active invalidates the old attempt's receipt and the old renderer's callback", () => {
    keep(mountDraftSurface(DRAFT_ID, ["landing-send"], true));
    render(<OnboardingTour />);
    startChain("no-sessions");
    act(() => {
      flow().advance("add-folder", "add-folder", "next");
      flow().advance("terminal-mode", "terminal-mode", "next");
    });
    const receipts = useLandingReceiptsStore.getState();
    let generation = 0;
    act(() => {
      generation = receipts.announce({
        kind: "prompt-accepted",
        attemptId: "old-attempt",
        draftId: DRAFT_ID,
        hostId: HOST_ID,
      });
    });
    expect(flow().context?.attemptId).toBe("old-attempt");
    const oldRenderer = currentProps();
    // Settings replays the very same tour while it is active.
    act(() => {
      flow().replayTour("submit-prompt");
      flow().setContext({ draftId: DRAFT_ID, hostId: HOST_ID });
    });
    expect(flow().chainScope).toBe("single");
    // The old attempt's receipt lands late: dropped (generation moved).
    act(() => {
      receipts.emit(
        {
          kind: "prompt-accepted",
          attemptId: "old-attempt",
          draftId: DRAFT_ID,
          epicId: EPIC_ID,
          tabId: EPIC_TAB_ID,
          hostId: HOST_ID,
        },
        generation,
      );
    });
    expect(flow().chain).toBe("active");
    expect(flow().activeTourId).toBe("submit-prompt");
    // The old renderer's Next lands late: rejected (activation moved).
    emit(
      { type: "step:after", action: "next", origin: "button_primary" },
      oldRenderer,
    );
    expect(flow().chain).toBe("active");
    // The replay's own Next still works.
    next();
    expect(flow().chain).toBe("completed");
  });

  it("a same-tour replay of an UNANCHORED lesson (context already null) still invalidates the old renderer's callback", () => {
    render(<OnboardingTour />);
    act(() => {
      flow().finishModal("no-sessions");
      flow().replayTour("task-panels");
    });
    expect(flow().context).toBeNull();
    const oldRenderer = currentProps();
    act(() => {
      flow().replayTour("task-panels");
    });
    expect(flow().context).toBeNull();
    emit(
      { type: "step:after", action: "next", origin: "button_primary" },
      oldRenderer,
    );
    expect(flow().chain).toBe("active");
    next();
    expect(flow().chain).toBe("completed");
  });

  it("a user switch with the auth status unchanged (A out, B in) invalidates the old renderer's callback", () => {
    keep(mountDraftSurface(DRAFT_ID, ["landing-folder-add"], true));
    render(<OnboardingTour />);
    startChain("no-sessions");
    const oldRenderer = currentProps();
    act(() => {
      useAuthStore
        .getState()
        .setSignedIn(
          { userId: "user-b", userName: "B", email: "b@example.com" },
          { userId: "user-b", username: "B" },
          [],
        );
    });
    emit(
      { type: "step:after", action: "next", origin: "button_primary" },
      oldRenderer,
    );
    expect(flow().activeTourId).toBe("add-folder");
  });

  it("history: unrelated rows do not anchor the lesson; the first imported ROW mounting does (B5: the row, never the viewport-tall list), to its right", async () => {
    const surface = keep(
      mountDraftSurface(DRAFT_ID, ["landing-history"], true),
    );
    const container = surface.anchors["landing-history"];
    if (container === undefined) throw new Error("container missing");
    const unrelated = sized(document.createElement("li"));
    unrelated.setAttribute("data-epic-id", "epic-unrelated");
    container.append(unrelated);
    act(() => {
      useImportedUnseenStore.setState({ unseen: { [EPIC_ID]: undefined } });
    });
    render(<OnboardingTour />);
    startChain("sessions");
    let step = props().steps.at(props().stepIndex ?? 0);
    expect(step?.placement).toBe("center");
    const imported = sized(document.createElement("li"));
    imported.setAttribute("data-epic-id", EPIC_ID);
    await mutate(() => {
      container.append(imported);
    });
    step = props().steps.at(props().stepIndex ?? 0);
    if (step === undefined || typeof step.target !== "function") {
      throw new Error("expected a function target");
    }
    expect(step.target()).toBe(imported);
    expect(step.placement).toBe("right");
  });

  it("keyboard Finish does not arm the next-card focus; keyboard Next does, for the same activation only", () => {
    // Direct unit of the intent store the card reads.
    armFocusNextCard();
    expect(consumeFocusNextCard()).toBe(true);
    expect(consumeFocusNextCard()).toBe(false);
    render(<OnboardingTour />);
    startChain("no-sessions");
    armFocusNextCard();
    act(() => {
      // A replay moves the activation: the armed intent no longer applies.
      flow().replayTour("add-folder");
    });
    expect(consumeFocusNextCard()).toBe(false);
  });

  it("history: a task the user opens (new focused epic with its surface mounted) advances to the panels with that epic as context; the epic focused at entry does not", () => {
    keep(mountDraftSurface(DRAFT_ID, ["landing-history"], true));
    render(<OnboardingTour />);
    startChain("sessions");
    expect(flow().activeTourId).toBe("history");
    // The surface for the epic must be mounted, not just the tab focused.
    act(() => {
      focusEpicTab(EPIC_TAB_ID, EPIC_ID);
    });
    expect(flow().activeTourId).toBe("history");
    keep(mountEpicSurface(EPIC_TAB_ID, false));
    act(() => {
      // Any store tick re-checks; the observer does too.
      useTabsStore.setState({ ...useTabsStore.getState() });
    });
    expect(flow().activeTourId).toBe("task-panels");
    expect(flow().context).toMatchObject({
      epicId: EPIC_ID,
      tabId: EPIC_TAB_ID,
    });
  });

  it("history -> Next with no epic focused opens the imported task the card pointed at through the seam (B6); the panels lesson then binds the focused epic", async () => {
    const surface = keep(
      mountDraftSurface(DRAFT_ID, ["landing-history"], true),
    );
    const container = surface.anchors["landing-history"];
    if (container === undefined) throw new Error("container missing");
    const imported = sized(document.createElement("li"));
    imported.setAttribute("data-epic-id", EPIC_ID);
    container.append(imported);
    act(() => {
      useImportedUnseenStore.setState({ unseen: { [EPIC_ID]: undefined } });
    });
    render(<OnboardingTour />);
    startChain("sessions");
    await mutate(() => undefined);
    present();
    expect(seam.activateTabIntent).not.toHaveBeenCalled();
    next();
    expect(flow().activeTourId).toBe("task-panels");
    expect(seam.activateTabIntent).toHaveBeenCalledTimes(1);
    expect(seam.activateTabIntent).toHaveBeenCalledWith(
      seam.navigate,
      expect.objectContaining({ kind: "open-epic", epicId: EPIC_ID }),
      undefined,
    );
    // The seam lands the epic tab: bound as the panels lesson's task.
    keep(mountEpicSurface(EPIC_TAB_ID, false));
    act(() => {
      focusEpicTab(EPIC_TAB_ID, EPIC_ID);
    });
    expect(flow().context).toMatchObject({
      epicId: EPIC_ID,
      tabId: EPIC_TAB_ID,
    });
    await mutate(() => undefined);
    const step = props().steps.at(props().stepIndex ?? 0);
    if (step === undefined || typeof step.target !== "function") {
      throw new Error("expected a function target");
    }
    expect(step.placement).toBe("right");
    expect(step.target()).not.toBeNull();
  });

  it("history -> Next with an epic already focused opens nothing: that epic becomes the panels lesson's task", () => {
    keep(mountDraftSurface(DRAFT_ID, ["landing-history"], true));
    keep(mountEpicSurface(EPIC_TAB_ID, false));
    focusEpicTab(EPIC_TAB_ID, EPIC_ID);
    render(<OnboardingTour />);
    startChain("sessions");
    next();
    expect(flow().activeTourId).toBe("task-panels");
    expect(seam.activateTabIntent).not.toHaveBeenCalled();
    expect(flow().context).toMatchObject({ tabId: EPIC_TAB_ID });
  });

  it("history -> Next with nothing imported: the panels card is unbound - 'Open a task to continue' - and offers the list's latest task when there is one (B6)", async () => {
    const surface = keep(
      mountDraftSurface(DRAFT_ID, ["landing-history"], true),
    );
    const container = surface.anchors["landing-history"];
    if (container === undefined) throw new Error("container missing");
    render(<OnboardingTour />);
    startChain("sessions");
    next();
    expect(flow().activeTourId).toBe("task-panels");
    expect(seam.activateTabIntent).not.toHaveBeenCalled();
    let step = props().steps.at(props().stepIndex ?? 0);
    expect(step?.placement).toBe("center");
    expect(step?.content).toBe("Open a task to continue.");
    expect(step === undefined ? null : tourStepAction(step)).toBeNull();
    // An (unimported) task shows up in the list: the card can open it.
    const latest = sized(document.createElement("li"));
    latest.setAttribute("data-epic-id", "epic-latest");
    await mutate(() => {
      container.append(latest);
    });
    step = props().steps.at(props().stepIndex ?? 0);
    const action = step === undefined ? null : tourStepAction(step);
    expect(action?.label).toBe("Open latest task");
    act(() => {
      action?.run();
    });
    expect(seam.activateTabIntent).toHaveBeenCalledWith(
      seam.navigate,
      expect.objectContaining({ kind: "open-epic", epicId: "epic-latest" }),
      undefined,
    );
    expect(flow().activeTourId).toBe("task-panels");
  });

  it("history: an epic already focused at entry is not a user-opened transition", () => {
    keep(mountEpicSurface(EPIC_TAB_ID, false));
    focusEpicTab(EPIC_TAB_ID, EPIC_ID);
    render(<OnboardingTour />);
    startChain("sessions");
    act(() => {
      useTabsStore.setState({ ...useTabsStore.getState() });
    });
    expect(flow().activeTourId).toBe("history");
  });
});
