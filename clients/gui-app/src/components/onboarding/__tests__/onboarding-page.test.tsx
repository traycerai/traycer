import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { useOnboardingStore } from "@/stores/onboarding/onboarding-store";
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
import type { StreamRuntimeBinding } from "@/lib/host/stream-runtime-context";
import { setMobileApp } from "@/lib/mobile-app";
import { useSessionImportRunStore } from "@/stores/session-import/session-import-run-store";
import type { OpenLink } from "@/lib/links/open-link";
import { useFirstTaskGuideStore } from "@/stores/onboarding/first-task-guide-store";
import { useFeatureAnnouncementsStore } from "@/stores/settings/feature-announcements-store";

const FEATURE_ANNOUNCEMENTS_STORAGE_KEY =
  "traycer-gui-app:feature-announcements";

function resetFeatureAnnouncementsStore(): void {
  window.localStorage.removeItem(FEATURE_ANNOUNCEMENTS_STORAGE_KEY);
  useFeatureAnnouncementsStore.setState({ consumed: {} });
}

const hostsMock = vi.hoisted(() => ({ ids: ["host-a"] as readonly string[] }));
const capabilityMock = vi.hoisted(() => ({ available: true }));
const scanMock = vi.hoisted(() => ({ activeCalls: [] as boolean[] }));
const safeAreaInsetsMock = vi.hoisted(() => ({ left: 0, right: 0 }));
const openLinkMock = vi.hoisted(() => vi.fn<OpenLink>(() => Promise.resolve()));
const prefetchMock = vi.hoisted(() => ({ renders: 0 }));
const hostReadinessMock = vi.hoisted(() => ({
  streamMismatchFor: null as string | null,
  unsupportedImportFor: null as string | null,
}));

const scrollToDescriptor = Object.getOwnPropertyDescriptor(
  HTMLElement.prototype,
  "scrollTo",
);

function stubElementScrollTo(): void {
  Object.defineProperty(HTMLElement.prototype, "scrollTo", {
    configurable: true,
    value: vi.fn(),
  });
}

function restoreElementScrollTo(): void {
  if (scrollToDescriptor === undefined) {
    Reflect.deleteProperty(HTMLElement.prototype, "scrollTo");
  } else {
    Object.defineProperty(
      HTMLElement.prototype,
      "scrollTo",
      scrollToDescriptor,
    );
  }
}

vi.mock("@/components/auth/cinematic-backdrop", () => ({
  BrandMark: () => <span aria-hidden="true" />,
}));

vi.mock("@/components/onboarding/onboarding-workspace-illustration", () => ({
  OnboardingWorkspaceIllustration: () => (
    <div data-testid="workspace-illustration" />
  ),
}));

vi.mock("@/components/onboarding/onboarding-provider-discovery", () => ({
  OnboardingProviderPrefetch: () => {
    prefetchMock.renders += 1;
    return <div data-testid="provider-prefetch" />;
  },
}));

vi.mock("@/components/onboarding/onboarding-detected-agents", async () => {
  const { useStreamHostId } = await import("@/lib/host/stream-runtime-context");
  return {
    OnboardingDetectedAgents: () => {
      const hostId = useStreamHostId();
      return (
        <div data-testid="detected-agents-stub" data-host-id={hostId ?? ""}>
          <div
            data-testid="provider-editor"
            contentEditable
            suppressContentEditableWarning
          />
        </div>
      );
    },
  };
});

vi.mock("@/components/onboarding/onboarding-host-picker", () => ({
  OnboardingHostPickerBar: (props: {
    readonly picker: {
      readonly scope: HostScope;
      readonly onSelectHost: (hostId: string) => void;
    };
  }) => (
    <div
      data-testid="onboarding-host-picker-bar"
      data-host-id={props.picker.scope.hostId ?? ""}
    >
      {props.picker.scope.hosts.map((host) => (
        <button
          key={host.hostId}
          type="button"
          data-testid={`settings-host-switcher-option-${host.hostId}`}
          onClick={() => props.picker.onSelectHost(host.hostId)}
        >
          {host.name}
        </button>
      ))}
    </div>
  ),
  OnboardingHostUnavailableNotice: (props: {
    readonly refusal: string | null;
  }) => (
    <div data-testid="host-unavailable" data-refusal={props.refusal ?? ""} />
  ),
}));

vi.mock("@/components/session-import/session-import-wizard", async () => {
  const { useStreamHostId } = await import("@/lib/host/stream-runtime-context");
  return {
    SessionImportWizard: () => {
      const hostId = useStreamHostId();
      return (
        <div
          data-testid="session-import-wizard"
          data-stream-host={hostId ?? ""}
        />
      );
    },
  };
});

vi.mock("@/components/session-import/use-session-import-scan", () => ({
  useSessionImportScan: (active: boolean) => {
    scanMock.activeCalls.push(active);
    return { state: { kind: "scan-stub" }, dispatch: () => undefined };
  },
}));

