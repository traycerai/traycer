import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BrowserScreencastServerFrame } from "@traycer/protocol/host/browser/contracts";
import { usePipOwnedFrame } from "@/lib/browser-view/pip/pip-frame-capture";
import {
  HIDDEN_PIP_SNAPSHOT,
  type PipSnapshot,
  type PipTarget,
} from "@/lib/browser-view/pip/pip-store";

/**
 * The non-pixel half of PiP's own subscription: frame geometry and the agent
 * cursor. Everything below the transport is real - only the stream itself is
 * stood in, so the frames travel the same `applyCaptureFrame` path production
 * uses.
 */
type OpenStreamHandle = {
  onFrame:
    | ((
        frame: BrowserScreencastServerFrame,
        jpegBytes: Uint8Array | null,
      ) => void)
    | null;
};

const openStream = vi.hoisted((): OpenStreamHandle => ({ onFrame: null }));

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

function target(selectionId: string): PipTarget {
  return {
    hostId: "host-1",
    sessionId: "session-1",
    tabId: "tab-1",
    selectionId,
    origin: "agent",
  };
}

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

function probe(): DOMStringMap {
  return screen.getByTestId("pip-meta-probe").dataset;
}

function emit(frame: BrowserScreencastServerFrame): void {
  act(() => {
    openStream.onFrame?.(frame, null);
  });
}

const STARTED: BrowserScreencastServerFrame = {
  kind: "started",
  hasBinaryPayload: false,
  frameWidth: 800,
  frameHeight: 600,
  deviceScaleFactor: 1,
};

const CURSOR: BrowserScreencastServerFrame = {
  kind: "agentCursor",
  hasBinaryPayload: false,
  type: "move",
  epoch: 4,
  normalizedX: 0.5,
  normalizedY: 0.25,
  label: "Agent",
};

afterEach(() => {
  cleanup();
  openStream.onFrame = null;
});

describe("usePipOwnedFrame meta", () => {
  it("surfaces the frame geometry and the agent cursor of the displayed tab", () => {
    render(
      <PipMetaProbe
        snapshot={{ ...HIDDEN_PIP_SNAPSHOT, target: target("selection-a") }}
      />,
    );

    emit(STARTED);
    emit(CURSOR);

    expect(probe().frameSize).toBe("800x600");
    expect(probe().cursor).toBe("Agent");
  });

  it("drops meta from the pending tab so it cannot paint over the displayed one", () => {
    // Mid-switch: capture has already moved to the incoming selection while
    // the outgoing one is still on screen.
    render(
      <PipMetaProbe
        snapshot={{
          ...HIDDEN_PIP_SNAPSHOT,
          target: target("selection-a"),
          pendingTarget: target("selection-b"),
        }}
      />,
    );

    emit(STARTED);
    emit(CURSOR);

    expect(probe().frameSize).toBe("");
    expect(probe().cursor).toBe("");
  });
});
