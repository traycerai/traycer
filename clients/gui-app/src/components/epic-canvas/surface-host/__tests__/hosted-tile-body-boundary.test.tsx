import { useState, type ReactNode } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HostedTileBodyBoundary } from "@/components/epic-canvas/surface-host/hosted-tile-body-boundary";
import type {
  ReportIssueErrorCapture,
  ReportIssueErrorCaptureInput,
} from "@/lib/report-issue-error-capture";
import type { appLogger } from "@/lib/logger";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import type { EpicCanvasState, EpicNodeRef } from "@/stores/epics/canvas/types";
import { useTabsStore } from "@/stores/tabs/store";
import type { TabRef } from "@/stores/tabs/types";
import { TEST_HOST_ID } from "@/stores/epics/canvas/__tests__/canvas-test-fixtures";
import { resetTileSurfaceMembershipForTesting } from "@/components/epic-canvas/surface-host/tile-surface-membership";
import {
  publishTileSurfaceEnvironment,
  resetTileSurfaceEnvironmentRegistryForTesting,
  type ReadyTileSurfaceEnvironment,
} from "@/components/epic-canvas/surface-host/tile-surface-environment-registry";
import { resetTileSurfaceGeometryCoordinatorForTesting } from "@/components/epic-canvas/surface-host/tile-surface-geometry-coordinator";
import { StableTileSurfaceHost } from "@/components/epic-canvas/surface-host/stable-tile-surface-host";
import { buildSyntheticTileSurfaceEnvironment } from "@/components/epic-canvas/surface-host/__tests__/synthetic-tile-surface-fixture";

// Typed with the real signature so `mock.calls` carries the input shape the
// assertions below read (an untyped `vi.fn(() => ...)` types its calls as `[]`).
const captureReportIssueError = vi.hoisted(() =>
  vi.fn((input: ReportIssueErrorCaptureInput): ReportIssueErrorCapture => ({
    cause: {
      type: "Error",
      message: "boom",
      stack: null,
      componentStack: input.componentStack,
      errorCode: null,
      sourceAction: input.sourceAction,
      timestamp: 1,
    },
    correlationId: "correlation-1",
    fingerprint: "fp:v1:test",
    stackFamily: null,
  })),
);
const errorSummary = vi.hoisted(() => vi.fn<typeof appLogger.errorSummary>());

vi.mock("@/lib/report-issue-error-capture", () => ({
  captureReportIssueError,
}));

vi.mock("@/lib/logger", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/logger")>()),
  appLogger: { errorSummary, info: vi.fn(), warn: vi.fn() },
}));

afterEach(() => {
  cleanup();
  captureReportIssueError.mockClear();
  errorSummary.mockClear();
});

function Boom(props: { readonly shouldThrow: boolean }): ReactNode {
  if (props.shouldThrow) throw new Error("boom");
  return <div data-testid="boom-child">ok</div>;
}

function RetryHarness(): ReactNode {
  const [shouldThrow, setShouldThrow] = useState(true);
  return (
    <div>
      <button
        type="button"
        data-testid="stop-throwing"
        onClick={() => setShouldThrow(false)}
      >
        stop throwing
      </button>
      <HostedTileBodyBoundary instanceId="chat-1" resetKey="env-1">
        <Boom shouldThrow={shouldThrow} />
      </HostedTileBodyBoundary>
    </div>
  );
}

function ResetKeyHarness(): ReactNode {
  const [resetKey, setResetKey] = useState("env-1");
  const [renderTick, setRenderTick] = useState(0);
  const [shouldThrow, setShouldThrow] = useState(true);
  return (
    <div>
      <span data-testid="render-tick">{renderTick}</span>
      <button
        type="button"
        data-testid="rerender-same-key"
        onClick={() => setRenderTick((tick) => tick + 1)}
      >
        rerender same key
      </button>
      <button
        type="button"
        data-testid="change-reset-key"
        onClick={() => {
          setShouldThrow(false);
          setResetKey("env-2");
        }}
      >
        change reset key
      </button>
      <HostedTileBodyBoundary instanceId="chat-1" resetKey={resetKey}>
        <Boom shouldThrow={shouldThrow} />
      </HostedTileBodyBoundary>
    </div>
  );
}