vi.mock("@/hooks/session-import/use-session-import-available", () => ({
  useSessionImportAvailable: () => capabilityMock.available,
  useSessionImportAvailableFor: (
    client: IHostStreamClient<HostStreamRpcRegistry> | null,
  ) =>
    client === null ||
    client.instanceId !==
      `onboarding-test:${hostReadinessMock.unsupportedImportFor}`,
}));

vi.mock("@/components/settings/host-scope/use-scoped-host-binding", () => ({
  useScopedHostBinding: () => null,
}));

vi.mock("@/components/settings/host-scope/use-scoped-stream-binding", () => ({
  useScopedStreamBinding: (scope: HostScope) =>
    scope.isViewingActive || scope.hostId === null
      ? null
      : streamBindingFor(
          scope.hostId === hostReadinessMock.streamMismatchFor
            ? "host-a"
            : scope.hostId,
        ),
}));

vi.mock(
  "@/components/settings/host-scope/use-host-scope",
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import("@/components/settings/host-scope/use-host-scope")
    >()),
    useHostScopeFor: (selection: HostScopeSelection) => tourScope(selection),
  }),
);

const navigateMock = vi.fn();
const historyBackMock = vi.fn();
vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  useNavigate: () => navigateMock,
  useRouter: () => ({ history: { back: historyBackMock } }),
}));

vi.mock("@/lib/links/open-link", () => ({
  useOpenLink: () => openLinkMock,
}));

vi.mock("@/lib/safe-area-insets", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/safe-area-insets")>()),
  readSafeAreaInsets: () => ({
    top: 0,
    right: safeAreaInsetsMock.right,
    bottom: 0,
    left: safeAreaInsetsMock.left,
  }),
}));

import { OnboardingPage } from "@/components/onboarding/onboarding-page";

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

const streamBindings = new Map<string, StreamRuntimeBinding>();

function streamBindingFor(hostId: string): StreamRuntimeBinding {
  const existing = streamBindings.get(hostId);
  if (existing !== undefined) return existing;
  const binding: StreamRuntimeBinding = {
    wsStreamClient: fakeWsStreamClient(hostId),
    hostId,
    retain: null,
  };
  streamBindings.set(hostId, binding);
  return binding;
}

function fakeWsStreamClient(
  hostId: string,
): IHostStreamClient<HostStreamRpcRegistry> {
  return {
    subscribe: () => {
      throw new Error("not exercised by this test");
    },
    subscribeWithParamsProvider: () => {
      throw new Error("not exercised by this test");
    },
    close: () => undefined,
    isClosed: () => false,
    isReady: () => true,
    notifyBearerRotated: () => undefined,
    notifyCloudVerdictChanged: () => undefined,
    reconnectAll: () => undefined,
    getMethodSupport: () => "unknown",
    subscribeMethodSupport: () => () => undefined,
    getMethodSchemaVersion: () => null,
    subscribeAvailabilityRecovered: () => () => undefined,
    getClosedReason: () => null,
    onClosed: () => () => undefined,
    instanceId: `onboarding-test:${hostId}`,
  };
}

function renderPage(replay: boolean) {
  vi.useFakeTimers();
  try {
    const view = render(<OnboardingPage replay={replay} />);
    const skipWelcome = screen.queryByTestId("onboarding-welcome-skip");
    if (skipWelcome !== null) {
      fireEvent.click(skipWelcome);
      void act(() => vi.advanceTimersByTime(320));
    }
    return view;
  } finally {
    vi.useRealTimers();
  }
}

function currentStepId(): string | null {
  return screen.getByTestId("onboarding-step").getAttribute("data-step-id");
}

async function advanceToStep(stepId: string): Promise<void> {
  const stepIds = capabilityMock.available
    ? ["task-tabs", "providers", "session-import"]
    : ["task-tabs", "providers"];
  const target = stepIds.indexOf(stepId);
  for (
    let index = stepIds.indexOf(currentStepId() ?? "");
    index < target;
    index++
  ) {
    fireEvent.click(screen.getByTestId("onboarding-advance"));
    await waitFor(() => expect(currentStepId()).toBe(stepIds[index + 1]));
  }
}

interface PointerPosition {
  readonly clientX: number;
  readonly clientY: number;
}

/**
 * The tracked drag reads `timeStamp` to get a release speed, so every synthetic
 * pointer carries one: without it three events constructed in the same tick
 * look like an infinitely fast flick, and the distance arm - the one most of
 * these cases are about - is never reached.
 */
function dispatchPointer(
  target: EventTarget,
  type: "pointerdown" | "pointermove" | "pointerup",
  position: PointerPosition,
  atMs: number,
): void {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperties(event, {
    clientX: { value: position.clientX },
    clientY: { value: position.clientY },
    pointerId: { value: 1 },
    isPrimary: { value: true },
    timeStamp: { value: atMs },
  });
  target.dispatchEvent(event);
}

/** A deliberate drag: 300ms of travel, which is well under the flick speed. */
function drag(
  target: EventTarget,
  from: PointerPosition,
  to: PointerPosition,
): void {
  act(() => {
    dispatchPointer(target, "pointerdown", from, 0);
    dispatchPointer(window, "pointermove", to, 300);
    dispatchPointer(window, "pointerup", to, 300);
  });
}

