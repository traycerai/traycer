import "../../../../../__tests__/test-browser-apis";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  FakeStreamClient,
  PEEK_NODE,
  clearScreencastOwner,
  hostDirectoryEntryModule,
  hostStreamClientForWithAuthModule,
  liveStream as fixtureLiveStream,
  streamAuthRevalidatorModule,
  tabHostIdModule,
  tileBodyVisibleModule,
  type FakeStreamSession,
} from "@/components/epic-canvas/renderers/__tests__/browser-peek-tile-stream-fixture";
import { BrowserPeekTile } from "@/components/epic-canvas/renderers/browser-peek-tile";

const hookState = vi.hoisted(() => ({
  streamClient: null as FakeStreamClient | null,
  visible: true,
}));

vi.mock("sonner", () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}));

// The one fork this file exercises: a coarse pointer picks the compact chrome
// and the sheet-shaped dialog inside the single tile. Touch INPUT is not a
// fork - the controller translates a finger on any pointer grade, and
// `browser-peek-tile-touch.test.tsx` covers it.
vi.mock("@/hooks/ui/use-coarse-pointer", () => ({
  useCoarsePointer: () => true,
}));

vi.mock("@/components/epic-canvas/hooks/use-tab-host-id", () =>
  tabHostIdModule(),
);

vi.mock("@/components/epic-canvas/hooks/use-tile-body-visible", () =>
  tileBodyVisibleModule(hookState),
);

vi.mock("@/hooks/host/use-host-directory-entry", () =>
  hostDirectoryEntryModule(),
);

vi.mock("@/hooks/host/use-host-stream-client-for", () =>
  hostStreamClientForWithAuthModule(hookState),
);

vi.mock("@/lib/host/stream-auth-revalidator", () =>
  streamAuthRevalidatorModule(),
);

function liveStream(): FakeStreamSession {
  return fixtureLiveStream(hookState);
}

function overlayButton(): HTMLElement {
  return screen.getByRole("button", { name: "Browser screencast controls" });
}

function framesOfKind(
  stream: FakeStreamSession,
  kind: string,
): Array<Record<string, unknown>> {
  return stream.sentFrames.filter((frame) => frame.kind === kind);
}

function emitStarted(stream: FakeStreamSession): void {
  stream.emit(
    {
      kind: "started",
      hasBinaryPayload: false,
      frameWidth: 800,
      frameHeight: 600,
      deviceScaleFactor: 1,
    },
    null,
  );
}

function emitJpegFrame(
  stream: FakeStreamSession,
  sequence: number,
  bytes: Uint8Array,
): void {
  stream.emit(
    {
      kind: "frame",
      hasBinaryPayload: true,
      sequence,
      metadata: {
        offsetTop: 0,
        pageScaleFactor: 1,
        deviceWidth: 800,
        deviceHeight: 600,
        scrollOffsetX: 0,
        scrollOffsetY: 0,
        timestamp: 1,
      },
    },
    bytes,
  );
}

function loadScreencastImage(): HTMLImageElement {
  const image = screen.getByAltText<HTMLImageElement>("Browser screencast");
  vi.spyOn(image, "getBoundingClientRect").mockReturnValue(
    new DOMRect(0, 0, 800, 600),
  );
  fireEvent.load(image);
  return image;
}

function presentLiveFrame(
  stream: FakeStreamSession,
  sequence: number,
  bytes: Uint8Array,
): HTMLImageElement {
  act(() => {
    emitStarted(stream);
    emitJpegFrame(stream, sequence, bytes);
  });
  return loadScreencastImage();
}

/**
 * Focusing the overlay button re-focuses the hidden IME input (same relay the
 * desktop tile uses), which arms - identical handshake for both viewers, so
 * this mirrors `browser-peek-tile-chrome.test.tsx`'s `armPeekTile` rather
 * than simulating a tap for it (a tap before the arm epoch exists is
 * buffered pending a matching up, so it would not resolve here anyway).
 */
function armPeekTile(stream: FakeStreamSession): void {
  fireEvent.focus(overlayButton());
  act(() => {
    stream.emit({ kind: "armed", hasBinaryPayload: false, armEpoch: 1 }, null);
  });
}

describe("BrowserPeekTile on a coarse pointer", () => {
  beforeEach(() => {
    hookState.visible = true;
    hookState.streamClient = new FakeStreamClient(true);
  });

  afterEach(() => {
    cleanup();
    clearScreencastOwner();
    vi.restoreAllMocks();
  });

  it("nav bar reflects navState", () => {
    render(
      <BrowserPeekTile
        viewTabId="view-tab-1"
        paneId="pane-1"
        epicId="epic-1"
        node={PEEK_NODE}
        isElectronWake={false}
      />,
    );
    const stream = liveStream();
    act(() => {
      stream.emit(
        {
          kind: "navState",
          hasBinaryPayload: false,
          url: "https://example.com/path",
          canGoBack: true,
          canGoForward: false,
          loading: false,
        },
        null,
      );
    });

    expect(
      screen.getByTestId("browser-tile-toolbar-compact").textContent,
    ).toContain("https://example.com/path");
    expect(
      screen.getByRole("button", { name: "Back" }).hasAttribute("disabled"),
    ).toBe(false);
    expect(
      screen.getByRole("button", { name: "Forward" }).hasAttribute("disabled"),
    ).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    // A nav action arms first (queued until the host confirms) and only then
    // sends - same handshake `armPeekTile` drives for input.
    act(() => {
      stream.emit(
        { kind: "armed", hasBinaryPayload: false, armEpoch: 1 },
        null,
      );
    });
    expect(framesOfKind(stream, "goBack")).toHaveLength(1);
  });

  it("a dialog renders as a sheet and answers dialogResponse", async () => {
    render(
      <BrowserPeekTile
        viewTabId="view-tab-1"
        paneId="pane-1"
        epicId="epic-1"
        node={PEEK_NODE}
        isElectronWake={false}
      />,
    );
    const stream = liveStream();
    presentLiveFrame(stream, 7, new Uint8Array([1, 2, 3]));
    armPeekTile(stream);

    act(() => {
      stream.emit(
        {
          kind: "dialogOpened",
          hasBinaryPayload: false,
          generation: 1,
          type: "confirm",
          message: "Leave the page?",
          defaultValue: "",
        },
        null,
      );
    });

    await waitFor(() => {
      expect(
        screen.getByRole("dialog", { name: "Confirm" }).textContent,
      ).toContain("Leave the page?");
    });
    fireEvent.click(screen.getByRole("button", { name: "OK" }));

    const responses = framesOfKind(stream, "dialogResponse");
    expect(responses).toHaveLength(1);
    expect(responses[0]).toMatchObject({ generation: 1, accept: true });
  });
});
