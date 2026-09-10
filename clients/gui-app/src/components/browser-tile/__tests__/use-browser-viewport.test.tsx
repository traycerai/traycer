import "../../../../__tests__/test-browser-apis";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type { ReactElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BrowserViewportState } from "@traycer/protocol/host/browser/viewport";
import { BrowserViewportToolbar } from "../browser-viewport-toolbar";
import {
  BrowserSessionsContext,
  type BrowserSessionsState,
} from "@/components/epic-canvas/renderers/browser-sessions-context";
import { useBrowserViewport } from "../use-browser-viewport";

const desktopWindowId = vi.hoisted(() => ({ value: "window-a" }));
const coordinatorSnapshot = vi.hoisted(() => ({
  value: null as BrowserSessionsState | null,
}));

vi.mock("@/lib/windows/desktop-window-id", () => ({
  useDesktopWindowId: () => desktopWindowId.value,
  readDesktopWindowId: () => desktopWindowId.value,
}));

vi.mock(
  "@/lib/browser-view/sessions/browser-sessions-coordinator",
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import("@/lib/browser-view/sessions/browser-sessions-coordinator")
      >();
    return {
      ...actual,
      browserSessionsCoordinatorState: () => coordinatorSnapshot.value,
    };
  },
);

function viewportState(): BrowserViewportState {
  return {
    sessionId: "session-1",
    tabId: "tab-1",
    intent: { mode: "fit" },
    applied: null,
    revision: 1,
    source: "user",
    fitOwnerId: null,
  };
}

function readOnlyViewportState(): BrowserViewportState {
  return {
    ...viewportState(),
    applied: { width: 390, height: 312, dpr: 1 },
  };
}

function fixedViewportState(): BrowserViewportState {
  return {
    ...viewportState(),
    intent: { mode: "fixed", width: 390, height: 844 },
    applied: { width: 390, height: 844, dpr: 1 },
  };
}

function sessionsState(
  setViewport: BrowserSessionsState["setViewport"],
  viewport: BrowserViewportState,
  reportViewport: BrowserSessionsState["reportViewport"],
): BrowserSessionsState {
  return {
    viewports: { "tab-1": viewport },
    setViewport,
    reportViewport,
    hostId: "host-1",
    lifecycle: "live",
    inventoryReady: true,
    canMaterializeElectron: true,
    connectionGeneration: 1,
    items: [],
    errorMessage: null,
    retry: () => undefined,
    openTab: () => Promise.reject(new Error("unused")),
    closeTab: () => Promise.resolve(),
    attachTab: () => Promise.resolve(),
    moveTab: () => Promise.resolve(),
  };
}

function ViewportProbe(): ReactElement {
  const presentation = useBrowserViewport({
    hostId: "host-1",
    sessionId: "session-1",
    tabId: "tab-1",
    instanceId: "instance-1",
    visible: true,
    disabled: false,
    pageZoom: 1,
    native: true,
  });
  const controller = presentation.controller;
  if (controller === null) {
    return <output data-testid="missing">missing</output>;
  }
  return (
    <>
      <button type="button" onClick={controller.open}>
        Open viewport
      </button>
      <button
        type="button"
        onClick={() => void controller.reset().catch(() => undefined)}
      >
        Reset viewport
      </button>
      <button
        type="button"
        onClick={() => void controller.resize(1, 1).catch(() => undefined)}
      >
        Invalid viewport
      </button>
      <button
        type="button"
        onClick={() => void controller.resize(640, 480).catch(() => undefined)}
      >
        Resize viewport
      </button>
      <output data-testid="expanded">
        {controller.expanded ? "expanded" : "collapsed"}
      </output>
      <output data-testid="error">{controller.error ?? ""}</output>
    </>
  );
}

function renderProbe(setViewport: BrowserSessionsState["setViewport"]): void {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
  render(
    <QueryClientProvider client={queryClient}>
      <BrowserSessionsContext.Provider
        value={sessionsState(setViewport, viewportState(), () => undefined)}
      >
        <ViewportProbe />
      </BrowserSessionsContext.Provider>
    </QueryClientProvider>,
  );
}

