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
import {
  BrowserSessionsContext,
  type BrowserSessionsState,
} from "@/components/epic-canvas/renderers/browser-sessions-context";
import { useBrowserViewport } from "../use-browser-viewport";

const desktopWindowId = vi.hoisted(() => ({ value: "window-a" }));

vi.mock("@/lib/windows/desktop-window-id", () => ({
  useDesktopWindowId: () => desktopWindowId.value,
  readDesktopWindowId: () => desktopWindowId.value,
}));

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

function sessionsState(
  setViewport: BrowserSessionsState["setViewport"],
): BrowserSessionsState {
  return {
    viewports: { "tab-1": viewportState() },
    setViewport,
    reportViewport: () => undefined,
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
      <BrowserSessionsContext.Provider value={sessionsState(setViewport)}>
        <ViewportProbe />
      </BrowserSessionsContext.Provider>
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
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
});
