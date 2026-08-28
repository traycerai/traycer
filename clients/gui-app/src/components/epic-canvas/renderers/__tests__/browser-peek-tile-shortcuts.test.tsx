import "../../../../../__tests__/test-browser-apis";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  BrowserPeekTile,
  type BrowserPeekNode,
} from "@/components/epic-canvas/renderers/browser-peek-tile";
import {
  FakeStreamClient,
  type FakeStreamSession,
} from "@/components/epic-canvas/renderers/__tests__/browser-peek-tile-stream-fixture";
import { isMac } from "@/lib/keybindings/platform";
import { useScreencastArmedStore } from "@/stores/screencast-armed-store";

const hookState = vi.hoisted(() => ({
  streamClient: null as FakeStreamClient | null,
  visible: true,
}));

vi.mock("@/components/epic-canvas/hooks/use-tab-host-id", () => ({
  useTabHostId: () => "host-test",
}));

vi.mock("@/components/epic-canvas/hooks/use-tile-body-visible", () => ({
  useTileBodyVisible: () => hookState.visible,
}));

vi.mock("@/hooks/host/use-host-directory-entry", () => ({
  useHostDirectoryEntry: () => ({ hostId: "host-test" }),
}));

vi.mock("@/hooks/host/use-host-stream-client-for", () => ({
  useHostStreamClientFor: () => hookState.streamClient,
  authenticatedHostStreamKey: () => "authenticated-host-test",
  authenticatedOwnerIdentityKey: () => "local\u0000host-test\u0000user-test",
}));

vi.mock("@/lib/host/stream-auth-revalidator", () => ({
  useStreamAuthRevalidator: () => null,
}));

const PEEK_NODE: BrowserPeekNode = {
  id: "browser-peek-headless-1",
  instanceId: "peek-instance-1",
  hostId: "host-test",
  sessionId: "headless-1",
  tabId: "headless-tab-1",
  initialUrl: "http://localhost:3000",
};
const PEEK_OWNER_ID = [
  PEEK_NODE.hostId,
  PEEK_NODE.sessionId,
  PEEK_NODE.tabId,
  PEEK_NODE.instanceId,
].join("\u001f");

const PASTE_TEXT = "pasted from clipboard";

function liveStream(): FakeStreamSession {
  const sessions = hookState.streamClient?.sessions ?? [];
  const stream = sessions.at(-1);
  if (stream === undefined) {
    throw new Error("expected browser.screencast stream");
  }
  return stream;
}

function overlayButton(): HTMLElement {
  return screen.getByRole("button", { name: "Browser screencast controls" });
}

