import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { LazyMotion, domAnimation } from "motion/react";
import { useOnboardingStore } from "@/stores/onboarding/onboarding-store";
import { onboardingActsFor } from "@/components/onboarding/onboarding-acts";
import { AnalyticsEvent } from "@/lib/analytics";
import type { OnboardingAgentGuideState } from "@/components/onboarding/onboarding-agent-guide-pane";
import type { OnboardingPhoneSceneId } from "@/components/onboarding/onboarding-phone-diorama";
import { setMobileApp } from "@/lib/mobile-app";

// Stub heavy layout-only sub-trees that have no bearing on the platform wiring.
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

vi.mock("@/components/onboarding/onboarding-diorama", () => ({
  OnboardingDiorama: () => <div data-testid="onboarding-diorama-stub" />,
}));

// The phone tour never lists the session-import act, but the page still
// imports its stage and capability hook; stub both so this suite neither
// loads the wizard tree nor needs a negotiated stream runtime.
vi.mock("@/components/onboarding/onboarding-session-import-stage", () => ({
  OnboardingSessionImportStage: () => (
    <div data-testid="session-import-stage-stub" />
  ),
}));

vi.mock("@/hooks/session-import/use-session-import-available", () => ({
  useSessionImportAvailable: () => false,
}));

vi.mock("@/components/onboarding/onboarding-phone-diorama", () => ({
  OnboardingPhoneDiorama: (props: {
    readonly scene: OnboardingPhoneSceneId;
  }) => (
    <div data-testid="onboarding-phone-diorama-stub" data-scene={props.scene} />
  ),
}));

// The real pane is a CodeMirror surface - a `[contenteditable]` div, not a
// `textarea` - so the mock renders both: the textarea drives the existing
// value-plumbing tests, and the contenteditable sibling is what exercises the
// swipe recognizer's `[contenteditable]` exemption arm.
vi.mock("@/components/onboarding/onboarding-agent-guide-pane", () => ({
  OnboardingAgentGuidePane: (props: {
    readonly agentGuide: OnboardingAgentGuideState;
  }) => (
    <div>
      <textarea
        data-testid="mock-agent-guide-input"
        aria-label="Agent selection guide"
        value={props.agentGuide.value}
        disabled={props.agentGuide.loading || props.agentGuide.saving}
        onChange={(event) => props.agentGuide.onValueChange(event.target.value)}
      />
      <div
        data-testid="mock-agent-guide-contenteditable"
        contentEditable
        suppressContentEditableWarning
      />
    </div>
  ),
}));

let guideQueryState = {
  data: {
    content: "saved guide" as string | null,
    generatedDefaultContent: "claude guide",
    providersSettled: true,
  },
  isError: false,
};
const setGlobalGuideMock = vi.fn((variables: { readonly content: string }) =>
  Promise.resolve({
    content: variables.content,
    generatedDefaultContent: guideQueryState.data.generatedDefaultContent,
  }),
);
const resetSetGlobalGuideMock = vi.fn();

vi.mock(
  "@/hooks/agent/use-agent-selection-guide-global-onboarding-draft-query",
  () => ({
    useAgentSelectionGuideGlobalOnboardingDraftQuery: () => guideQueryState,
  }),
);

vi.mock("@/hooks/agent/use-agent-selection-guide-set-global-mutation", () => ({
  useAgentSelectionGuideSetGlobalMutation: () => ({
    isError: false,
    isPending: false,
    mutateAsync: setGlobalGuideMock,
    reset: resetSetGlobalGuideMock,
  }),
}));

// Only the SINGLETON is replaced. `AnalyticsEvent` stays the real enum, so a
// swipe is pinned to the member the buttons actually emit rather than to a
// literal this file invented.
const trackSpy = vi.hoisted(() =>
  vi.fn<(event: string, properties: unknown) => void>(),
);

vi.mock("@/lib/analytics", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/analytics")>();
  return { ...actual, Analytics: { getInstance: () => ({ track: trackSpy }) } };
});

const navigateMock = vi.fn();
const historyBackMock = vi.fn();

vi.mock("@tanstack/react-router", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@tanstack/react-router")>();
  return {
    ...actual,
    useNavigate: () => navigateMock,
    useRouter: () => ({ history: { length: 1, back: historyBackMock } }),
  };
});

// Zero by default, so every test keeps the recognizer's untouched-insets
// behavior; the edge-zone widening test below is the one that moves it.
let safeAreaInsetsState = { left: 0, right: 0 };

vi.mock("@/lib/safe-area-insets", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/safe-area-insets")>();
  return {
    ...actual,
    readSafeAreaInsets: () => ({
      top: 0,
      right: safeAreaInsetsState.right,
      bottom: 0,
      left: safeAreaInsetsState.left,
    }),
  };
});