/** A flick: the same travel spent in 40ms, so the speed arm decides. */
function flick(
  target: EventTarget,
  from: PointerPosition,
  to: PointerPosition,
): void {
  act(() => {
    dispatchPointer(target, "pointerdown", from, 0);
    dispatchPointer(window, "pointermove", to, 40);
    dispatchPointer(window, "pointerup", to, 40);
  });
}

function onboardingTourLayer(): HTMLElement {
  const layer = screen.getByTestId("onboarding-step").closest("[aria-hidden]");
  if (!(layer instanceof HTMLElement)) {
    throw new Error("Expected the onboarding tour layer.");
  }
  return layer;
}

function swipeSurface(container: HTMLElement): HTMLElement {
  const surface = container.querySelector(".onboarding-stage-scroll");
  if (!(surface instanceof HTMLElement)) throw new Error("stage is missing");
  return surface;
}

const DESKTOP_VIEWPORT_WIDTH = window.innerWidth;

/**
 * The phone layout is keyed to the VIEWPORT (`useIsMobileViewport`, 768px), not
 * to the installed app, so a width is all these suites have to set. The global
 * `matchMedia` stub never fires a change, which is exactly right here: the
 * snapshot is read at render and the width is fixed for the test.
 */
function setViewportWidth(width: number): void {
  Object.defineProperty(window, "innerWidth", {
    configurable: true,
    writable: true,
    value: width,
  });
}

