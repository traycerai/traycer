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

function dispatchPointer(
  target: EventTarget,
  type: "pointerdown" | "pointermove" | "pointerup",
  position: PointerPosition,
): void {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperties(event, {
    clientX: { value: position.clientX },
    clientY: { value: position.clientY },
    pointerId: { value: 1 },
    isPrimary: { value: true },
  });
  target.dispatchEvent(event);
}

function drag(
  target: EventTarget,
  from: PointerPosition,
  to: PointerPosition,
): void {
  act(() => {
    dispatchPointer(target, "pointerdown", from);
    dispatchPointer(window, "pointermove", to);
    dispatchPointer(window, "pointerup", to);
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

describe("OnboardingPage", () => {
  beforeEach(() => {
    stubElementScrollTo();
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
    vi.stubGlobal("matchMedia", () => ({ matches: true }));
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
    ).toBe("host-b can't import sessions");
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

describe("OnboardingPage mobile swipe", () => {
  beforeEach(() => {
    stubElementScrollTo();
    useOnboardingStore.setState({ completedAt: null, step: 0 });
    useSessionImportRunStore.setState({ runs: new Map() });
    setMobileApp(true);
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
    useOnboardingStore.setState({ completedAt: null, step: 0 });
    useSessionImportRunStore.setState({ runs: new Map() });
    setMobileApp(false);
    safeAreaInsetsMock.left = 0;
    safeAreaInsetsMock.right = 0;
  });

  it("keeps mobile to two steps, leaves vertical drags alone, and navigates on horizontal swipes", async () => {
    const { container } = renderPage(false);
    const surface = swipeSurface(container);

    expect(currentStepId()).toBe("task-tabs");
    expect(scanMock.activeCalls.at(-1)).toBe(false);

    drag(
      surface,
      { clientX: 400, clientY: 300 },
      { clientX: 400, clientY: 420 },
    );
    expect(currentStepId()).toBe("task-tabs");

    drag(
      surface,
      { clientX: 400, clientY: 300 },
      { clientX: 280, clientY: 306 },
    );
    await waitFor(() => expect(currentStepId()).toBe("providers"));

    drag(
      surface,
      { clientX: 280, clientY: 300 },
      { clientX: 400, clientY: 306 },
    );
    await waitFor(() => expect(currentStepId()).toBe("task-tabs"));
  });

  it("does not steal swipes from controls or the platform edge zones", async () => {
    const { container } = renderPage(false);
    const surface = swipeSurface(container);

    drag(
      screen.getByTestId("onboarding-advance"),
      { clientX: 400, clientY: 300 },
      { clientX: 280, clientY: 306 },
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
      { clientX: 400, clientY: 300 },
      { clientX: 280, clientY: 306 },
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