// Import after mocks are registered.
import { OnboardingPage } from "@/components/onboarding/onboarding-page";

function renderPage() {
  return render(
    <LazyMotion features={domAnimation}>
      <OnboardingPage replay={false} />
    </LazyMotion>,
  );
}

/** Which act is on screen, read from its rendered title. */
function currentStage(): number {
  return onboardingActsFor(false).findIndex(
    (act) =>
      screen.queryByText(act.title.replace(/\s+/g, " "), { exact: false }) !==
      null,
  );
}

async function advanceToStage(stage: number): Promise<void> {
  for (let index = currentStage(); index < stage; index++) {
    fireEvent.click(screen.getByTestId("onboarding-advance"));
    await waitFor(() => {
      expect(currentStage()).toBe(index + 1);
    });
  }
}

function phoneScene(): string | null {
  return screen
    .getByTestId("onboarding-phone-diorama-stub")
    .getAttribute("data-scene");
}

interface PointerPosition {
  readonly clientX: number;
  readonly clientY: number;
}

/**
 * jsdom has no usable `PointerEvent` constructor, so - the same trick the
 * shell's gesture suites use - a plain `Event` wearing exactly the fields the
 * recognizer reads.
 */
function dispatchPointer(
  target: EventTarget,
  type: "pointerdown" | "pointermove" | "pointerup",
  position: PointerPosition,
): void {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, "clientX", {
    value: position.clientX,
    configurable: true,
  });
  Object.defineProperty(event, "clientY", {
    value: position.clientY,
    configurable: true,
  });
  Object.defineProperty(event, "pointerId", { value: 1, configurable: true });
  Object.defineProperty(event, "isPrimary", {
    value: true,
    configurable: true,
  });
  target.dispatchEvent(event);
}

/**
 * A whole drag: down on `target`, a move at the halfway point, then the release.
 * The intermediate move matters - the vertical guard is judged while the drag
 * is happening, not from where it finished.
 */
function drag(
  target: EventTarget,
  from: PointerPosition,
  to: PointerPosition,
): void {
  act(() => {
    dispatchPointer(target, "pointerdown", from);
    dispatchPointer(window, "pointermove", {
      clientX: (from.clientX + to.clientX) / 2,
      clientY: (from.clientY + to.clientY) / 2,
    });
    dispatchPointer(window, "pointermove", to);
    dispatchPointer(window, "pointerup", to);
  });
}

/** The stage content the tour's swipe surface wraps. */
function stage(container: HTMLElement): HTMLElement {
  const content = container.querySelector(".onboarding-stage-content");
  if (!(content instanceof HTMLElement)) {
    throw new Error("the stage never rendered");
  }
  return content;
}