describe("OnboardingPage", () => {
  beforeEach(() => {
    stubElementScrollTo();
    setViewportWidth(DESKTOP_VIEWPORT_WIDTH);
    resetFeatureAnnouncementsStore();
    useOnboardingStore.setState({ completedAt: null, step: 0 });
    useSessionImportRunStore.setState({ runs: new Map() });
    useFirstTaskGuideStore.setState({
      status: "inactive",
      imports: new Map(),
      workspaceReviewed: false,
    });
    setMobileApp(false);
    capabilityMock.available = true;
    hostsMock.ids = ["host-a"];
    prefetchMock.renders = 0;
    hostReadinessMock.streamMismatchFor = null;
    hostReadinessMock.unsupportedImportFor = null;
    scanMock.activeCalls.length = 0;
    safeAreaInsetsMock.left = 0;
    safeAreaInsetsMock.right = 0;
    openLinkMock.mockReset();
    navigateMock.mockReset();
    historyBackMock.mockReset();
  });

  afterEach(() => {
    cleanup();
    restoreElementScrollTo();
    resetFeatureAnnouncementsStore();
    useOnboardingStore.setState({ completedAt: null, step: 0 });
    useSessionImportRunStore.setState({ runs: new Map() });
    setMobileApp(false);
  });

  it("shows the fixed three-step desktop flow and advances by step id", async () => {
    renderPage(false);

    expect(currentStepId()).toBe("task-tabs");
    expect(
      screen.getByRole("heading", { name: /A home for\s+all your work\./ }),
    ).toBeTruthy();
    expect(screen.getByTestId("workspace-illustration")).toBeTruthy();
    expect(scanMock.activeCalls.at(-1)).toBe(true);
    expect(screen.getByTestId("provider-prefetch")).toBeTruthy();

    await advanceToStep("providers");
    expect(screen.getByTestId("detected-agents-stub")).toBeTruthy();
    expect(screen.queryByTestId("provider-prefetch")).toBeNull();

    await advanceToStep("session-import");
    expect(screen.getByTestId("onboarding-session-import-stage")).toBeTruthy();
    expect(screen.getByTestId("session-import-wizard")).toBeTruthy();
    expect(screen.getByTestId("provider-prefetch")).toBeTruthy();

    fireEvent.click(screen.getByTestId("onboarding-advance"));
    expect(useOnboardingStore.getState().completedAt).toEqual(
      expect.any(Number),
    );
    expect(useFirstTaskGuideStore.getState().status).toBe("active");
    expect(navigateMock).toHaveBeenCalledWith({
      to: "/draft/new",
      replace: true,
    });
  });

  // The desktop shell is not what the phone rework changed, and this is the
  // guard that says so: the eyebrow, the wordmark and a footer Back are all
  // things the phone branch removes, and all three still belong here.
  it("keeps the desktop shell: the eyebrow, the wordmark, and Back in the footer", async () => {
    const { container } = renderPage(false);

    expect(container.querySelector(".onboarding-eyebrow")?.textContent).toBe(
      "Workspace · 1 of 3",
    );
    expect(container.querySelector(".onboarding-wordmark")).not.toBeNull();
    expect(screen.getByTestId("onboarding-skip").textContent).toBe(
      "Skip intro",
    );
    expect(screen.getByTestId("onboarding-advance").className).not.toContain(
      "onboarding-button--block",
    );

    await advanceToStep("providers");

    const back = screen.getByTestId("onboarding-back");
    expect(back.closest("footer")).not.toBeNull();
    expect(back.closest("header")).toBeNull();
    expect(back.textContent).toBe("Back");
  });

  it("shows the welcome first, prefetches provider data, then reveals the tour after both transitions", () => {
    vi.useFakeTimers();
    try {
      render(<OnboardingPage replay={false} />);

      expect(screen.getByTestId("onboarding-welcome-skip")).toBeTruthy();
      expect(onboardingTourLayer().getAttribute("aria-hidden")).toBe("true");
      expect(onboardingTourLayer().hasAttribute("inert")).toBe(true);
      expect(screen.getByTestId("provider-prefetch")).toBeTruthy();
      expect(prefetchMock.renders).toBeGreaterThan(0);
      expect(scanMock.activeCalls.at(-1)).toBe(true);

      void act(() => vi.advanceTimersByTime(1799));
      expect(screen.getByTestId("onboarding-welcome-skip")).toBeTruthy();
      expect(onboardingTourLayer().getAttribute("aria-hidden")).toBe("true");

      void act(() => vi.advanceTimersByTime(1));
      const welcome = screen
        .getByTestId("onboarding-welcome-skip")
        .closest("section");
      expect(welcome?.getAttribute("data-leaving")).toBe("true");
      expect(onboardingTourLayer().getAttribute("aria-hidden")).toBe("true");

      void act(() => vi.advanceTimersByTime(319));
      expect(onboardingTourLayer().getAttribute("aria-hidden")).toBe("true");
      void act(() => vi.advanceTimersByTime(1));

      expect(screen.queryByTestId("onboarding-welcome-skip")).toBeNull();
      expect(onboardingTourLayer().getAttribute("aria-hidden")).not.toBe(
        "true",
      );
      expect(currentStepId()).toBe("task-tabs");
    } finally {
      vi.useRealTimers();
    }
  });

  it("lets Skip welcome bypass the hold without skipping the onboarding steps", () => {
    vi.useFakeTimers();
    try {
      render(<OnboardingPage replay={false} />);
      fireEvent.click(screen.getByTestId("onboarding-welcome-skip"));

      expect(onboardingTourLayer().getAttribute("aria-hidden")).toBe("true");
      expect(useOnboardingStore.getState().completedAt).toBeNull();
      expect(navigateMock).not.toHaveBeenCalled();

      void act(() => vi.advanceTimersByTime(320));
      expect(onboardingTourLayer().getAttribute("aria-hidden")).not.toBe(
        "true",
      );
      expect(currentStepId()).toBe("task-tabs");
    } finally {
      vi.useRealTimers();
    }
  });

  it("uses the short welcome and leave timings when reduced motion is preferred", () => {
    // Enough of a MediaQueryList for every reader on this screen: the welcome's
    // own timings read `matches`, and `useIsMobileViewport` subscribes.
    vi.stubGlobal("matchMedia", () => ({
      matches: true,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    }));
    vi.useFakeTimers();
    try {
      render(<OnboardingPage replay={false} />);

      void act(() => vi.advanceTimersByTime(299));
      expect(screen.getByTestId("onboarding-welcome-skip")).toBeTruthy();
      void act(() => vi.advanceTimersByTime(1));
      expect(
        screen
          .getByTestId("onboarding-welcome-skip")
          .closest("section")
          ?.getAttribute("data-leaving"),
      ).toBe("true");

      void act(() => vi.advanceTimersByTime(149));
      expect(onboardingTourLayer().getAttribute("aria-hidden")).toBe("true");
      void act(() => vi.advanceTimersByTime(1));
      expect(onboardingTourLayer().getAttribute("aria-hidden")).not.toBe(
        "true",
      );
    } finally {
      vi.useRealTimers();
      vi.unstubAllGlobals();
    }
  });

  it("omits session import and its scan when the host does not support it", async () => {
    capabilityMock.available = false;
    renderPage(false);

    await advanceToStep("providers");
    expect(screen.queryByTestId("onboarding-session-import-stage")).toBeNull();
    expect(scanMock.activeCalls.at(-1)).toBe(false);

    fireEvent.click(screen.getByTestId("onboarding-advance"));

    expect(useOnboardingStore.getState().completedAt).toEqual(
      expect.any(Number),
    );
    expect(navigateMock).toHaveBeenCalledWith({
      to: "/draft/new",
      replace: true,
    });
  });

  it("finishes a replay by returning to history without navigating to a new draft", () => {
    renderPage(true);
    fireEvent.click(screen.getByTestId("onboarding-skip"));

    expect(useOnboardingStore.getState().completedAt).toEqual(
      expect.any(Number),
    );
    expect(historyBackMock).toHaveBeenCalledOnce();
    expect(navigateMock).not.toHaveBeenCalled();
    expect(useFirstTaskGuideStore.getState().status).toBe("inactive");
  });

  it("consumes the login import announcement when first-run onboarding mounts", () => {
    renderPage(false);

    expect(
      useFeatureAnnouncementsStore.getState().consumed["login-import"],
    ).toEqual(expect.any(Number));
    expect(useFeatureAnnouncementsStore.getState().claim("login-import")).toBe(
      false,
    );
  });

  it("does not consume the login import announcement when onboarding is replayed", () => {
    renderPage(true);

    expect(
      useFeatureAnnouncementsStore.getState().consumed["login-import"],
    ).toBeUndefined();
  });

  it("dismisses the first-task guide when first-run onboarding is skipped", () => {
    renderPage(false);
    fireEvent.click(screen.getByTestId("onboarding-skip"));

    expect(useFirstTaskGuideStore.getState().status).toBe("finished");
  });

  it("does not activate the guide when replay onboarding completes", async () => {
    renderPage(true);
    await advanceToStep("session-import");
    fireEvent.click(screen.getByTestId("onboarding-advance"));

    expect(historyBackMock).toHaveBeenCalledOnce();
    expect(useFirstTaskGuideStore.getState().status).toBe("inactive");
  });

  it("starts every replay from the first step without clearing completion", () => {
    useOnboardingStore.setState({ completedAt: 123, step: 2 });
    renderPage(true);

    expect(currentStepId()).toBe("task-tabs");
    expect(useOnboardingStore.getState()).toMatchObject({
      completedAt: 123,
      step: 0,
    });
  });

  it("keeps the provider and import screens on the host selected in the provider screen", async () => {
    hostsMock.ids = ["host-a", "host-b"];
    renderPage(false);
    await advanceToStep("providers");

    fireEvent.click(screen.getByTestId("settings-host-switcher-option-host-b"));
    await waitFor(() => {
      expect(
        screen.getByTestId("detected-agents-stub").getAttribute("data-host-id"),
      ).toBe("host-b");
    });

    await advanceToStep("session-import");
    expect(
      screen
        .getByTestId("session-import-wizard")
        .getAttribute("data-stream-host"),
    ).toBe("host-b");
  });

  it("withholds host-scoped content while the stream does not match the selected host", async () => {
    hostsMock.ids = ["host-a", "host-b"];
    hostReadinessMock.streamMismatchFor = "host-b";
    renderPage(false);
    await advanceToStep("providers");
    fireEvent.click(screen.getByTestId("settings-host-switcher-option-host-b"));

    expect(screen.getByTestId("host-unavailable")).toBeTruthy();
    expect(screen.queryByTestId("detected-agents-stub")).toBeNull();

    await advanceToStep("session-import");
    expect(screen.queryByTestId("session-import-wizard")).toBeNull();
    expect(
      screen.getByTestId("host-unavailable").getAttribute("data-refusal"),
    ).toBe("");
  });

  it("shows the selected host's import refusal when that host lacks scan support", async () => {
    hostsMock.ids = ["host-a", "host-b"];
    hostReadinessMock.unsupportedImportFor = "host-b";
    renderPage(false);
    await advanceToStep("providers");
    fireEvent.click(screen.getByTestId("settings-host-switcher-option-host-b"));
    await advanceToStep("session-import");

    expect(screen.queryByTestId("session-import-wizard")).toBeNull();
    expect(
      screen.getByTestId("host-unavailable").getAttribute("data-refusal"),
    ).toBe("host-b can't import tasks");
  });

  it("uses arrows, Enter, and Escape for navigation while ignoring controls, editors, and overlays", async () => {
    renderPage(false);
    fireEvent.keyDown(window, { key: "ArrowRight" });
    await waitFor(() => expect(currentStepId()).toBe("providers"));

    const input = document.createElement("input");
    document.body.append(input);
    fireEvent.keyDown(input, { key: "ArrowRight" });
    expect(currentStepId()).toBe("providers");

    fireEvent.keyDown(window, { key: "ArrowLeft" });
    await waitFor(() => expect(currentStepId()).toBe("task-tabs"));
    fireEvent.keyDown(window, { key: "Enter" });
    await waitFor(() => expect(currentStepId()).toBe("providers"));

    fireEvent.keyDown(screen.getByTestId("provider-editor"), {
      key: "ArrowRight",
    });
    expect(currentStepId()).toBe("providers");

    const dialog = document.createElement("div");
    dialog.setAttribute("role", "dialog");
    document.body.append(dialog);
    fireEvent.keyDown(dialog, { key: "ArrowRight" });
    expect(currentStepId()).toBe("providers");

    fireEvent.keyDown(window, { key: "Escape" });
    expect(useOnboardingStore.getState().completedAt).toEqual(
      expect.any(Number),
    );
    expect(navigateMock).toHaveBeenCalledWith({
      to: "/draft/new",
      replace: true,
    });
    input.remove();
    dialog.remove();
  });

  it("skips the tour on Escape from its own controls, and leaves an open picker's Escape alone", () => {
    renderPage(false);

    const picker = document.createElement("div");
    picker.setAttribute("data-slot", "popover-content");
    picker.setAttribute("data-state", "open");
    document.body.append(picker);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(useOnboardingStore.getState().completedAt).toBeNull();
    picker.remove();

    // Escape does what Skip does, and the tour IS the screen - so an Escape
    // aimed at one of its own buttons is still aimed at the tour.
    fireEvent.keyDown(screen.getByTestId("onboarding-skip"), { key: "Escape" });

    expect(useOnboardingStore.getState().completedAt).toEqual(
      expect.any(Number),
    );
    expect(navigateMock).toHaveBeenCalledWith({
      to: "/draft/new",
      replace: true,
    });
  });

  // Input inside an act is not navigation: only the deliberate gestures swap
  // the step, and the block the eye is on is the SAME element afterwards.
  it("keeps the act stable for in-step input", async () => {
    renderPage(false);
    await advanceToStep("providers");

    const currentStep = screen.getByTestId("onboarding-step");
    const editor = screen.getByTestId("provider-editor");

    fireEvent.keyDown(editor, { key: "Tab" });
    expect(screen.getByTestId("onboarding-step")).toBe(currentStep);

    fireEvent.pointerDown(editor);
    fireEvent.click(editor);
    expect(screen.getByTestId("onboarding-step")).toBe(currentStep);

    fireEvent.keyDown(window, { key: "ArrowRight" });
    await waitFor(() => expect(currentStepId()).toBe("session-import"));
  });
});