function ReadOnlyViewportProbe(): ReactElement {
  const { areaRef, controller, paintedSize } = useBrowserViewport({
    hostId: "host-1",
    sessionId: "session-1",
    tabId: "tab-1",
    instanceId: "instance-1",
    visible: true,
    disabled: true,
    pageZoom: 1,
    native: false,
  });
  if (controller === null) {
    return <output data-testid="missing">missing</output>;
  }
  return (
    <>
      <div data-testid="measurement-area" ref={areaRef} />
      <button type="button" onClick={controller.open}>
        Open viewport
      </button>
      <button
        type="button"
        onClick={() => void controller.reset().catch(() => undefined)}
      >
        Reset viewport
      </button>
      <button
        type="button"
        onClick={() => void controller.resize(640, 480).catch(() => undefined)}
      >
        Resize viewport
      </button>
      <button type="button" onClick={controller.claim}>
        Claim viewport
      </button>
      <output data-testid="disabled">{String(controller.disabled)}</output>
      <output data-testid="painted-width">
        {paintedSize?.width ?? "none"}
      </output>
      <output data-testid="error">{controller.error ?? ""}</output>
    </>
  );
}

function renderReadOnlyProbe(
  setViewport: BrowserSessionsState["setViewport"],
  reportViewport: BrowserSessionsState["reportViewport"],
): void {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
  render(
    <QueryClientProvider client={queryClient}>
      <BrowserSessionsContext.Provider
        value={sessionsState(
          setViewport,
          readOnlyViewportState(),
          reportViewport,
        )}
      >
        <ReadOnlyViewportProbe />
      </BrowserSessionsContext.Provider>
    </QueryClientProvider>,
  );
}

function PreviewScaleProbe(): ReactElement {
  const { areaRef, controller, guestViewport, paintedSize, scrollRef } =
    useBrowserViewport({
      hostId: "host-1",
      sessionId: "session-1",
      tabId: "tab-1",
      instanceId: "instance-1",
      visible: true,
      disabled: false,
      pageZoom: 1,
      native: false,
    });
  if (controller === null) {
    return <output data-testid="missing">missing</output>;
  }
  return (
    <div data-testid="measurement-area" ref={areaRef}>
      <div data-testid="scroll-area" ref={scrollRef}>
        <button type="button" onClick={() => controller.setPreviewScale(1.5)}>
          Set 150% preview scale
        </button>
        <button
          type="button"
          onClick={() => void controller.reset().catch(() => undefined)}
        >
          Reset preview scale
        </button>
        <output data-testid="preview-scale-setting">
          {controller.previewScaleSetting === null
            ? "auto"
            : String(controller.previewScaleSetting)}
        </output>
        <output data-testid="resize-scale">{controller.resizeScale}</output>
        <output data-testid="resize-from-center">
          {String(controller.resizeFromCenter())}
        </output>
        <output data-testid="guest-size">
          {guestViewport === null
            ? "none"
            : `${guestViewport.width}x${guestViewport.height}`}
        </output>
        <output data-testid="guest-auto-fit">
          {guestViewport === null ? "none" : String(guestViewport.autoFit)}
        </output>
        <output data-testid="painted-size">
          {paintedSize === null
            ? "none"
            : `${paintedSize.width}x${paintedSize.height}`}
        </output>
      </div>
    </div>
  );
}

function renderPreviewScaleProbe(
  setViewport: BrowserSessionsState["setViewport"],
): void {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
  render(
    <QueryClientProvider client={queryClient}>
      <BrowserSessionsContext.Provider
        value={sessionsState(
          setViewport,
          fixedViewportState(),
          () => undefined,
        )}
      >
        <PreviewScaleProbe />
      </BrowserSessionsContext.Provider>
    </QueryClientProvider>,
  );
}

function InteractionProbe(): ReactElement {
  const { areaRef, controller, onInteraction, scrollRef } = useBrowserViewport({
    hostId: "host-1",
    sessionId: "session-1",
    tabId: "tab-1",
    instanceId: "instance-1",
    visible: true,
    disabled: false,
    pageZoom: 1,
    native: false,
  });
  if (controller === null) {
    return <output data-testid="missing">missing</output>;
  }
  return (
    <div
      data-testid="viewport-scroll"
      ref={scrollRef}
      onFocusCapture={onInteraction}
      onPointerDownCapture={onInteraction}
    >
      <div data-testid="measurement-area" ref={areaRef} />
      <BrowserViewportToolbar controller={controller} />
    </div>
  );
}

afterEach(() => {
  cleanup();
  coordinatorSnapshot.value = null;
  vi.restoreAllMocks();
});