describe("<HostedTileBodyBoundary />", () => {
  it("shows the fallback panel, captures the error, and leaves siblings outside the boundary untouched", () => {
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);

    render(
      <div>
        <div data-testid="sibling">sibling content</div>
        <HostedTileBodyBoundary instanceId="chat-1" resetKey="env-1">
          <Boom shouldThrow />
        </HostedTileBodyBoundary>
      </div>,
    );

    const alert = screen.getByRole("alert");
    expect(alert.getAttribute("data-testid")).toBe(
      "hosted-tile-body-error-chat-1",
    );
    expect(
      screen.getByText("This agent's view stopped rendering."),
    ).not.toBeNull();
    expect(screen.getByTestId("sibling").textContent).toBe("sibling content");

    expect(captureReportIssueError).toHaveBeenCalledTimes(1);
    const [captureCall] = captureReportIssueError.mock.calls[0];
    expect(captureCall.sourceAction).toBe("Agent tile");
    expect(captureCall.componentStack).not.toBeNull();

    expect(errorSummary).toHaveBeenCalledTimes(1);
    const [, summaryDetails] = errorSummary.mock.calls[0];
    expect(summaryDetails).toMatchObject({ instanceId: "chat-1" });

    consoleError.mockRestore();
  });

  it("clicking Retry re-renders the child once it has stopped throwing", () => {
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);

    render(<RetryHarness />);
    expect(screen.getByRole("alert")).not.toBeNull();

    fireEvent.click(screen.getByTestId("stop-throwing"));
    expect(screen.getByRole("alert")).not.toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Retry" }));

    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByTestId("boom-child")).not.toBeNull();

    consoleError.mockRestore();
  });

  it("clears the fallback automatically when resetKey identity changes, but not on an unrelated re-render carrying the same key", () => {
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);

    render(<ResetKeyHarness />);
    expect(screen.getByRole("alert")).not.toBeNull();

    fireEvent.click(screen.getByTestId("rerender-same-key"));
    expect(screen.getByTestId("render-tick").textContent).toBe("1");
    expect(screen.getByRole("alert")).not.toBeNull();

    fireEvent.click(screen.getByTestId("change-reset-key"));
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByTestId("boom-child")).not.toBeNull();

    consoleError.mockRestore();
  });
});

function chatRef(instanceId: string): EpicNodeRef {
  return {
    id: instanceId,
    instanceId,
    type: "chat",
    name: `Chat ${instanceId}`,
    hostId: TEST_HOST_ID,
  };
}

function canvasWithChats(
  paneId: string,
  instanceIds: ReadonlyArray<string>,
): EpicCanvasState {
  return {
    // NOT the shared `pane()` fixture: it only seeds `activationHistory`
    // with the FIRST tab id, but retention (`retained-pane-chats.ts`) reads
    // membership off `activationHistory`, capped at
    // `RETAINED_PANE_CHAT_CAP` (2). Both chats here must be retained, so
    // both must be recorded as recently-active.
    root: {
      kind: "pane",
      id: paneId,
      tabInstanceIds: instanceIds,
      activeTabId: instanceIds[0] ?? null,
      previewTabId: null,
      activationHistory: [...instanceIds],
    },
    activePaneId: paneId,
    tilesByInstanceId: Object.fromEntries(
      instanceIds.map((id) => [id, chatRef(id)]),
    ),
    sizesByGroupId: {},
  };
}

function seedSingleTabStrip(
  refs: ReadonlyArray<TabRef>,
  activeRef: TabRef,
): void {
  useTabsStore.setState((state) => ({
    ...state,
    items: refs.map((ref) => ({
      kind: "tab" as const,
      id: `tab:${ref.kind}:${ref.id}`,
      ref,
    })),
    activeItemId: `tab:${activeRef.kind}:${activeRef.id}`,
    stripOrder: refs,
  }));
}

function resetSurfaceHostState(): void {
  useEpicCanvasStore.setState(useEpicCanvasStore.getInitialState(), true);
  useTabsStore.setState(useTabsStore.getInitialState(), true);
  resetTileSurfaceMembershipForTesting();
  resetTileSurfaceEnvironmentRegistryForTesting();
  resetTileSurfaceGeometryCoordinatorForTesting();
}

function ThrowingRecordBody(): ReactNode {
  throw new Error("tile body crashed");
}

describe("StableTileSurfaceHost + HostedTileBodyBoundary integration", () => {
  afterEach(() => {
    cleanup();
    resetSurfaceHostState();
  });

  it("one record's crashing body shows only that record's fallback while a sibling record keeps rendering", () => {
    resetSurfaceHostState();
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);

    useEpicCanvasStore.setState({
      tabsById: {
        "tab-1": { tabId: "tab-1", epicId: "epic-1", name: "Epic 1" },
      },
      canvasByTabId: { "tab-1": canvasWithChats("p1", ["chat-1", "chat-2"]) },
      openTabOrder: ["tab-1"],
      activeTabId: "tab-1",
    });
    seedSingleTabStrip([{ kind: "epic", id: "tab-1" }], {
      kind: "epic",
      id: "tab-1",
    });
    publishTileSurfaceEnvironment(
      buildSyntheticTileSurfaceEnvironment("chat-1", {}),
    );
    publishTileSurfaceEnvironment(
      buildSyntheticTileSurfaceEnvironment("chat-2", {}),
    );

    function renderRecordBody(
      environment: ReadyTileSurfaceEnvironment,
    ): ReactNode {
      if (environment.identity.instanceId === "chat-1") {
        return <ThrowingRecordBody />;
      }
      return (
        <div data-testid={`ok-body-${environment.identity.instanceId}`}>ok</div>
      );
    }

    render(<StableTileSurfaceHost renderRecordBody={renderRecordBody} />);

    expect(screen.getByTestId("hosted-tile-body-error-chat-1")).not.toBeNull();
    expect(screen.getByTestId("ok-body-chat-2").textContent).toBe("ok");
    expect(screen.queryByTestId("ok-body-chat-1")).toBeNull();

    consoleError.mockRestore();
  });
});