function imeInput(): HTMLElement {
  return screen.getByRole("textbox", { name: "Browser IME input" });
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

function keyboardFramesFor(
  stream: FakeStreamSession,
  key: string,
  code: string,
): Array<Record<string, unknown>> {
  return stream.sentFrames.filter((frame) => {
    if (frame.kind !== "keyboard") return false;
    return frame.key === key || frame.code === code;
  });
}

function platformModKeys(): {
  readonly metaKey: boolean;
  readonly ctrlKey: boolean;
} {
  if (isMac()) return { metaKey: true, ctrlKey: false };
  return { metaKey: false, ctrlKey: true };
}

function firePlatformModKey(
  target: HTMLElement,
  type: "keydown" | "keyup",
  key: string,
  code: string,
): KeyboardEvent {
  const event = new KeyboardEvent(type, {
    bubbles: true,
    cancelable: true,
    key,
    code,
    ...platformModKeys(),
  });
  target.dispatchEvent(event);
  return event;
}

function pastePlainText(target: HTMLElement, text: string): void {
  fireEvent.paste(target, {
    clipboardData: {
      files: [],
      items: [],
      types: ["text/plain"],
      getData: (type: string) => (type === "text/plain" ? text : ""),
    },
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

function clearScreencastOwner(): void {
  const store = useScreencastArmedStore.getState();
  if (store.ownerId !== null) store.release(store.ownerId);
}

describe("BrowserPeekTile shortcuts and paste", () => {
  beforeEach(() => {
    hookState.visible = true;
    hookState.streamClient = new FakeStreamClient(true);
    clearScreencastOwner();
  });

  afterEach(() => {
    cleanup();
    clearScreencastOwner();
    vi.restoreAllMocks();
  });

  it("pastes clipboard text as one insertText and suppresses V key frames", async () => {
    render(
      <BrowserPeekTile
        viewTabId="view-tab-1"
        paneId="pane-1"
        epicId="epic-1"
        node={PEEK_NODE}
      />,
    );
    const stream = liveStream();
    armPeekTile(stream);
    await flushMacrotask();

    const ime = imeInput();
    const keydown = firePlatformModKey(ime, "keydown", "v", "KeyV");
    pastePlainText(ime, PASTE_TEXT);
    firePlatformModKey(ime, "keyup", "v", "KeyV");

    expect(keydown.defaultPrevented).toBe(false);
    expect(framesOfKind(stream, "insertText")).toEqual([
      {
        kind: "insertText",
        text: PASTE_TEXT,
        hasBinaryPayload: false,
        armEpoch: 1,
        seq: 0,
      },
    ]);
    expect(keyboardFramesFor(stream, "v", "KeyV")).toEqual([]);
  });

  it("sends nothing on paste while unarmed", () => {
    render(
      <BrowserPeekTile
        viewTabId="view-tab-1"
        paneId="pane-1"
        epicId="epic-1"
        node={PEEK_NODE}
      />,
    );
    const stream = liveStream();

    pastePlainText(imeInput(), PASTE_TEXT);

    expect(framesOfKind(stream, "insertText")).toEqual([]);
    expect(framesOfKind(stream, "keyboard")).toEqual([]);
  });

  it("sends nothing on paste while hidden", async () => {
    const view = render(
      <BrowserPeekTile
        viewTabId="view-tab-1"
        paneId="pane-1"
        epicId="epic-1"
        node={PEEK_NODE}
      />,
    );
    const stream = liveStream();
    armPeekTile(stream);
    await flushMacrotask();

    hookState.visible = false;
    view.rerender(
      <BrowserPeekTile
        viewTabId="view-tab-1"
        paneId="pane-1"
        epicId="epic-1"
        node={PEEK_NODE}
      />,
    );
    await flushMacrotask();

    pastePlainText(imeInput(), PASTE_TEXT);

    expect(framesOfKind(stream, "insertText")).toEqual([]);
    expect(framesOfKind(stream, "keyboard")).toEqual([]);
  });

  it("focuses the address bar on Cmd+L without forwarding L and without disarming", async () => {
    render(
      <BrowserPeekTile
        viewTabId="view-tab-1"
        paneId="pane-1"
        epicId="epic-1"
        node={PEEK_NODE}
      />,
    );
    const stream = liveStream();
    armPeekTile(stream);
    await flushMacrotask();

    expect(document.activeElement).toBe(imeInput());

    firePlatformModKey(imeInput(), "keydown", "l", "KeyL");
    firePlatformModKey(imeInput(), "keyup", "l", "KeyL");

    expect(document.activeElement).toBe(addressInput());
    expect(document.activeElement).not.toBe(imeInput());
    expect(screen.getByText("Controlling")).not.toBeNull();
    expect(useScreencastArmedStore.getState().ownerId).toBe(PEEK_OWNER_ID);
    expect(keyboardFramesFor(stream, "l", "KeyL")).toEqual([]);
  });

  it("reloads on Cmd+R without forwarding R", async () => {
    render(
      <BrowserPeekTile
        viewTabId="view-tab-1"
        paneId="pane-1"
        epicId="epic-1"
        node={PEEK_NODE}
      />,
    );
    const stream = liveStream();
    armPeekTile(stream);
    await flushMacrotask();

    firePlatformModKey(imeInput(), "keydown", "r", "KeyR");
    fireEvent.keyUp(imeInput(), { key: "r", code: "KeyR" });

    expect(framesOfKind(stream, "reload")).toEqual([
      {
        kind: "reload",
        hasBinaryPayload: false,
        armEpoch: 1,
        seq: 0,
      },
    ]);
    expect(keyboardFramesFor(stream, "r", "KeyR")).toEqual([]);
  });

  it("still forwards Cmd+C as a rawKeyDown keyboard frame", async () => {
    render(
      <BrowserPeekTile
        viewTabId="view-tab-1"
        paneId="pane-1"
        epicId="epic-1"
        node={PEEK_NODE}
      />,
    );
    const stream = liveStream();
    armPeekTile(stream);
    await flushMacrotask();

    firePlatformModKey(imeInput(), "keydown", "c", "KeyC");

    expect(framesOfKind(stream, "keyboard")).toEqual([
      expect.objectContaining({
        kind: "keyboard",
        type: "rawKeyDown",
        key: "c",
        code: "KeyC",
        seq: 0,
      }),
    ]);
  });

  it("does not forward an orphan keyup the tile did not press", async () => {
    render(
      <BrowserPeekTile
        viewTabId="view-tab-1"
        paneId="pane-1"
        epicId="epic-1"
        node={PEEK_NODE}
      />,
    );
    const stream = liveStream();
    armPeekTile(stream);
    await flushMacrotask();

    const keyup = fireEvent.keyUp(imeInput(), { key: "q", code: "KeyQ" });

    expect(keyup).toBe(true);
    expect(keyboardFramesFor(stream, "q", "KeyQ")).toEqual([]);
  });

  it("clears the armed flag when the server revokes the arm", async () => {
    render(
      <BrowserPeekTile
        viewTabId="view-tab-1"
        paneId="pane-1"
        epicId="epic-1"
        node={PEEK_NODE}
      />,
    );
    const stream = liveStream();
    armPeekTile(stream);
    await flushMacrotask();
    expect(useScreencastArmedStore.getState().ownerId).toBe(PEEK_OWNER_ID);

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

    expect(useScreencastArmedStore.getState().ownerId).toBeNull();
  });

  it("clears the armed flag when the tile is hidden", async () => {
    const view = render(
      <BrowserPeekTile
        viewTabId="view-tab-1"
        paneId="pane-1"
        epicId="epic-1"
        node={PEEK_NODE}
      />,
    );
    const stream = liveStream();
    armPeekTile(stream);
    await flushMacrotask();
    expect(useScreencastArmedStore.getState().ownerId).toBe(PEEK_OWNER_ID);

    hookState.visible = false;
    view.rerender(
      <BrowserPeekTile
        viewTabId="view-tab-1"
        paneId="pane-1"
        epicId="epic-1"
        node={PEEK_NODE}
      />,
    );
    await flushMacrotask();

    expect(useScreencastArmedStore.getState().ownerId).toBeNull();
  });

  it("clears the armed flag when Release control is clicked", async () => {
    render(
      <BrowserPeekTile
        viewTabId="view-tab-1"
        paneId="pane-1"
        epicId="epic-1"
        node={PEEK_NODE}
      />,
    );
    const stream = liveStream();
    armPeekTile(stream);
    await flushMacrotask();
    expect(useScreencastArmedStore.getState().ownerId).toBe(PEEK_OWNER_ID);

    fireEvent.click(screen.getByRole("button", { name: "Release control" }));
    await flushMacrotask();

    expect(useScreencastArmedStore.getState().ownerId).toBeNull();
  });

  it("clears the armed flag on Escape-free blur out of the tile", async () => {
    render(
      <BrowserPeekTile
        viewTabId="view-tab-1"
        paneId="pane-1"
        epicId="epic-1"
        node={PEEK_NODE}
      />,
    );
    const stream = liveStream();
    armPeekTile(stream);
    await flushMacrotask();
    expect(useScreencastArmedStore.getState().ownerId).toBe(PEEK_OWNER_ID);

    fireEvent.blur(imeInput(), { relatedTarget: document.body });
    await flushMacrotask();

    expect(useScreencastArmedStore.getState().ownerId).toBeNull();
  });

  it("does not preventDefault the V keydown of a paste chord", async () => {
    render(
      <BrowserPeekTile
        viewTabId="view-tab-1"
        paneId="pane-1"
        epicId="epic-1"
        node={PEEK_NODE}
      />,
    );
    const stream = liveStream();
    armPeekTile(stream);
    await flushMacrotask();

    const keydown = firePlatformModKey(imeInput(), "keydown", "v", "KeyV");
    expect(keydown.defaultPrevented).toBe(false);
    expect(keyboardFramesFor(stream, "v", "KeyV")).toEqual([]);
  });

  it("suppresses the V keyup after the modifier is released first", async () => {
    render(
      <BrowserPeekTile
        viewTabId="view-tab-1"
        paneId="pane-1"
        epicId="epic-1"
        node={PEEK_NODE}
      />,
    );
    const stream = liveStream();
    armPeekTile(stream);
    await flushMacrotask();

    firePlatformModKey(imeInput(), "keydown", "v", "KeyV");
    fireEvent.keyUp(imeInput(), { key: "v", code: "KeyV" });

    expect(keyboardFramesFor(stream, "v", "KeyV")).toEqual([]);
  });

  it("releases forwarded page keys when the address bar takes focus", async () => {
    render(
      <BrowserPeekTile
        viewTabId="view-tab-1"
        paneId="pane-1"
        epicId="epic-1"
        node={PEEK_NODE}
      />,
    );
    const stream = liveStream();
    armPeekTile(stream);
    await flushMacrotask();

    fireEvent.keyDown(imeInput(), { key: "a", code: "KeyA" });
    expect(keyboardFramesFor(stream, "a", "KeyA")).toEqual([
      expect.objectContaining({
        type: "rawKeyDown",
        key: "a",
        code: "KeyA",
      }),
      expect.objectContaining({
        type: "char",
        key: "a",
        code: "KeyA",
      }),
    ]);

    fireEvent.focus(addressInput());
    fireEvent.focusIn(addressInput());
    await flushMacrotask();

    expect(keyboardFramesFor(stream, "a", "KeyA")).toEqual([
      expect.objectContaining({ type: "rawKeyDown", code: "KeyA" }),
      expect.objectContaining({ type: "char", code: "KeyA" }),
      expect.objectContaining({ type: "keyUp", code: "KeyA", seq: 2 }),
    ]);
  });

  it("selects the address on Cmd+L even when it is already focused", async () => {
    render(
      <BrowserPeekTile
        viewTabId="view-tab-1"
        paneId="pane-1"
        epicId="epic-1"
        node={PEEK_NODE}
      />,
    );
    const stream = liveStream();
    armPeekTile(stream);
    await flushMacrotask();

    const input = addressInput();
    fireEvent.focus(input);
    fireEvent.focusIn(input);
    input.setSelectionRange(1, 1);
    expect(input.selectionStart).toBe(1);

    firePlatformModKey(input, "keydown", "l", "KeyL");
    expect(document.activeElement).toBe(input);
    expect(input.selectionStart).toBe(0);
    expect(input.selectionEnd).toBe(input.value.length);
  });

  it("clears the armed flag on a failed stream frame", async () => {
    render(
      <BrowserPeekTile
        viewTabId="view-tab-1"
        paneId="pane-1"
        epicId="epic-1"
        node={PEEK_NODE}
      />,
    );
    const stream = liveStream();
    armPeekTile(stream);
    await flushMacrotask();
    expect(useScreencastArmedStore.getState().ownerId).toBe(PEEK_OWNER_ID);

    act(() => {
      stream.emit(
        {
          kind: "failed",
          hasBinaryPayload: false,
          reason: "session gone",
        },
        null,
      );
    });
    await flushMacrotask();

    expect(useScreencastArmedStore.getState().ownerId).toBeNull();
    expect(screen.queryByText("Controlling")).toBeNull();
  });

  it("clears the armed flag on a complete stream frame", async () => {
    render(
      <BrowserPeekTile
        viewTabId="view-tab-1"
        paneId="pane-1"
        epicId="epic-1"
        node={PEEK_NODE}
      />,
    );
    const stream = liveStream();
    armPeekTile(stream);
    await flushMacrotask();
    expect(useScreencastArmedStore.getState().ownerId).toBe(PEEK_OWNER_ID);

    act(() => {
      stream.emit({ kind: "complete", hasBinaryPayload: false }, null);
    });
    await flushMacrotask();

    expect(useScreencastArmedStore.getState().ownerId).toBeNull();
    expect(screen.queryByText("Controlling")).toBeNull();
  });

  it("does not let an unarmed sibling tile clear another tile's armed flag", async () => {
    const sibling: BrowserPeekNode = {
      ...PEEK_NODE,
      instanceId: "peek-instance-2",
      tabId: "headless-tab-2",
    };
    const view = render(
      <div>
        <BrowserPeekTile
          viewTabId="view-tab-1"
          paneId="pane-1"
          epicId="epic-1"
          node={PEEK_NODE}
        />
      </div>,
    );
    const client = hookState.streamClient;
    if (client === null) {
      throw new Error("expected a stream client");
    }
    const armedStream = client.sessions[0];
    const firstOverlay = screen
      .getByTestId(`browser-peek-tile-${PEEK_NODE.instanceId}`)
      .querySelector('[aria-label="Browser screencast controls"]');
    if (!(firstOverlay instanceof HTMLElement)) {
      throw new Error("expected the first overlay");
    }
    fireEvent.focus(firstOverlay);
    act(() => {
      armedStream.emit(
        { kind: "armed", hasBinaryPayload: false, armEpoch: 1 },
        null,
      );
    });
    await flushMacrotask();
    expect(useScreencastArmedStore.getState().ownerId).toBe(PEEK_OWNER_ID);

    view.rerender(
      <div>
        <BrowserPeekTile
          viewTabId="view-tab-1"
          paneId="pane-1"
          epicId="epic-1"
          node={PEEK_NODE}
        />
        <BrowserPeekTile
          viewTabId="view-tab-1"
          paneId="pane-1"
          epicId="epic-1"
          node={sibling}
        />
      </div>,
    );
    await flushMacrotask();
    expect(useScreencastArmedStore.getState().ownerId).toBe(PEEK_OWNER_ID);

    view.rerender(
      <div>
        <BrowserPeekTile
          viewTabId="view-tab-1"
          paneId="pane-1"
          epicId="epic-1"
          node={PEEK_NODE}
        />
      </div>,
    );
    await flushMacrotask();
    expect(useScreencastArmedStore.getState().ownerId).toBe(PEEK_OWNER_ID);
    expect(screen.getByText("Controlling")).not.toBeNull();
  });
});