/**
 * The installed app, which is a PRODUCT branch and not a width: about nine in
 * ten people who open it have already run the tour on the desktop app, so the
 * acts are dropped there and the welcome hands straight over to the landing
 * guide. Everything here is keyed to `setMobileApp(true)` and nothing to the
 * viewport - the phone-layout suite below is the same width with the flag off,
 * and it still gets all three acts.
 */
describe("OnboardingPage on the installed mobile app", () => {
  beforeEach(() => {
    stubElementScrollTo();
    setViewportWidth(393);
    resetFeatureAnnouncementsStore();
    useOnboardingStore.setState({ completedAt: null, step: 0 });
    useSessionImportRunStore.setState({ runs: new Map() });
    useFirstTaskGuideStore.setState({
      status: "inactive",
      imports: new Map(),
      workspaceReviewed: false,
      acknowledgedHints: new Set(),
    });
    setMobileApp(true);
    capabilityMock.available = true;
    hostsMock.ids = ["host-a"];
    prefetchMock.renders = 0;
    scanMock.activeCalls.length = 0;
    navigateMock.mockReset();
    historyBackMock.mockReset();
  });

  afterEach(() => {
    cleanup();
    restoreElementScrollTo();
    setViewportWidth(DESKTOP_VIEWPORT_WIDTH);
    resetFeatureAnnouncementsStore();
    useOnboardingStore.setState({ completedAt: null, step: 0 });
    useSessionImportRunStore.setState({ runs: new Map() });
    setMobileApp(false);
  });

  it("plays only the welcome, then completes and opens a new draft with the guide armed", () => {
    vi.useFakeTimers();
    try {
      render(<OnboardingPage replay={false} />);

      expect(screen.getByTestId("onboarding-welcome-skip")).toBeTruthy();
      // Not a hidden tour layer - no tour at all. Nothing of the acts exists to
      // flash between the welcome leaving and the draft arriving.
      expect(screen.queryByTestId("onboarding-step")).toBeNull();
      expect(screen.queryByTestId("onboarding-advance")).toBeNull();
      expect(screen.queryByTestId("onboarding-skip")).toBeNull();
      // And none of the acts' work is started either: no provider prefetch, and
      // the session-import scan is never even asked about.
      expect(screen.queryByTestId("provider-prefetch")).toBeNull();
      expect(prefetchMock.renders).toBe(0);
      expect(scanMock.activeCalls).toEqual([]);

      // The desktop's own welcome timings, unchanged.
      void act(() => vi.advanceTimersByTime(1799));
      expect(useOnboardingStore.getState().completedAt).toBeNull();
      void act(() => vi.advanceTimersByTime(1));
      expect(
        screen
          .getByTestId("onboarding-welcome-skip")
          .closest("section")
          ?.getAttribute("data-leaving"),
      ).toBe("true");

      void act(() => vi.advanceTimersByTime(319));
      expect(navigateMock).not.toHaveBeenCalled();
      void act(() => vi.advanceTimersByTime(1));

      expect(screen.queryByTestId("onboarding-step")).toBeNull();
      expect(useOnboardingStore.getState().completedAt).toEqual(
        expect.any(Number),
      );
      expect(useFirstTaskGuideStore.getState().status).toBe("active");
      expect(navigateMock).toHaveBeenCalledWith({
        to: "/draft/new",
        replace: true,
      });
      expect(historyBackMock).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("uses the short welcome and leave timings when reduced motion is preferred", () => {
    vi.stubGlobal("matchMedia", () => ({
      matches: true,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    }));
    vi.useFakeTimers();
    try {
      render(<OnboardingPage replay={false} />);

      void act(() => vi.advanceTimersByTime(300));
      expect(
        screen
          .getByTestId("onboarding-welcome-skip")
          .closest("section")
          ?.getAttribute("data-leaving"),
      ).toBe("true");

      void act(() => vi.advanceTimersByTime(149));
      expect(navigateMock).not.toHaveBeenCalled();
      void act(() => vi.advanceTimersByTime(1));

      expect(navigateMock).toHaveBeenCalledWith({
        to: "/draft/new",
        replace: true,
      });
    } finally {
      vi.useRealTimers();
      vi.unstubAllGlobals();
    }
  });

  // Skipping is not skipping guidance here: the welcome IS the tour on this
  // shell, so the only thing the button shortens is the animation.
  it("gives Skip welcome the same outcome as letting the welcome finish", () => {
    vi.useFakeTimers();
    try {
      render(<OnboardingPage replay={false} />);
      fireEvent.click(screen.getByTestId("onboarding-welcome-skip"));

      expect(useOnboardingStore.getState().completedAt).toBeNull();
      expect(navigateMock).not.toHaveBeenCalled();

      void act(() => vi.advanceTimersByTime(320));

      expect(useOnboardingStore.getState().completedAt).toEqual(
        expect.any(Number),
      );
      expect(useFirstTaskGuideStore.getState().status).toBe("active");
      expect(navigateMock).toHaveBeenCalledWith({
        to: "/draft/new",
        replace: true,
      });
      expect(screen.queryByTestId("onboarding-step")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  // "Replay" has to show the tour again, and on this shell the tour the user
  // would recognise is the landing guide - so the replay re-arms it from
  // scratch and goes to the page it lives on, rather than back to Settings.
  it("re-arms the landing guide on replay and navigates instead of going back", () => {
    useOnboardingStore.setState({ completedAt: 123, step: 0 });
    useFirstTaskGuideStore.setState({
      status: "finished",
      acknowledgedHints: new Set(["tasks-menu"]),
    });
    vi.useFakeTimers();
    try {
      render(<OnboardingPage replay />);
      fireEvent.click(screen.getByTestId("onboarding-welcome-skip"));
      void act(() => vi.advanceTimersByTime(320));

      expect(useFirstTaskGuideStore.getState().status).toBe("active");
      // `prepare()` ran, so last run's acknowledgements are not still retiring
      // the steps this replay is meant to show.
      expect(useFirstTaskGuideStore.getState().acknowledgedHints.size).toBe(0);
      expect(navigateMock).toHaveBeenCalledWith({
        to: "/draft/new",
        replace: true,
      });
      expect(historyBackMock).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  // A replay is not a first run: the announcement it would otherwise consume is
  // still owed to the user, exactly as on the desktop.
  it("consumes the login import announcement on first run only", () => {
    vi.useFakeTimers();
    try {
      render(<OnboardingPage replay={false} />);
      expect(
        useFeatureAnnouncementsStore.getState().consumed["login-import"],
      ).toEqual(expect.any(Number));

      cleanup();
      resetFeatureAnnouncementsStore();
      render(<OnboardingPage replay />);
      expect(
        useFeatureAnnouncementsStore.getState().consumed["login-import"],
      ).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("OnboardingPage phone layout", () => {
  beforeEach(() => {
    stubElementScrollTo();
    setViewportWidth(393);
    useOnboardingStore.setState({ completedAt: null, step: 0 });
    useSessionImportRunStore.setState({ runs: new Map() });
    // Deliberately NOT the installed app: the phone shell, the phone copy and
    // the drag all come from the viewport, so a narrow desktop window gets
    // exactly this layout.
    setMobileApp(false);
    capabilityMock.available = true;
    hostsMock.ids = ["host-a"];
    hostReadinessMock.streamMismatchFor = null;
    hostReadinessMock.unsupportedImportFor = null;
    scanMock.activeCalls.length = 0;
    safeAreaInsetsMock.left = 0;
    safeAreaInsetsMock.right = 0;
    navigateMock.mockReset();
  });

  afterEach(() => {
    cleanup();
    restoreElementScrollTo();
    setViewportWidth(DESKTOP_VIEWPORT_WIDTH);
    useOnboardingStore.setState({ completedAt: null, step: 0 });
    useSessionImportRunStore.setState({ runs: new Map() });
    setMobileApp(false);
    safeAreaInsetsMock.left = 0;
    safeAreaInsetsMock.right = 0;
  });

  it("puts Back in the header past act one, and renders no eyebrow or wordmark", async () => {
    const { container } = renderPage(false);

    // Act 1's leading slot is the brand mark, so there is nothing to go back to.
    expect(screen.queryByTestId("onboarding-back")).toBeNull();
    expect(container.querySelector(".onboarding-eyebrow")).toBeNull();
    expect(container.querySelector(".onboarding-wordmark")).toBeNull();
    expect(screen.getByTestId("onboarding-skip").textContent).toBe("Skip");

    await advanceToStep("providers");

    const back = screen.getByRole("button", { name: "Back" });
    expect(back.getAttribute("data-testid")).toBe("onboarding-back");
    // In the HEADER, not in the footer: the footer is one full-width primary on
    // every act, and a phone's back affordance belongs at the top.
    expect(back.closest("header")).not.toBeNull();
    expect(back.closest("footer")).toBeNull();

    fireEvent.click(back);
    await waitFor(() => expect(currentStepId()).toBe("task-tabs"));
  });

  it("gives act one a subtitle and the later acts none", async () => {
    const { container } = renderPage(false);

    const subtitle = container.querySelector(".onboarding-subtitle");
    expect(subtitle?.textContent).toBe(
      "Tasks in the menu. Swipe for the rest.",
    );

    await advanceToStep("providers");
    expect(container.querySelector(".onboarding-subtitle")).toBeNull();
  });

  it("shows one full-width primary, and hands act three's footer to the wizard", async () => {
    const { container } = renderPage(false);

    const advance = screen.getByTestId("onboarding-advance");
    expect(advance.className).toContain("onboarding-button--block");
    expect(advance.className).toContain("onboarding-button--primary");
    expect(advance.textContent).toContain("Continue");
    expect(container.querySelector("footer")?.dataset.quiet).toBe("false");

    await advanceToStep("session-import");

    // The wizard owns the primary on act 3, so the shell keeps only the quiet
    // way past it - centred, and spelled the same as the header's.
    const footerAction = screen.getByTestId("onboarding-advance");
    expect(footerAction.className).toContain("onboarding-button--quiet");
    expect(footerAction.className).not.toContain("onboarding-button--block");
    // The Enter cap rides along in the DOM (it is CSS-hidden below `md`), so
    // this asks what the label says rather than what the node contains.
    expect(footerAction.textContent).toContain("Skip");
    expect(footerAction.textContent).not.toContain("for now");
    expect(container.querySelector("footer")?.dataset.quiet).toBe("true");
  });

  it("runs the whole step list, leaves vertical drags alone, and navigates on horizontal ones", async () => {
    const { container } = renderPage(false);
    const surface = swipeSurface(container);

    expect(currentStepId()).toBe("task-tabs");
    // The import act is offered on a phone under the same host gate as on the
    // desktop, so its early scan arms there too.
    expect(scanMock.activeCalls.at(-1)).toBe(true);

    drag(
      surface,
      { clientX: 200, clientY: 300 },
      { clientX: 200, clientY: 420 },
    );
    expect(currentStepId()).toBe("task-tabs");

    drag(
      surface,
      { clientX: 280, clientY: 300 },
      { clientX: 160, clientY: 306 },
    );
    await waitFor(() => expect(currentStepId()).toBe("providers"));

    drag(
      surface,
      { clientX: 280, clientY: 300 },
      { clientX: 160, clientY: 306 },
    );
    await waitFor(() => expect(currentStepId()).toBe("session-import"));

    drag(
      surface,
      { clientX: 160, clientY: 300 },
      { clientX: 280, clientY: 306 },
    );
    await waitFor(() => expect(currentStepId()).toBe("providers"));
  });

  it("springs a short drag home and commits a flick that barely travelled", async () => {
    const { container } = renderPage(false);
    const surface = swipeSurface(container);

    // 60px of a 393px surface is under the quarter a slow release has to cover,
    // and 200px/s is under the flick speed.
    drag(
      surface,
      { clientX: 280, clientY: 300 },
      { clientX: 220, clientY: 302 },
    );
    expect(currentStepId()).toBe("task-tabs");

    // The same distance thrown in 40ms is 1500px/s, which commits on its own.
    flick(
      surface,
      { clientX: 280, clientY: 300 },
      { clientX: 220, clientY: 302 },
    );
    await waitFor(() => expect(currentStepId()).toBe("providers"));
  });

  it("resists at the ends instead of leaving the tour", () => {
    const { container } = renderPage(false);
    const surface = swipeSurface(container);

    // Back from the first act: there is nothing behind it, so the act rubber
    // bands and the tour stays where it is.
    drag(
      surface,
      { clientX: 120, clientY: 300 },
      { clientX: 320, clientY: 306 },
    );
    expect(currentStepId()).toBe("task-tabs");
    expect(useOnboardingStore.getState().completedAt).toBeNull();
  });

  it("does not steal swipes from controls or the platform edge zones", async () => {
    const { container } = renderPage(false);
    const surface = swipeSurface(container);

    drag(
      screen.getByTestId("onboarding-advance"),
      { clientX: 280, clientY: 300 },
      { clientX: 160, clientY: 306 },
    );
    expect(currentStepId()).toBe("task-tabs");

    drag(
      surface,
      { clientX: 10, clientY: 300 },
      { clientX: 130, clientY: 306 },
    );
    expect(currentStepId()).toBe("task-tabs");

    await advanceToStep("providers");
    drag(
      screen.getByTestId("provider-editor"),
      { clientX: 280, clientY: 300 },
      { clientX: 160, clientY: 306 },
    );
    expect(currentStepId()).toBe("providers");
  });

  it("widens platform edge zones by the safe-area inset", async () => {
    const { container } = renderPage(false);
    const surface = swipeSurface(container);
    safeAreaInsetsMock.left = 20;
    safeAreaInsetsMock.right = 20;

    drag(
      surface,
      { clientX: window.innerWidth - 10, clientY: 300 },
      { clientX: window.innerWidth - 150, clientY: 306 },
    );
    expect(currentStepId()).toBe("task-tabs");

    drag(
      surface,
      { clientX: 40, clientY: 300 },
      { clientX: 180, clientY: 306 },
    );
    expect(currentStepId()).toBe("task-tabs");

    drag(
      surface,
      { clientX: window.innerWidth - 60, clientY: 300 },
      { clientX: window.innerWidth - 200, clientY: 306 },
    );
    await waitFor(() => expect(currentStepId()).toBe("providers"));
  });
});
