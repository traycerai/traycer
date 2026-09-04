import "../../../../../__tests__/test-browser-apis";
import { act, cleanup, fireEvent, screen } from "@testing-library/react";
import { renderPeekTile } from "@/components/epic-canvas/renderers/__tests__/browser-peek-tile-render";
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
  runnerOpenExternalLinkModule,
  tileRoleRunnerHostModule,
  type FakeStreamSession,
} from "@/components/epic-canvas/renderers/__tests__/browser-peek-tile-stream-fixture";
import { BrowserPeekTile } from "@/components/browser-tile/browser-peek-tile";
import { useScreencastArmedStore } from "@/stores/screencast-armed-store";

const toast = vi.hoisted(() => vi.fn());

const hookState = vi.hoisted(() => ({
  streamClient: null as FakeStreamClient | null,
  visible: true,
}));

vi.mock("@/providers/use-runner-host", () => tileRoleRunnerHostModule());

vi.mock("@/hooks/runner/use-open-external-link-mutation", () =>
  runnerOpenExternalLinkModule(),
);

vi.mock("sonner", () => ({
  toast,
}));

vi.mock("@/components/epic-canvas/hooks/use-tab-host-id", () =>
  tabHostIdModule(),
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

const PEEK_OWNER_ID = [
  PEEK_NODE.hostId,
  PEEK_NODE.sessionId,
  PEEK_NODE.tabId,
  PEEK_NODE.instanceId,
].join("\u001f");

const URL_A = "https://example.com/a";
const URL_B = "https://example.com/b";
const URL_C = "https://example.com/c";
const DRAFT_URL = "https://draft.example/path";

function liveStream(): FakeStreamSession {
  return fixtureLiveStream(hookState);
}

function overlayButton(): HTMLElement {
  return screen.getByRole("button", { name: "Browser screencast controls" });
}

function addressInput(): HTMLInputElement {
  return screen.getByRole("textbox", { name: "Browser address" });
}

function framesOfKind(
  stream: FakeStreamSession,
  kind: string,
): Array<Record<string, unknown>> {
  return stream.sentFrames.filter((frame) => frame.kind === kind);
}

function emitNavState(stream: FakeStreamSession, url: string): void {
  act(() => {
    stream.emit(
      {
        kind: "navState",
        hasBinaryPayload: false,
        url,
        canGoBack: false,
        canGoForward: false,
        loading: false,
      },
      null,
    );
  });
}

function emitUnsupported(
  stream: FakeStreamSession,
  feature: "fileUpload" | "download",
): void {
  act(() => {
    stream.emit(
      {
        kind: "unsupportedInteraction",
        hasBinaryPayload: false,
        feature,
      },
      null,
    );
  });
}

async function flushMacrotask(): Promise<void> {
  await act(async () => {
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 0);
    });
  });
}

function armPeekTile(stream: FakeStreamSession): void {
  fireEvent.focus(overlayButton());
  act(() => {
    stream.emit({ kind: "armed", hasBinaryPayload: false, armEpoch: 1 }, null);
  });
}

