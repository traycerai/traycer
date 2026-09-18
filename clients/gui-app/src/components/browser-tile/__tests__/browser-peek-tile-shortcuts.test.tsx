import "../../../../__tests__/test-browser-apis";
import type { ReactElement } from "react";
import {
  act,
  cleanup,
  fireEvent,
  screen,
  waitFor,
  type RenderResult,
} from "@testing-library/react";
import { createMemoryHistory } from "@tanstack/react-router";
import { renderPeekTile } from "@/components/browser-tile/__tests__/browser-peek-tile-render";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  FakeStreamClient,
  PEEK_NODE,
  clearScreencastOwner,
  hostDirectoryEntryModule,
  hostStreamClientForWithAuthModule,
  liveStream as fixtureLiveStream,
  registeredHostsModule,
  streamAuthRevalidatorModule,
  tabHostIdModule,
  runnerOpenExternalLinkModule,
  tileRoleRunnerHostModule,
  type FakeStreamSession,
} from "@/components/browser-tile/__tests__/browser-peek-tile-stream-fixture";
import {
  BrowserPeekTile,
  type BrowserPeekNode,
} from "@/components/browser-tile/browser-peek-tile";
import { isMac } from "@/lib/keybindings/platform";
import { useScreencastArmedStore } from "@/stores/screencast-armed-store";
import { DEFAULT_BROWSER_TILE_URL } from "@/lib/browser-view/browser-tile-defaults";
// Imported after the fixture above, not just textually but in evaluation
// order: `KeybindingProvider`'s module graph reaches the real
// `@/providers/use-runner-host` (through `host-runtime-provider.tsx`), which
// this file's `vi.mock` intercepts with a factory that calls
// `tileRoleRunnerHostModule()`. That factory only runs the first time
// something actually imports the mocked specifier - if this import ran
// earlier than the fixture import above, it would trigger the factory before
// `tileRoleRunnerHostModule` was initialized and crash with a TDZ error.
import { KeybindingProvider } from "@/providers/keybinding-provider";
import type { KeybindingRouterSource } from "@/lib/keybindings/router-adapter";

/**
 * Just enough of the host boundary for `<BrowserStartPage>` to render for
 * real (`resources.listLocalServers`) - the same three-mock recipe
 * `browser-start-page.test.tsx` uses, so the "return to the real about:blank
 * start page" tests below reproduce the actual bug surface instead of
 * standing in for it with a blur.
 */
const startPageClient = vi.hoisted(() => ({
  requestWithSignal: (method: string) => {
    if (method !== "resources.listLocalServers") {
      return Promise.reject(new Error(`unexpected method ${method}`));
    }
    return Promise.resolve({ servers: [] });
  },
  getActiveHostId: () => "host-test",
}));

vi.mock("@/hooks/host/use-host-client-for-host-id", () => ({
  useHostClientForHostId: () => ({
    requestWithSignal: startPageClient.requestWithSignal,
    request: startPageClient.requestWithSignal,
    requestWithResponseTimeout: startPageClient.requestWithSignal,
    getActiveHostId: startPageClient.getActiveHostId,
  }),
  useHostDirectoryEntryForHostId: () => ({ kind: "local" }),
}));

vi.mock("@/hooks/host/use-reactive-host-readiness", () => ({
  useReactiveHostReadiness: () => ({ canExecute: true, hostId: "host-test" }),
}));

const hookState = vi.hoisted(() => ({
  streamClient: null as FakeStreamClient | null,
  visible: true,
}));

vi.mock("@/providers/use-runner-host", () => tileRoleRunnerHostModule());

vi.mock("@/hooks/runner/use-open-external-link-mutation", () =>
  runnerOpenExternalLinkModule(),
);

vi.mock("@/components/epic-canvas/hooks/use-tab-host-id", () =>
  tabHostIdModule(),
);

vi.mock("@/hooks/host/use-host-directory-entry", () =>
  hostDirectoryEntryModule(),
);

