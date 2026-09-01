import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BrowserScreencastServerFrame } from "@traycer/protocol/host/browser/contracts";
import { usePipOwnedFrame } from "@/lib/browser-view/pip/pip-frame-capture";
import {
  HIDDEN_PIP_SNAPSHOT,
  type PipSnapshot,
  type PipTarget,
} from "@/lib/browser-view/pip/pip-store";

type OpenStreamHandle = {
  onFrame:
    | ((
        frame: BrowserScreencastServerFrame,
        jpegBytes: Uint8Array | null,
      ) => void)
    | null;
};

const openStream = vi.hoisted((): OpenStreamHandle => ({
  onFrame: null,
}));

vi.mock("@/lib/browser-view/pip/pip-headless-stream", () => ({
  PIP_HEADLESS_MAX_WIDTH: 480,
  PIP_HEADLESS_MAX_HEIGHT: 360,
  PIP_HEADLESS_QUALITY: 50,
  openPipHeadlessStream: (input: {
    readonly onFrame: (
      frame: BrowserScreencastServerFrame,
      jpegBytes: Uint8Array | null,
    ) => void;
  }) => {
    openStream.onFrame = input.onFrame;
    return {
      close: () => {
        openStream.onFrame = null;
      },
    };
  },
}));

// No Electron bridge and no native binding: PiP takes its headless transport.
vi.mock("@/providers/use-runner-host", () => ({
  useRunnerHostOrNull: () => null,
}));

vi.mock("@/lib/browser-view/sessions/electron-tabs", () => ({
  useElectronTabBindingOnHost: () => null,
}));

vi.mock("@/hooks/host/use-host-directory-entry", () => ({
  useHostDirectoryEntry: () => ({ hostId: "host-1" }),
}));

vi.mock("@/lib/host/stream-auth-revalidator", () => ({
  useStreamAuthRevalidator: () => null,
}));

vi.mock("@/hooks/host/use-host-stream-client-for", () => ({
  useHostStreamClientFor: () => ({ hostId: "host-1" }),
}));

function pipTarget(selectionId: string): PipTarget {
  return {
    hostId: "host-1",
    sessionId: "session-1",
    tabId: "tab-1",
    selectionId,
    origin: "agent",
  };
}

function emitPipFrame(frame: BrowserScreencastServerFrame): void {
  act(() => {
    openStream.onFrame?.(frame, null);
  });
}

function pipTestDataset(testId: string): DOMStringMap {
  return screen.getByTestId(testId).dataset;
}

const PIP_STARTED_FRAME: BrowserScreencastServerFrame = {
  kind: "started",
  hasBinaryPayload: false,
  frameWidth: 800,
  frameHeight: 600,
  deviceScaleFactor: 1,
};

const PIP_CURSOR_FRAME: BrowserScreencastServerFrame = {
  kind: "agentCursor",
  hasBinaryPayload: false,
  type: "move",
  epoch: 4,
  normalizedX: 0.5,
  normalizedY: 0.25,
  label: "Agent",
};

/**
 * The non-pixel half of PiP's own subscription: frame geometry and the agent
 * cursor. Everything below the transport is real - only the stream itself is
 * stood in, so the frames travel the same `applyCaptureFrame` path production
 * uses. The transport's own key/probe behaviour is pinned against the real
 * module in `pip-headless-stream.test.ts`.
 */
function PipMetaProbe(props: { readonly snapshot: PipSnapshot }) {
  const preview = usePipOwnedFrame("epic-1", props.snapshot);
  return (
    <div
      data-testid="pip-meta-probe"
      data-cursor={preview.cursor?.label ?? ""}
      data-frame-size={
        preview.frameSize === null
          ? ""
          : `${String(preview.frameSize.width)}x${String(preview.frameSize.height)}`
      }
    />
  );
}

afterEach(() => {
  cleanup();
  openStream.onFrame = null;
});

describe("usePipOwnedFrame meta", () => {
  it("surfaces the frame geometry and the agent cursor of the displayed tab", () => {
    render(
      <PipMetaProbe
        snapshot={{ ...HIDDEN_PIP_SNAPSHOT, target: pipTarget("selection-a") }}
      />,
    );

    emitPipFrame(PIP_STARTED_FRAME);
    emitPipFrame(PIP_CURSOR_FRAME);

    const dataset = pipTestDataset("pip-meta-probe");
    expect(dataset.frameSize).toBe("800x600");
    expect(dataset.cursor).toBe("Agent");
  });

  it("drops meta from the pending tab so it cannot paint over the displayed one", () => {
    // Mid-switch: capture has already moved to the incoming selection while
    // the outgoing one is still on screen.
    render(
      <PipMetaProbe
        snapshot={{
          ...HIDDEN_PIP_SNAPSHOT,
          target: pipTarget("selection-a"),
          pendingTarget: pipTarget("selection-b"),
        }}
      />,
    );

    emitPipFrame(PIP_STARTED_FRAME);
    emitPipFrame(PIP_CURSOR_FRAME);

    const dataset = pipTestDataset("pip-meta-probe");
    expect(dataset.frameSize).toBe("");
    expect(dataset.cursor).toBe("");
  });
});