describe("BrowserPeekTile toolbar chrome", () => {
  beforeEach(() => {
    hookState.visible = true;
    hookState.streamClient = new FakeStreamClient(true);
    toast.mockClear();
    clearScreencastOwner();
  });

  afterEach(() => {
    cleanup();
    clearScreencastOwner();
    vi.restoreAllMocks();
  });

  it("hides the controlling chip until armed and release disarms that epoch", async () => {
    renderPeekTile(
      <BrowserPeekTile
        scope={{ kind: "epic", epicId: "epic-1" }}
        visible={hookState.visible}
        onConvertToPip={() => {}}
        node={PEEK_NODE}
        completeMeans="ended"
      />,
    );
    const stream = liveStream();

    expect(screen.queryByText("Controlling")).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Release control" }),
    ).toBeNull();

    armPeekTile(stream);
    await flushMacrotask();

    expect(screen.getByText("Controlling")).not.toBeNull();
    const release = screen.getByRole("button", { name: "Release control" });
    expect(release.textContent).toBe("Release");

    fireEvent.click(release);
    await flushMacrotask();

    expect(screen.queryByText("Controlling")).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Release control" }),
    ).toBeNull();
    expect(framesOfKind(stream, "disarm")).toEqual([
      {
        kind: "disarm",
        hasBinaryPayload: false,
        armEpoch: 1,
      },
    ]);
  });

  it("toasts once per unsupportedInteraction feature", () => {
    renderPeekTile(
      <BrowserPeekTile
        scope={{ kind: "epic", epicId: "epic-1" }}
        visible={hookState.visible}
        onConvertToPip={() => {}}
        node={PEEK_NODE}
        completeMeans="ended"
      />,
    );
    const stream = liveStream();

    emitUnsupported(stream, "fileUpload");
    expect(toast).toHaveBeenCalledTimes(1);
    expect(toast).toHaveBeenNthCalledWith(1, "File upload not supported");

    emitUnsupported(stream, "download");
    expect(toast).toHaveBeenCalledTimes(2);
    expect(toast).toHaveBeenNthCalledWith(2, "Download saved on the host");
  });

  it("keeps the focused address draft when the agent navigates", async () => {
    renderPeekTile(
      <BrowserPeekTile
        scope={{ kind: "epic", epicId: "epic-1" }}
        visible={hookState.visible}
        onConvertToPip={() => {}}
        node={PEEK_NODE}
        completeMeans="ended"
      />,
    );
    const stream = liveStream();

    emitNavState(stream, URL_A);
    expect(addressInput().value).toBe(URL_A);

    const input = addressInput();
    fireEvent.focus(input);
    fireEvent.focusIn(input);
    fireEvent.change(input, { target: { value: DRAFT_URL } });
    expect(addressInput().value).toBe(DRAFT_URL);

    emitNavState(stream, URL_B);
    expect(addressInput().value).toBe(DRAFT_URL);

    fireEvent.blur(addressInput());
    fireEvent.focusOut(addressInput());
    await flushMacrotask();
    expect(addressInput().value).toBe(URL_B);

    emitNavState(stream, URL_C);
    expect(addressInput().value).toBe(URL_C);
  });

  it("auto-arms from a cold toolbar back click and sends goBack only after confirmation", async () => {
    renderPeekTile(
      <BrowserPeekTile
        scope={{ kind: "epic", epicId: "epic-1" }}
        visible={hookState.visible}
        onConvertToPip={() => {}}
        node={PEEK_NODE}
        completeMeans="ended"
      />,
    );
    const stream = liveStream();

    act(() => {
      stream.emit(
        {
          kind: "navState",
          hasBinaryPayload: false,
          url: URL_A,
          canGoBack: true,
          canGoForward: false,
          loading: false,
        },
        null,
      );
    });
    await flushMacrotask();

    const back = screen.getByRole("button", { name: "Back" });
    expect((back as HTMLButtonElement).disabled).toBe(false);
    expect(framesOfKind(stream, "arm")).toEqual([]);
    expect(framesOfKind(stream, "goBack")).toEqual([]);

    fireEvent.click(back);

    expect(framesOfKind(stream, "arm")).toEqual([
      { kind: "arm", hasBinaryPayload: false, armEpoch: 1 },
    ]);
    expect(framesOfKind(stream, "goBack")).toEqual([]);

    act(() => {
      stream.emit(
        { kind: "armed", hasBinaryPayload: false, armEpoch: 1 },
        null,
      );
    });
    await flushMacrotask();

    expect(framesOfKind(stream, "goBack")).toEqual([
      {
        kind: "goBack",
        hasBinaryPayload: false,
        armEpoch: 1,
        seq: 0,
      },
    ]);
  });

  it("flushes every pending cold toolbar nav after arm confirmation", async () => {
    renderPeekTile(
      <BrowserPeekTile
        scope={{ kind: "epic", epicId: "epic-1" }}
        visible={hookState.visible}
        onConvertToPip={() => {}}
        node={PEEK_NODE}
        completeMeans="ended"
      />,
    );
    const stream = liveStream();

    act(() => {
      stream.emit(
        {
          kind: "navState",
          hasBinaryPayload: false,
          url: URL_A,
          canGoBack: true,
          canGoForward: true,
          loading: false,
        },
        null,
      );
    });
    await flushMacrotask();

    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    fireEvent.click(screen.getByRole("button", { name: "Forward" }));
    expect(framesOfKind(stream, "arm")).toHaveLength(1);
    expect(framesOfKind(stream, "goBack")).toEqual([]);
    expect(framesOfKind(stream, "goForward")).toEqual([]);

    act(() => {
      stream.emit(
        { kind: "armed", hasBinaryPayload: false, armEpoch: 1 },
        null,
      );
    });
    await flushMacrotask();

    expect(framesOfKind(stream, "goBack")).toEqual([
      {
        kind: "goBack",
        hasBinaryPayload: false,
        armEpoch: 1,
        seq: 0,
      },
    ]);
    expect(framesOfKind(stream, "goForward")).toEqual([
      {
        kind: "goForward",
        hasBinaryPayload: false,
        armEpoch: 1,
        seq: 1,
      },
    ]);
  });

  it("drops a pending arm and cold nav when revoked before confirmation", async () => {
    renderPeekTile(
      <BrowserPeekTile
        scope={{ kind: "epic", epicId: "epic-1" }}
        visible={hookState.visible}
        onConvertToPip={() => {}}
        node={PEEK_NODE}
        completeMeans="ended"
      />,
    );
    const stream = liveStream();

    act(() => {
      stream.emit(
        {
          kind: "navState",
          hasBinaryPayload: false,
          url: URL_A,
          canGoBack: true,
          canGoForward: false,
          loading: false,
        },
        null,
      );
    });
    await flushMacrotask();

    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(framesOfKind(stream, "arm")).toEqual([
      { kind: "arm", hasBinaryPayload: false, armEpoch: 1 },
    ]);

    act(() => {
      stream.emit(
        {
          kind: "revoked",
          hasBinaryPayload: false,
          armEpoch: 1,
          cause: "stolen",
        },
        null,
      );
    });
    await flushMacrotask();

    act(() => {
      stream.emit(
        { kind: "armed", hasBinaryPayload: false, armEpoch: 1 },
        null,
      );
    });
    await flushMacrotask();
    expect(framesOfKind(stream, "goBack")).toEqual([]);

    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(framesOfKind(stream, "arm")).toEqual([
      { kind: "arm", hasBinaryPayload: false, armEpoch: 1 },
      { kind: "arm", hasBinaryPayload: false, armEpoch: 2 },
    ]);
  });

  it("replaces a submitted address with the next live url", () => {
    renderPeekTile(
      <BrowserPeekTile
        scope={{ kind: "epic", epicId: "epic-1" }}
        visible={hookState.visible}
        onConvertToPip={() => {}}
        node={PEEK_NODE}
        completeMeans="ended"
      />,
    );
    const stream = liveStream();

    emitNavState(stream, URL_A);
    const input = addressInput();
    fireEvent.focus(input);
    fireEvent.focusIn(input);
    fireEvent.change(input, { target: { value: DRAFT_URL } });
    const form = input.closest("form");
    if (form === null) {
      throw new Error("expected the address form");
    }
    fireEvent.submit(form);
    expect(addressInput().value).toBe(DRAFT_URL);

    emitNavState(stream, URL_B);
    expect(addressInput().value).toBe(URL_B);
  });

  it("keeps control after leaving the tile from the address bar", async () => {
    renderPeekTile(
      <BrowserPeekTile
        scope={{ kind: "epic", epicId: "epic-1" }}
        visible={hookState.visible}
        onConvertToPip={() => {}}
        node={PEEK_NODE}
        completeMeans="ended"
      />,
    );
    const stream = liveStream();
    armPeekTile(stream);
    await flushMacrotask();
    expect(useScreencastArmedStore.getState().ownerId).toBe(PEEK_OWNER_ID);

    fireEvent.focus(addressInput());
    fireEvent.blur(addressInput(), { relatedTarget: document.body });
    await flushMacrotask();

    // Focus is not ownership (ticket 20): the badge follows the arm, so it
    // stays legible across a click into the address bar and out of the tile.
    expect(useScreencastArmedStore.getState().ownerId).toBe(PEEK_OWNER_ID);
    expect(screen.getByText("Controlling")).not.toBeNull();
  });
});