// use-screencast-session.ts's hostIsMac derivation falls through to this
// hook once useHostDirectoryEntry answers no `kind`. Pinned to `data: null`
// (no registered hosts) so hostIsMac deterministically resolves to `null`
// ("host platform unknown") for the undo/redo wire-shape assertions below,
// rather than depending on the real TanStack Query hook's disabled-query
// default settling the same way.
vi.mock("@/hooks/auth/use-registered-hosts-query", () =>
  registeredHostsModule(),
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

const PASTE_TEXT = "pasted from clipboard";

function liveStream(): FakeStreamSession {
  return fixtureLiveStream(hookState);
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

function buildProviderRouterSource(
  initialPathname: string,
): KeybindingRouterSource {
  const history = createMemoryHistory({ initialEntries: [initialPathname] });
  const navigate: KeybindingRouterSource["navigate"] = () => Promise.resolve();
  return {
    get state() {
      return { location: { pathname: history.location.pathname } };
    },
    history,
    navigate,
  };
}

/**
 * Dispatched on the actual focused element (never bare `window`): a real
 * keydown originates at `document.activeElement` and bubbles up through the
 * capture phase to the window listener `KeybindingProvider` installs, and
 * `focusBrowserAddressForShortcut` reads `event.target` / `composedPath()` to
 * decide whether that origin counts as "inside the tile" or "editable" - a
 * window-targeted event answers neither question the way a real one would.
 */
function dispatchTargetKey(
  target: EventTarget,
  type: "keydown" | "keyup",
  init: KeyboardEventInit,
): KeyboardEvent {
  const event = new KeyboardEvent(type, {
    bubbles: true,
    cancelable: true,
    ...init,
  });
  target.dispatchEvent(event);
  return event;
}

/** Same tile render, plus the real app-wide keydown listener this suite's own tests bypass by dispatching straight on the IME input. */
function renderPeekTileWithProvider(
  router: KeybindingRouterSource,
  ui: ReactElement,
): RenderResult {
  return renderPeekTile(
    <KeybindingProvider router={router}>{ui}</KeybindingProvider>,
  );
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
    renderPeekTile(
      <BrowserPeekTile
        scope={{ kind: "epic", epicId: "epic-1" }}
        visible={hookState.visible}
        onConvertToPip={() => {}}
        onRequestNewTab={null}
        onRequestCloseTab={null}
        node={PEEK_NODE}
        completeMeans="ended"
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
    renderPeekTile(
      <BrowserPeekTile
        scope={{ kind: "epic", epicId: "epic-1" }}
        visible={hookState.visible}
        onConvertToPip={() => {}}
        onRequestNewTab={null}
        onRequestCloseTab={null}
        node={PEEK_NODE}
        completeMeans="ended"
      />,
    );
    const stream = liveStream();

    pastePlainText(imeInput(), PASTE_TEXT);

    expect(framesOfKind(stream, "insertText")).toEqual([]);
    expect(framesOfKind(stream, "keyboard")).toEqual([]);
  });

  it("sends nothing on paste while hidden", async () => {
    const view = renderPeekTile(
      <BrowserPeekTile
        scope={{ kind: "epic", epicId: "epic-1" }}
        visible={hookState.visible}
        onConvertToPip={() => {}}
        onRequestNewTab={null}
        onRequestCloseTab={null}
        node={PEEK_NODE}
        completeMeans="ended"
      />,
    );
    const stream = liveStream();
    armPeekTile(stream);
    await flushMacrotask();

    hookState.visible = false;
    view.rerender(
      <BrowserPeekTile
        scope={{ kind: "epic", epicId: "epic-1" }}
        visible={hookState.visible}
        onConvertToPip={() => {}}
        onRequestNewTab={null}
        onRequestCloseTab={null}
        node={PEEK_NODE}
        completeMeans="ended"
      />,
    );
    await flushMacrotask();

    pastePlainText(imeInput(), PASTE_TEXT);

    expect(framesOfKind(stream, "insertText")).toEqual([]);
    expect(framesOfKind(stream, "keyboard")).toEqual([]);
  });

  it("focuses the address bar on Cmd+L without forwarding L and without disarming", async () => {
    renderPeekTile(
      <BrowserPeekTile
        scope={{ kind: "epic", epicId: "epic-1" }}
        visible={hookState.visible}
        onConvertToPip={() => {}}
        onRequestNewTab={null}
        onRequestCloseTab={null}
        node={PEEK_NODE}
        completeMeans="ended"
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

  // The streamed twin of the `newTab` row in `reserved-chords-registration.ts`.
  // A native tile gets that chord from main; a streamed one has no main in its
  // path, and while a tile is armed the app's own keybinding registry skips
  // every action (`keybinding-provider.tsx`) - so unclaimed here, Cmd+T is
  // forwarded to the remote page and the surface's chooser never opens.
  it("asks the hosting surface for a new tab on Cmd+T without forwarding T", async () => {
    const onRequestNewTab = vi.fn<() => void>();
    renderPeekTile(
      <BrowserPeekTile
        scope={{ kind: "independent" }}
        visible={hookState.visible}
        onConvertToPip={() => {}}
        onRequestNewTab={onRequestNewTab}
        onRequestCloseTab={null}
        node={PEEK_NODE}
        completeMeans="ended"
      />,
    );
    const stream = liveStream();
    armPeekTile(stream);
    await flushMacrotask();

    firePlatformModKey(imeInput(), "keydown", "t", "KeyT");
    firePlatformModKey(imeInput(), "keyup", "t", "KeyT");

    expect(onRequestNewTab).toHaveBeenCalledOnce();
    expect(keyboardFramesFor(stream, "t", "KeyT")).toEqual([]);
  });

  // The canvas passes `null` the whole way down and must NOT gain the panel's
  // chooser. A surface with no answer claims nothing, so the page keeps its
  // own Cmd+T - the same split the native tile makes when `onRequestNewTab` is
  // null.
  it("forwards Cmd+T to the page when the surface has no new-tab answer", async () => {
    renderPeekTile(
      <BrowserPeekTile
        scope={{ kind: "epic", epicId: "epic-1" }}
        visible={hookState.visible}
        onConvertToPip={() => {}}
        onRequestNewTab={null}
        onRequestCloseTab={null}
        node={PEEK_NODE}
        completeMeans="ended"
      />,
    );
    const stream = liveStream();
    armPeekTile(stream);
    await flushMacrotask();

    firePlatformModKey(imeInput(), "keydown", "t", "KeyT");

    expect(keyboardFramesFor(stream, "t", "KeyT")).not.toEqual([]);
  });

  // The `closeTab` row's streamed half. Same three facts as Cmd+T: an armed
  // tile suppresses the app registry, the controller claimed neither chord,
  // and everything unclaimed is typed at the remote page - so the row was
  // never closed and the page received a W.
  it("closes the landing row on Cmd+W without forwarding W", async () => {
    const onRequestCloseTab = vi.fn<() => void>();
    renderPeekTile(
      <BrowserPeekTile
        scope={{ kind: "independent" }}
        visible={hookState.visible}
        onConvertToPip={() => {}}
        onRequestNewTab={null}
        onRequestCloseTab={onRequestCloseTab}
        node={PEEK_NODE}
        completeMeans="ended"
      />,
    );
    const stream = liveStream();
    armPeekTile(stream);
    await flushMacrotask();

    firePlatformModKey(imeInput(), "keydown", "w", "KeyW");
    firePlatformModKey(imeInput(), "keyup", "w", "KeyW");

    expect(onRequestCloseTab).toHaveBeenCalledOnce();
    expect(keyboardFramesFor(stream, "w", "KeyW")).toEqual([]);
  });

  /**
   * The same physical position the row-close test above uses, but on a
   * layout where it produces `z` instead of `w`.
   *
   * AZERTY reports `key: "z"` for `code: "KeyW"`. The streamed matcher
   * compares physical `code` for `mod+w`, so before `isTextHistoryShortcut`
   * existed this WAS the close-tab chord and closed the row - on an AZERTY
   * keyboard, that is also the reader's mod+Z undo. Editing conventions now
   * win over physical browser chords (`handleTileKeyDown`'s guard), so this
   * must be left to the page as undo instead, not claimed as close-tab.
   */
  it("leaves mod+Z to the page as undo, even at the physical close-tab position, on a non-US layout", async () => {
    const onRequestCloseTab = vi.fn<() => void>();
    renderPeekTile(
      <BrowserPeekTile
        scope={{ kind: "independent" }}
        visible={hookState.visible}
        onConvertToPip={() => {}}
        onRequestNewTab={null}
        onRequestCloseTab={onRequestCloseTab}
        node={PEEK_NODE}
        completeMeans="ended"
      />,
    );
    const stream = liveStream();
    armPeekTile(stream);
    await flushMacrotask();

    firePlatformModKey(imeInput(), "keydown", "z", "KeyW");
    firePlatformModKey(imeInput(), "keyup", "z", "KeyW");

    expect(onRequestCloseTab).not.toHaveBeenCalled();
    expect(keyboardFramesFor(stream, "z", "KeyW")).not.toEqual([]);
  });

  /**
   * And the other half of the same layout: the key that PRODUCES a `w` is
   * physically `KeyZ`, which is not this chord and must reach the page.
   *
   * Without it a matcher that merely swapped one character comparison for
   * another would pass the case above.
   */
  it("leaves the key that merely produces a w to the page on a non-US layout", async () => {
    const onRequestCloseTab = vi.fn<() => void>();
    renderPeekTile(
      <BrowserPeekTile
        scope={{ kind: "independent" }}
        visible={hookState.visible}
        onConvertToPip={() => {}}
        onRequestNewTab={null}
        onRequestCloseTab={onRequestCloseTab}
        node={PEEK_NODE}
        completeMeans="ended"
      />,
    );
    const stream = liveStream();
    armPeekTile(stream);
    await flushMacrotask();

    firePlatformModKey(imeInput(), "keydown", "w", "KeyZ");
    firePlatformModKey(imeInput(), "keyup", "w", "KeyZ");

    expect(onRequestCloseTab).not.toHaveBeenCalled();
    expect(keyboardFramesFor(stream, "w", "KeyZ")).not.toEqual([]);
  });

  /**
   * The baseline, no-layout-collision case for the same guard: on a US
   * layout, mod+Z/mod+Shift+Z are not registered chords at all today, but
   * `handleTileKeyDown` now checks `isTextHistoryShortcut` before any chord
   * lookup, so this pins that undo/redo reach the page even if a future
   * chord were ever registered on that letter.
   */
  it("forwards mod+Z and mod+Shift+Z (undo/redo) to the page as distinct down/up frames", async () => {
    // `useRegisteredHosts` is pinned to no registered hosts by this file's
    // mocks, so `hostIsMac` resolves to `null` ("host platform unknown") and
    // `screencastHistoryKey` passes the event through unmodified rather than
    // translating it - the frames below carry the event's own key/modifiers
    // verbatim. A weaker "some frame for key z went out" assertion would
    // pass even if the redo (Shift) frame were silently dropped, since the
    // plain undo keydown/keyup alone already satisfy it - this checks each
    // frame individually, including the Shift bit that distinguishes redo
    // from undo.
    renderPeekTile(
      <BrowserPeekTile
        scope={{ kind: "independent" }}
        visible={hookState.visible}
        onConvertToPip={() => {}}
        onRequestNewTab={null}
        onRequestCloseTab={null}
        node={PEEK_NODE}
        completeMeans="ended"
      />,
    );
    const stream = liveStream();
    armPeekTile(stream);
    await flushMacrotask();

    const mods = platformModKeys();
    const baseModifiers = (mods.metaKey ? 4 : 2) as number;

    firePlatformModKey(imeInput(), "keydown", "z", "KeyZ");
    firePlatformModKey(imeInput(), "keyup", "z", "KeyZ");
    fireEvent.keyDown(imeInput(), {
      key: "Z",
      code: "KeyZ",
      shiftKey: true,
      ...mods,
    });

    const frames = framesOfKind(stream, "keyboard");
    expect(frames).toMatchObject([
      { type: "rawKeyDown", key: "z", code: "KeyZ", modifiers: baseModifiers },
      { type: "keyUp", key: "z", code: "KeyZ", modifiers: baseModifiers },
      {
        type: "rawKeyDown",
        key: "Z",
        code: "KeyZ",
        modifiers: baseModifiers | 8,
      },
    ]);
  });

  /**
   * A keystroke whose `code` names no key we have a token for still matches on
   * its character.
   *
   * `code` is empty for a synthesised or IME-composed event, and the native
   * guest matcher keeps the same fallback for the same reason: a code we cannot
   * normalise is better matched loosely than not at all, since the alternative
   * is a reader whose close chord silently does nothing. Pinned because a
   * mutation that dropped the fallback passed every other test here.
   */
  it("still matches the close chord when the event carries no usable code", async () => {
    const onRequestCloseTab = vi.fn<() => void>();
    renderPeekTile(
      <BrowserPeekTile
        scope={{ kind: "independent" }}
        visible={hookState.visible}
        onConvertToPip={() => {}}
        onRequestNewTab={null}
        onRequestCloseTab={onRequestCloseTab}
        node={PEEK_NODE}
        completeMeans="ended"
      />,
    );
    const stream = liveStream();
    armPeekTile(stream);
    await flushMacrotask();

    firePlatformModKey(imeInput(), "keydown", "w", "");
    firePlatformModKey(imeInput(), "keyup", "w", "");

    expect(onRequestCloseTab).toHaveBeenCalledOnce();
  });

  // The canvas viewer owns no row and retires no tile of its own, so it hands
  // the controller nothing to claim with and the page keeps its own Cmd+W.
  it("forwards Cmd+W to the page when the surface has no close answer", async () => {
    renderPeekTile(
      <BrowserPeekTile
        scope={{ kind: "epic", epicId: "epic-1" }}
        visible={hookState.visible}
        onConvertToPip={() => {}}
        onRequestNewTab={null}
        onRequestCloseTab={null}
        node={PEEK_NODE}
        completeMeans="ended"
      />,
    );
    const stream = liveStream();
    armPeekTile(stream);
    await flushMacrotask();

    firePlatformModKey(imeInput(), "keydown", "w", "KeyW");

    expect(keyboardFramesFor(stream, "w", "KeyW")).not.toEqual([]);
  });

  // The close retires the row, which unmounts this tile mid-keystroke. The
  // armed claim is what suppresses the whole app keybinding registry
  // (`skipAppActions`), so a claim that outlived its tile would leave the app
  // deaf to every chord with nothing on screen to explain it.
  it("releases the armed gate when the Cmd+W close retires the row", async () => {
    const view = renderPeekTile(
      <BrowserPeekTile
        scope={{ kind: "independent" }}
        visible={hookState.visible}
        onConvertToPip={() => {}}
        onRequestNewTab={null}
        onRequestCloseTab={() => {
          view.unmount();
        }}
        node={PEEK_NODE}
        completeMeans="ended"
      />,
    );
    const stream = liveStream();
    armPeekTile(stream);
    await flushMacrotask();
    expect(useScreencastArmedStore.getState().ownerId).toBe(PEEK_OWNER_ID);

    firePlatformModKey(imeInput(), "keydown", "w", "KeyW");
    await flushMacrotask();

    expect(useScreencastArmedStore.getState().ownerId).toBeNull();
  });

  it("reloads on Cmd+R without forwarding R", async () => {
    renderPeekTile(
      <BrowserPeekTile
        scope={{ kind: "epic", epicId: "epic-1" }}
        visible={hookState.visible}
        onConvertToPip={() => {}}
        onRequestNewTab={null}
        onRequestCloseTab={null}
        node={PEEK_NODE}
        completeMeans="ended"
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
    renderPeekTile(
      <BrowserPeekTile
        scope={{ kind: "epic", epicId: "epic-1" }}
        visible={hookState.visible}
        onConvertToPip={() => {}}
        onRequestNewTab={null}
        onRequestCloseTab={null}
        node={PEEK_NODE}
        completeMeans="ended"
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
    renderPeekTile(
      <BrowserPeekTile
        scope={{ kind: "epic", epicId: "epic-1" }}
        visible={hookState.visible}
        onConvertToPip={() => {}}
        onRequestNewTab={null}
        onRequestCloseTab={null}
        node={PEEK_NODE}
        completeMeans="ended"
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
    renderPeekTile(
      <BrowserPeekTile
        scope={{ kind: "epic", epicId: "epic-1" }}
        visible={hookState.visible}
        onConvertToPip={() => {}}
        onRequestNewTab={null}
        onRequestCloseTab={null}
        node={PEEK_NODE}
        completeMeans="ended"
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
    const view = renderPeekTile(
      <BrowserPeekTile
        scope={{ kind: "epic", epicId: "epic-1" }}
        visible={hookState.visible}
        onConvertToPip={() => {}}
        onRequestNewTab={null}
        onRequestCloseTab={null}
        node={PEEK_NODE}
        completeMeans="ended"
      />,
    );
    const stream = liveStream();
    armPeekTile(stream);
    await flushMacrotask();
    expect(useScreencastArmedStore.getState().ownerId).toBe(PEEK_OWNER_ID);

    hookState.visible = false;
    view.rerender(
      <BrowserPeekTile
        scope={{ kind: "epic", epicId: "epic-1" }}
        visible={hookState.visible}
        onConvertToPip={() => {}}
        onRequestNewTab={null}
        onRequestCloseTab={null}
        node={PEEK_NODE}
        completeMeans="ended"
      />,
    );
    await flushMacrotask();

    expect(useScreencastArmedStore.getState().ownerId).toBeNull();
  });

  it("clears the armed flag when Release control is clicked", async () => {
    renderPeekTile(
      <BrowserPeekTile
        scope={{ kind: "epic", epicId: "epic-1" }}
        visible={hookState.visible}
        onConvertToPip={() => {}}
        onRequestNewTab={null}
        onRequestCloseTab={null}
        node={PEEK_NODE}
        completeMeans="ended"
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

  it("keeps control across a blur out of the tile", async () => {
    renderPeekTile(
      <BrowserPeekTile
        scope={{ kind: "epic", epicId: "epic-1" }}
        visible={hookState.visible}
        onConvertToPip={() => {}}
        onRequestNewTab={null}
        onRequestCloseTab={null}
        node={PEEK_NODE}
        completeMeans="ended"
      />,
    );
    const stream = liveStream();
    armPeekTile(stream);
    await flushMacrotask();
    expect(useScreencastArmedStore.getState().ownerId).toBe(PEEK_OWNER_ID);

    fireEvent.blur(imeInput(), { relatedTarget: document.body });
    await flushMacrotask();

    // Focus is not ownership: release is explicit (the Release button above),
    // or a steal, a hidden tile, or a dead transport - never a click away.
    expect(useScreencastArmedStore.getState().ownerId).toBe(PEEK_OWNER_ID);
    expect(framesOfKind(stream, "disarm")).toEqual([]);
    // The badge reads arm state, not focus state.
    expect(screen.getByText("Controlling")).not.toBeNull();
  });

  it("does not preventDefault the V keydown of a paste chord", async () => {
    renderPeekTile(
      <BrowserPeekTile
        scope={{ kind: "epic", epicId: "epic-1" }}
        visible={hookState.visible}
        onConvertToPip={() => {}}
        onRequestNewTab={null}
        onRequestCloseTab={null}
        node={PEEK_NODE}
        completeMeans="ended"
      />,
    );
    const stream = liveStream();
    armPeekTile(stream);
    await flushMacrotask();

    const keydown = firePlatformModKey(imeInput(), "keydown", "v", "KeyV");
    expect(keydown.defaultPrevented).toBe(false);
    expect(keyboardFramesFor(stream, "v", "KeyV")).toEqual([]);
  });

  it("leaves paste to the browser on a layout that moves V elsewhere", async () => {
    // The one screencast chord that is deliberately NOT physical. A
    // Dvorak-style layout puts V on the QWERTY period key, so the paste chord
    // arrives as key "v" / code "Period". Matching that physically would fail,
    // fall through to preventDefault, and forward the chord to the page as a
    // rawKeyDown - suppressing the native paste this handler exists to allow.
    renderPeekTile(
      <BrowserPeekTile
        scope={{ kind: "epic", epicId: "epic-1" }}
        visible={hookState.visible}
        onConvertToPip={() => {}}
        onRequestNewTab={null}
        onRequestCloseTab={null}
        node={PEEK_NODE}
        completeMeans="ended"
      />,
    );
    const stream = liveStream();
    armPeekTile(stream);
    await flushMacrotask();

    const keydown = firePlatformModKey(imeInput(), "keydown", "v", "Period");

    expect(keydown.defaultPrevented).toBe(false);
    expect(keyboardFramesFor(stream, "v", "Period")).toEqual([]);
  });

  it("does not treat the physical V position as paste when it types another character", async () => {
    // The other half of the same layout, and the reason this matcher reads the
    // character rather than merely reading loosely: on that layout code "KeyV"
    // produces ".", which is not a paste and must be forwarded like any key.
    renderPeekTile(
      <BrowserPeekTile
        scope={{ kind: "epic", epicId: "epic-1" }}
        visible={hookState.visible}
        onConvertToPip={() => {}}
        onRequestNewTab={null}
        onRequestCloseTab={null}
        node={PEEK_NODE}
        completeMeans="ended"
      />,
    );
    const stream = liveStream();
    armPeekTile(stream);
    await flushMacrotask();

    const keydown = firePlatformModKey(imeInput(), "keydown", ".", "KeyV");

    expect(keydown.defaultPrevented).toBe(true);
    expect(keyboardFramesFor(stream, ".", "KeyV")).toEqual([
      expect.objectContaining({ type: "rawKeyDown", key: ".", code: "KeyV" }),
    ]);
  });

  it("suppresses the V keyup after the modifier is released first", async () => {
    renderPeekTile(
      <BrowserPeekTile
        scope={{ kind: "epic", epicId: "epic-1" }}
        visible={hookState.visible}
        onConvertToPip={() => {}}
        onRequestNewTab={null}
        onRequestCloseTab={null}
        node={PEEK_NODE}
        completeMeans="ended"
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
    renderPeekTile(
      <BrowserPeekTile
        scope={{ kind: "epic", epicId: "epic-1" }}
        visible={hookState.visible}
        onConvertToPip={() => {}}
        onRequestNewTab={null}
        onRequestCloseTab={null}
        node={PEEK_NODE}
        completeMeans="ended"
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
    renderPeekTile(
      <BrowserPeekTile
        scope={{ kind: "epic", epicId: "epic-1" }}
        visible={hookState.visible}
        onConvertToPip={() => {}}
        onRequestNewTab={null}
        onRequestCloseTab={null}
        node={PEEK_NODE}
        completeMeans="ended"
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
    renderPeekTile(
      <BrowserPeekTile
        scope={{ kind: "epic", epicId: "epic-1" }}
        visible={hookState.visible}
        onConvertToPip={() => {}}
        onRequestNewTab={null}
        onRequestCloseTab={null}
        node={PEEK_NODE}
        completeMeans="ended"
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
    renderPeekTile(
      <BrowserPeekTile
        scope={{ kind: "epic", epicId: "epic-1" }}
        visible={hookState.visible}
        onConvertToPip={() => {}}
        onRequestNewTab={null}
        onRequestCloseTab={null}
        node={PEEK_NODE}
        completeMeans="ended"
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
    const view = renderPeekTile(
      <div>
        <BrowserPeekTile
          scope={{ kind: "epic", epicId: "epic-1" }}
          visible={hookState.visible}
          onConvertToPip={() => {}}
          onRequestNewTab={null}
          onRequestCloseTab={null}
          node={PEEK_NODE}
          completeMeans="ended"
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
          scope={{ kind: "epic", epicId: "epic-1" }}
          visible={hookState.visible}
          onConvertToPip={() => {}}
          onRequestNewTab={null}
          onRequestCloseTab={null}
          node={PEEK_NODE}
          completeMeans="ended"
        />
        <BrowserPeekTile
          scope={{ kind: "epic", epicId: "epic-1" }}
          visible={hookState.visible}
          onConvertToPip={() => {}}
          onRequestNewTab={null}
          onRequestCloseTab={null}
          node={sibling}
          completeMeans="ended"
        />
      </div>,
    );
    await flushMacrotask();
    expect(useScreencastArmedStore.getState().ownerId).toBe(PEEK_OWNER_ID);

    view.rerender(
      <div>
        <BrowserPeekTile
          scope={{ kind: "epic", epicId: "epic-1" }}
          visible={hookState.visible}
          onConvertToPip={() => {}}
          onRequestNewTab={null}
          onRequestCloseTab={null}
          node={PEEK_NODE}
          completeMeans="ended"
        />
      </div>,
    );
    await flushMacrotask();
    expect(useScreencastArmedStore.getState().ownerId).toBe(PEEK_OWNER_ID);
    expect(screen.getByText("Controlling")).not.toBeNull();
  });
});

/**
 * The tests above dispatch straight onto the tile's own IME input, which only
 * proves the screencast's OWN listener claims the chord while armed. The bug
 * this suite exists for is the app's WINDOW-level listener stealing mod+L
 * before it ever reaches the tile - which needs the real `KeybindingProvider`
 * in the tree and a keydown dispatched the way a real one arrives (at
 * `document.activeElement`, bubbling to the window's capture listener).
 */
describe("BrowserPeekTile address shortcut through the real KeybindingProvider", () => {
  beforeEach(() => {
    hookState.visible = true;
    hookState.streamClient = new FakeStreamClient(true);
    clearScreencastOwner();
  });

  afterEach(() => {
    cleanup();
    document.body.innerHTML = "";
    clearScreencastOwner();
    vi.restoreAllMocks();
  });

  it("focuses and fully selects the address bar on mod+L before the tile is armed", async () => {
    const router = buildProviderRouterSource("/");
    renderPeekTileWithProvider(
      router,
      <BrowserPeekTile
        scope={{ kind: "epic", epicId: "epic-1" }}
        visible={hookState.visible}
        onConvertToPip={() => {}}
        onRequestNewTab={null}
        onRequestCloseTab={null}
        node={PEEK_NODE}
        completeMeans="ended"
      />,
    );
    const stream = liveStream();
    await flushMacrotask();
    document.body.focus();

    let event: KeyboardEvent | undefined;
    act(() => {
      event = dispatchTargetKey(document.body, "keydown", {
        code: "KeyL",
        key: "l",
        ...platformModKeys(),
      });
    });

    const input = addressInput();
    expect(document.activeElement).toBe(input);
    expect(input.selectionStart).toBe(0);
    expect(input.selectionEnd).toBe(input.value.length);
    expect(event?.defaultPrevented).toBe(true);
    // The shortcut is not a control claim - it works without ever arming the
    // stream, and must not arm it as a side effect either.
    expect(useScreencastArmedStore.getState().ownerId).toBeNull();
    expect(keyboardFramesFor(stream, "l", "KeyL")).toEqual([]);
  });

  // The literal about:blank reproduction: the tile is never armed, and the
  // tab is on the real Start Page from the start - no guest/stream input path
  // is claiming anything, so only the window listener stands between mod+L
  // and `group.focus-editor`.
  it("focuses the address bar on mod+L on the real about:blank start page while unarmed", async () => {
    const router = buildProviderRouterSource("/");
    renderPeekTileWithProvider(
      router,
      <BrowserPeekTile
        scope={{ kind: "epic", epicId: "epic-1" }}
        visible={hookState.visible}
        onConvertToPip={() => {}}
        onRequestNewTab={null}
        onRequestCloseTab={null}
        node={{ ...PEEK_NODE, initialUrl: DEFAULT_BROWSER_TILE_URL }}
        completeMeans="ended"
      />,
    );
    liveStream();
    await waitFor(() => {
      expect(screen.getByText("Local servers")).not.toBeNull();
    });
    document.body.focus();

    act(() => {
      dispatchTargetKey(document.body, "keydown", {
        code: "KeyL",
        key: "l",
        ...platformModKeys(),
      });
    });

    const input = addressInput();
    expect(document.activeElement).toBe(input);
    expect(input.selectionStart).toBe(0);
    expect(input.selectionEnd).toBe(input.value.length);
  });

  // The `return-to-blank` case: an armed tile whose page navigates to the
  // real about:blank start page (no in-page focus target survives it) must
  // still route mod+L to its own chrome instead of losing it to
  // `group.focus-editor`, and must stay armed rather than being disarmed by
  // the shortcut.
  it("still focuses the address bar on mod+L after arming, once the tab returns to the real about:blank start page", async () => {
    const router = buildProviderRouterSource("/");
    renderPeekTileWithProvider(
      router,
      <BrowserPeekTile
        scope={{ kind: "epic", epicId: "epic-1" }}
        visible={hookState.visible}
        onConvertToPip={() => {}}
        onRequestNewTab={null}
        onRequestCloseTab={null}
        node={PEEK_NODE}
        completeMeans="ended"
      />,
    );
    const stream = liveStream();
    armPeekTile(stream);
    await flushMacrotask();
    expect(document.activeElement).toBe(imeInput());
    expect(useScreencastArmedStore.getState().ownerId).toBe(PEEK_OWNER_ID);

    // Blurred while still enabled, before the navigation below disables it:
    // jsdom does not implement the spec's "unfocusing steps" a real browser
    // runs when a focused control becomes disabled, so blurring (or
    // refocusing) it after that point is a no-op there - blur has to happen
    // while the element can still legitimately hold focus.
    act(() => {
      imeInput().blur();
    });
    expect(document.activeElement).toBe(document.body);

    // The real navigation the bug report describes: the armed tab lands back
    // on about:blank, which flips `showStartPage` and disables/hides the IME
    // input - exactly what leaves keyboard focus with nowhere to go but body.
    act(() => {
      stream.emit(
        {
          kind: "navState",
          hasBinaryPayload: false,
          url: DEFAULT_BROWSER_TILE_URL,
          canGoBack: true,
          canGoForward: false,
          loading: false,
        },
        null,
      );
    });
    await waitFor(() => {
      expect(screen.getByText("Local servers")).not.toBeNull();
    });
    expect(document.activeElement).toBe(document.body);

    act(() => {
      dispatchTargetKey(document.body, "keydown", {
        code: "KeyL",
        key: "l",
        ...platformModKeys(),
      });
    });

    const input = addressInput();
    expect(document.activeElement).toBe(input);
    expect(input.selectionStart).toBe(0);
    expect(input.selectionEnd).toBe(input.value.length);
    expect(useScreencastArmedStore.getState().ownerId).toBe(PEEK_OWNER_ID);
    expect(keyboardFramesFor(stream, "l", "KeyL")).toEqual([]);
  });

  it("releases forwarded page keys once the mod+L shortcut moves focus into the address bar", async () => {
    const router = buildProviderRouterSource("/");
    renderPeekTileWithProvider(
      router,
      <BrowserPeekTile
        scope={{ kind: "epic", epicId: "epic-1" }}
        visible={hookState.visible}
        onConvertToPip={() => {}}
        onRequestNewTab={null}
        onRequestCloseTab={null}
        node={PEEK_NODE}
        completeMeans="ended"
      />,
    );
    const stream = liveStream();
    armPeekTile(stream);
    await flushMacrotask();

    // A key held down before the shortcut fires: proves an actual RELEASE
    // happened (a synthetic keyUp for the still-held key), the same signal
    // the direct-focus version of this test uses - not just that a key typed
    // afterwards fails to reach the page, which would be true even if release
    // were never called.
    fireEvent.keyDown(imeInput(), { key: "a", code: "KeyA" });
    expect(keyboardFramesFor(stream, "a", "KeyA")).toEqual([
      expect.objectContaining({ type: "rawKeyDown", key: "a", code: "KeyA" }),
      expect.objectContaining({ type: "char", key: "a", code: "KeyA" }),
    ]);

    act(() => {
      dispatchTargetKey(imeInput(), "keydown", {
        code: "KeyL",
        key: "l",
        ...platformModKeys(),
      });
    });
    await flushMacrotask();

    expect(keyboardFramesFor(stream, "a", "KeyA")).toEqual([
      expect.objectContaining({ type: "rawKeyDown", code: "KeyA" }),
      expect.objectContaining({ type: "char", code: "KeyA" }),
      expect.objectContaining({ type: "keyUp", code: "KeyA", seq: 2 }),
    ]);
    expect(keyboardFramesFor(stream, "l", "KeyL")).toEqual([]);
  });

  it("leaves mod+L to a blocking dialog instead of the address bar", async () => {
    const router = buildProviderRouterSource("/");
    renderPeekTileWithProvider(
      router,
      <BrowserPeekTile
        scope={{ kind: "epic", epicId: "epic-1" }}
        visible={hookState.visible}
        onConvertToPip={() => {}}
        onRequestNewTab={null}
        onRequestCloseTab={null}
        node={PEEK_NODE}
        completeMeans="ended"
      />,
    );
    liveStream();
    await flushMacrotask();
    const dialog = document.createElement("div");
    dialog.setAttribute("role", "dialog");
    dialog.setAttribute("data-state", "open");
    document.body.appendChild(dialog);
    document.body.focus();

    act(() => {
      dispatchTargetKey(document.body, "keydown", {
        code: "KeyL",
        key: "l",
        ...platformModKeys(),
      });
    });

    expect(document.activeElement).not.toBe(addressInput());
  });
});