describe("OnboardingPage on the installed mobile app", () => {
  beforeEach(() => {
    setMobileApp(true);
    useOnboardingStore.setState({ completedAt: null, step: 0 });
    navigateMock.mockReset();
    historyBackMock.mockReset();
    setGlobalGuideMock.mockClear();
    resetSetGlobalGuideMock.mockClear();
    trackSpy.mockClear();
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
    setMobileApp(false);
    useOnboardingStore.setState({ completedAt: null, step: 0 });
  });

  it("opens on the drawer act with the phone miniature, never the desktop one", () => {
    renderPage();

    expect(
      screen.getByText("Your work lives in Tasks", { exact: false }),
    ).not.toBeNull();
    expect(phoneScene()).toBe("drawer");
    expect(screen.queryByTestId("onboarding-diorama-stub")).toBeNull();
  });

  it("gives each mobile act its phone scene, and the setup acts no miniature at all", async () => {
    renderPage();

    expect(phoneScene()).toBe("drawer");

    await advanceToStage(1);
    expect(phoneScene()).toBe("switcher");

    // The shared handoff act keeps its id and copy, and replays the story down
    // a single phone column.
    await advanceToStage(2);
    expect(phoneScene()).toBe("story");

    await advanceToStage(3);
    expect(screen.queryByTestId("onboarding-phone-diorama-stub")).toBeNull();
    expect(screen.getByTestId("detected-agents-stub")).not.toBeNull();

    // Delegation closes the tour: no miniature, and the advance control is
    // already the finishing one.
    await advanceToStage(4);
    expect(screen.queryByTestId("onboarding-phone-diorama-stub")).toBeNull();
    expect(screen.queryByTestId("onboarding-diorama-stub")).toBeNull();
    expect(screen.getByTestId("onboarding-advance").textContent).toContain(
      "Start building",
    );
  });

  it("puts the agent-guide editor in the copy rail and stretches the stage for it", async () => {
    const { container } = renderPage();

    await advanceToStage(4);

    const input = screen.getByTestId("mock-agent-guide-input");
    expect(input.closest(".onboarding-copy-rail")).not.toBeNull();
    const stage = container.querySelector(".onboarding-stage-content");
    expect(stage?.classList.contains("onboarding-stage-content--solo")).toBe(
      true,
    );
    expect(
      stage?.classList.contains("onboarding-stage-content--no-miniature"),
    ).toBe(true);
  });

  it("saves a guide edited in the copy rail through the page's existing plumbing", async () => {
    renderPage();

    await advanceToStage(4);

    fireEvent.change(screen.getByTestId("mock-agent-guide-input"), {
      target: { value: "guide typed on a phone" },
    });
    // The guide act is the tour's last, so the same press saves and finishes.
    fireEvent.click(screen.getByTestId("onboarding-advance"));

    await waitFor(() => {
      expect(setGlobalGuideMock).toHaveBeenCalledWith({
        content: "guide typed on a phone",
      });
    });
    await waitFor(() => {
      expect(useOnboardingStore.getState().completedAt).not.toBeNull();
    });
    expect(navigateMock).toHaveBeenCalledWith({
      to: "/draft/new",
      replace: true,
    });
  });

  it("walks all six acts before offering the finish label", async () => {
    renderPage();

    const lastActIndex = onboardingActsFor(false).length - 1;
    for (let index = 0; index < lastActIndex; index++) {
      expect(screen.getByTestId("onboarding-advance").textContent).toContain(
        "Continue",
      );
      fireEvent.click(screen.getByTestId("onboarding-advance"));
      await waitFor(() => {
        expect(currentStage()).toBe(index + 1);
      });
    }

    expect(screen.getByTestId("onboarding-advance").textContent).toContain(
      "Start building",
    );
  });

  it("raises the tour's controls to a thumb-sized target", async () => {
    renderPage();

    const skip = screen.getByTestId("onboarding-skip");
    const advance = screen.getByTestId("onboarding-advance");
    expect(skip.classList.contains("h-11")).toBe(true);
    expect(skip.classList.contains("h-9")).toBe(false);
    expect(advance.classList.contains("h-11")).toBe(true);
    // The tall-viewport tier follows, or a phone that clears 920px in portrait
    // would fall back through to the desktop's 40px bump.
    expect(advance.classList.contains("[@media(min-height:920px)]:h-11")).toBe(
      true,
    );
    expect(advance.classList.contains("[@media(min-height:920px)]:h-10")).toBe(
      false,
    );

    await advanceToStage(1);
    const back = screen.getByText("Back").closest("button");
    expect(back?.classList.contains("h-11")).toBe(true);
  });
});