describe("useBrowserViewport", () => {
  it("waits for the viewport mutation acknowledgement before expanding", async () => {
    const acknowledgement = Promise.withResolvers<void>();
    const setViewport = vi.fn<BrowserSessionsState["setViewport"]>(
      () => acknowledgement.promise,
    );

    renderProbe(setViewport);
    fireEvent.click(screen.getByRole("button", { name: "Open viewport" }));

    await waitFor(() => {
      expect(setViewport).toHaveBeenCalledWith("session-1", "tab-1", {
        mode: "fit",
      });
    });
    expect(screen.getByTestId("expanded").textContent).toBe("collapsed");

    await act(async () => {
      acknowledgement.resolve();
      await acknowledgement.promise;
    });
    await waitFor(() => {
      expect(screen.getByTestId("expanded").textContent).toBe("expanded");
    });
  });

  it("does not apply a stale open after reset and exposes validation errors", async () => {
    const openAcknowledgement = Promise.withResolvers<void>();
    const resetAcknowledgement = Promise.withResolvers<void>();
    let callCount = 0;
    const setViewport = vi.fn<BrowserSessionsState["setViewport"]>(() => {
      callCount += 1;
      return (callCount === 1 ? openAcknowledgement : resetAcknowledgement)
        .promise;
    });

    renderProbe(setViewport);
    fireEvent.click(screen.getByRole("button", { name: "Open viewport" }));
    fireEvent.click(screen.getByRole("button", { name: "Reset viewport" }));
    await waitFor(() => {
      expect(setViewport).toHaveBeenCalledTimes(2);
    });

    await act(async () => {
      openAcknowledgement.resolve();
      await openAcknowledgement.promise;
    });
    expect(screen.getByTestId("expanded").textContent).toBe("collapsed");

    await act(async () => {
      resetAcknowledgement.resolve();
      await resetAcknowledgement.promise;
    });
    expect(screen.getByTestId("expanded").textContent).toBe("collapsed");
    expect(setViewport).toHaveBeenCalledTimes(2);

    fireEvent.click(screen.getByRole("button", { name: "Invalid viewport" }));
    await waitFor(() => {
      expect(screen.getByTestId("error").textContent).not.toBe("");
    });
    expect(setViewport).toHaveBeenCalledTimes(2);
  });

  it("shows a host failure at its rollback revision and hides it after a later update", async () => {
    const rejection = Promise.withResolvers<void>();
    const setViewport = vi.fn<BrowserSessionsState["setViewport"]>(
      () => rejection.promise,
    );
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false },
      },
    });
    const initial = viewportState();
    const view = render(
      <QueryClientProvider client={queryClient}>
        <BrowserSessionsContext.Provider
          value={sessionsState(setViewport, initial, () => undefined)}
        >
          <ViewportProbe />
        </BrowserSessionsContext.Provider>
      </QueryClientProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Resize viewport" }));
    await waitFor(() => {
      expect(setViewport).toHaveBeenCalledWith("session-1", "tab-1", {
        mode: "fixed",
        width: 640,
        height: 480,
      });
    });

    const rollback = {
      ...initial,
      revision: 2,
      applied: { width: 390, height: 844, dpr: 1 },
    } satisfies BrowserViewportState;
    coordinatorSnapshot.value = sessionsState(
      setViewport,
      rollback,
      () => undefined,
    );
    view.rerender(
      <QueryClientProvider client={queryClient}>
        <BrowserSessionsContext.Provider
          value={sessionsState(setViewport, rollback, () => undefined)}
        >
          <ViewportProbe />
        </BrowserSessionsContext.Provider>
      </QueryClientProvider>,
    );

    await act(async () => {
      rejection.reject(new Error("viewport was rolled back"));
      await rejection.promise.catch(() => undefined);
    });
    await waitFor(() => {
      expect(screen.getByTestId("error").textContent).toContain(
        "viewport was rolled back",
      );
    });

    const later = { ...rollback, revision: 3 } satisfies BrowserViewportState;
    coordinatorSnapshot.value = sessionsState(
      setViewport,
      later,
      () => undefined,
    );
    view.rerender(
      <QueryClientProvider client={queryClient}>
        <BrowserSessionsContext.Provider
          value={sessionsState(setViewport, later, () => undefined)}
        >
          <ViewportProbe />
        </BrowserSessionsContext.Provider>
      </QueryClientProvider>,
    );
    expect(screen.getByTestId("error").textContent).toBe("");
  });

  it("keeps local measurement while read-only controls cannot report, claim, or mutate", async () => {
    const setViewport = vi.fn<BrowserSessionsState["setViewport"]>(() =>
      Promise.resolve(),
    );
    const reportViewport = vi.fn<BrowserSessionsState["reportViewport"]>();
    vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(640);
    vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(480);

    renderReadOnlyProbe(setViewport, reportViewport);

    await waitFor(() => {
      expect(screen.getByTestId("painted-width").textContent).toBe("390");
    });
    expect(screen.getByTestId("disabled").textContent).toBe("true");
    expect(reportViewport).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Claim viewport" }));
    fireEvent.click(screen.getByRole("button", { name: "Open viewport" }));
    fireEvent.click(screen.getByRole("button", { name: "Reset viewport" }));
    fireEvent.click(screen.getByRole("button", { name: "Resize viewport" }));

    await waitFor(() => {
      expect(screen.getByTestId("error").textContent).toContain(
        "Viewport controls are unavailable",
      );
    });
    expect(setViewport).not.toHaveBeenCalled();
    expect(reportViewport).not.toHaveBeenCalled();
  });

  it("changes preview scale locally and reset returns to auto fit", async () => {
    const setViewport = vi.fn<BrowserSessionsState["setViewport"]>(() =>
      Promise.resolve(),
    );
    vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(
      function (this: HTMLElement): number {
        return this.dataset.testid === "scroll-area" ? 590 : 640;
      },
    );
    vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(480);

    renderPreviewScaleProbe(setViewport);

    await waitFor(() => {
      expect(screen.getByTestId("guest-size").textContent).toBe("390x844");
      expect(screen.getByTestId("preview-scale-setting").textContent).toBe(
        "auto",
      );
    });
    expect(setViewport).not.toHaveBeenCalled();

    fireEvent.click(
      screen.getByRole("button", { name: "Set 150% preview scale" }),
    );
    await waitFor(() => {
      expect(screen.getByTestId("preview-scale-setting").textContent).toBe(
        "1.5",
      );
      expect(screen.getByTestId("resize-scale").textContent).toBe("1.5");
      expect(screen.getByTestId("resize-from-center").textContent).toBe(
        "false",
      );
      expect(screen.getByTestId("guest-size").textContent).toBe("390x844");
      expect(screen.getByTestId("guest-auto-fit").textContent).toBe("false");
      expect(screen.getByTestId("painted-size").textContent).toBe("585x1266");
    });
    expect(setViewport).not.toHaveBeenCalled();

    fireEvent.click(
      screen.getByRole("button", { name: "Reset preview scale" }),
    );
    await waitFor(() => {
      expect(setViewport).toHaveBeenCalledWith("session-1", "tab-1", {
        mode: "fit",
      });
      expect(screen.getByTestId("preview-scale-setting").textContent).toBe(
        "auto",
      );
      expect(screen.getByTestId("resize-from-center").textContent).toBe("true");
      expect(screen.getByTestId("guest-auto-fit").textContent).toBe("true");
    });
  });

  it("does not claim while inspecting toolbar controls but claims a committed resize", async () => {
    const setViewport = vi.fn<BrowserSessionsState["setViewport"]>(() =>
      Promise.resolve(),
    );
    const reportViewport = vi.fn<BrowserSessionsState["reportViewport"]>();
    vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(640);
    vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(480);
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false },
      },
    });
    render(
      <QueryClientProvider client={queryClient}>
        <BrowserSessionsContext.Provider
          value={sessionsState(
            setViewport,
            fixedViewportState(),
            reportViewport,
          )}
        >
          <InteractionProbe />
        </BrowserSessionsContext.Provider>
      </QueryClientProvider>,
    );

    await waitFor(() => {
      expect(reportViewport).toHaveBeenCalledWith(
        expect.objectContaining({ claim: false }),
      );
    });
    const scroll = screen.getByTestId("viewport-scroll");
    fireEvent.focus(scroll);
    fireEvent.pointerDown(scroll, { button: 0 });
    const scaleTrigger = screen.getByRole("button", { name: "Preview scale" });
    fireEvent.focus(scaleTrigger);
    fireEvent.pointerDown(scaleTrigger, { button: 0 });
    await waitFor(() => {
      expect(screen.getByRole("menuitemradio", { name: "200%" })).toBeTruthy();
    });
    fireEvent.click(screen.getByRole("menuitemradio", { name: "200%" }));

    expect(
      reportViewport.mock.calls.filter(([input]) => input.claim),
    ).toHaveLength(0);

    const width = screen.getByRole("spinbutton", { name: "Viewport width" });
    fireEvent.focus(width);
    fireEvent.change(width, { target: { value: "500" } });
    fireEvent.keyDown(width, { key: "Enter" });
    await waitFor(() => {
      expect(setViewport).toHaveBeenCalledWith("session-1", "tab-1", {
        mode: "fixed",
        width: 500,
        height: 844,
      });
    });
    expect(
      reportViewport.mock.calls.filter(([input]) => input.claim),
    ).toHaveLength(1);
  });
});