describe("swiping between acts on the installed mobile app", () => {
  beforeEach(() => {
    setMobileApp(true);
    useOnboardingStore.setState({ completedAt: null, step: 0 });
    navigateMock.mockReset();
    trackSpy.mockClear();
    setGlobalGuideMock.mockClear();
    safeAreaInsetsState = { left: 0, right: 0 };
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
    setMobileApp(false);
    useOnboardingStore.setState({ completedAt: null, step: 0 });
  });

  it("advances on a swipe left, emitting the Continue button's own event", async () => {
    const { container } = renderPage();

    drag(
      stage(container),
      { clientX: 400, clientY: 300 },
      { clientX: 280, clientY: 306 },
    );

    await waitFor(() => {
      expect(currentStage()).toBe(1);
    });
    expect(trackSpy).toHaveBeenCalledWith(AnalyticsEvent.OnboardingNavigated, {
      direction: "continue",
      step: "mobile-switcher",
    });
  });

  it("retreats on a swipe right, emitting the Back button's own event", async () => {
    const { container } = renderPage();

    await advanceToStage(1);
    trackSpy.mockClear();
    drag(
      stage(container),
      { clientX: 280, clientY: 300 },
      { clientX: 400, clientY: 306 },
    );

    await waitFor(() => {
      expect(currentStage()).toBe(0);
    });
    expect(trackSpy).toHaveBeenCalledWith(AnalyticsEvent.OnboardingNavigated, {
      direction: "back",
      step: "mobile-tasks",
    });
  });

  it("leaves a vertical drag to whatever is scrolling under it", () => {
    const { container } = renderPage();

    drag(
      stage(container),
      { clientX: 400, clientY: 300 },
      { clientX: 400, clientY: 460 },
    );

    expect(currentStage()).toBe(0);
    expect(trackSpy).not.toHaveBeenCalledWith(
      AnalyticsEvent.OnboardingNavigated,
      expect.anything(),
    );
  });

  it("leaves a diagonal the vertical axis dominates to the scroller too", () => {
    const { container } = renderPage();

    drag(
      stage(container),
      { clientX: 400, clientY: 300 },
      { clientX: 280, clientY: 460 },
    );

    expect(currentStage()).toBe(0);
  });

  it("ignores a drag too short to be a swipe", () => {
    const { container } = renderPage();

    drag(
      stage(container),
      { clientX: 400, clientY: 300 },
      { clientX: 360, clientY: 300 },
    );

    expect(currentStage()).toBe(0);
  });

  it("does not take a swipe out of the agent-guide editor", async () => {
    renderPage();

    await advanceToStage(4);
    drag(
      screen.getByTestId("mock-agent-guide-input"),
      { clientX: 400, clientY: 300 },
      { clientX: 280, clientY: 300 },
    );

    expect(currentStage()).toBe(4);
  });

  it("does not take a swipe out of the editor's contenteditable surface", async () => {
    renderPage();

    await advanceToStage(4);
    drag(
      screen.getByTestId("mock-agent-guide-contenteditable"),
      { clientX: 400, clientY: 300 },
      { clientX: 280, clientY: 300 },
    );

    expect(currentStage()).toBe(4);
  });

  it("does not take a swipe off a control", () => {
    renderPage();

    drag(
      screen.getByTestId("onboarding-advance"),
      { clientX: 400, clientY: 300 },
      { clientX: 280, clientY: 300 },
    );

    expect(currentStage()).toBe(0);
  });

  it("yields the screen edges to the platform's own navigation swipes", async () => {
    const { container } = renderPage();

    // Leading edge, dragging inward - the app shell's back gesture.
    drag(
      stage(container),
      { clientX: 16, clientY: 300 },
      { clientX: 200, clientY: 300 },
    );
    expect(currentStage()).toBe(0);

    // Trailing edge of jsdom's 1024px viewport, dragging inward.
    drag(
      stage(container),
      { clientX: window.innerWidth - 14, clientY: 300 },
      { clientX: 800, clientY: 300 },
    );
    expect(currentStage()).toBe(0);

    // The same gesture one step in from the strip is the tour's.
    drag(
      stage(container),
      { clientX: 400, clientY: 300 },
      { clientX: 280, clientY: 300 },
    );
    await waitFor(() => {
      expect(currentStage()).toBe(1);
    });
  });

  it("widens the edge-navigation strip by a nonzero safe-area inset", async () => {
    const { container } = renderPage();
    safeAreaInsetsState = { left: 20, right: 20 };

    // Inside the widened zone (20px inset + 32px strip = 52px) - still the
    // platform's own swipe, even though it would clear the bare 32px strip.
    drag(
      stage(container),
      { clientX: 40, clientY: 300 },
      { clientX: 40 - 140, clientY: 306 },
    );
    expect(currentStage()).toBe(0);

    // Clear of the widened zone - the tour's own swipe.
    drag(
      stage(container),
      { clientX: 60, clientY: 300 },
      { clientX: 60 - 140, clientY: 306 },
    );
    await waitFor(() => {
      expect(currentStage()).toBe(1);
    });
  });

  it("finishes the tour on a swipe left from the final act", async () => {
    const { container } = renderPage();

    await advanceToStage(onboardingActsFor(false).length - 1);
    setGlobalGuideMock.mockClear();

    drag(
      stage(container),
      { clientX: 400, clientY: 300 },
      { clientX: 280, clientY: 306 },
    );

    await waitFor(() => {
      expect(setGlobalGuideMock).toHaveBeenCalledWith({
        content: "saved guide",
      });
    });
    await waitFor(() => {
      expect(useOnboardingStore.getState().completedAt).not.toBeNull();
    });
    expect(navigateMock).toHaveBeenCalledWith({
      to: "/draft/new",
      replace: true,
    });
  });
});

describe("the desktop tour", () => {
  beforeEach(() => {
    setMobileApp(false);
    useOnboardingStore.setState({ completedAt: null, step: 0 });
    trackSpy.mockClear();
  });

  afterEach(() => {
    cleanup();
    useOnboardingStore.setState({ completedAt: null, step: 0 });
  });

  it("answers no swipe and keeps its own control heights", () => {
    const { container } = renderPage();

    drag(
      stage(container),
      { clientX: 400, clientY: 300 },
      { clientX: 280, clientY: 300 },
    );

    expect(currentStage()).toBe(0);
    const advance = screen.getByTestId("onboarding-advance");
    expect(advance.classList.contains("h-9")).toBe(true);
    expect(advance.classList.contains("h-11")).toBe(false);
    expect(advance.classList.contains("[@media(min-height:920px)]:h-10")).toBe(
      true,
    );
  });
});
