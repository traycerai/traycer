import { describe, expect, it, vi } from "vitest";
import type { BrowserViewReservedChord } from "@traycer-clients/shared/platform/browser-view";
import { RunnerHostEvent } from "../../../../ipc-contracts/ipc-channels";
import {
  BrowserViewChords,
  hostSendKeyCodeForToken,
  type BrowserViewKeyInput,
  type HostPlatform,
} from "../browser-view-chords";

vi.mock("../../../app/logger", () => ({
  log: { info: vi.fn(), warn: vi.fn() },
}));

/**
 * The US-layout `code` for a key these tests name by its character.
 *
 * Electron always sends `code`, and the matcher derives its token from it, so
 * a helper that omitted one would put every existing case on the `key`
 * fallback and leave the real path covered only by the layout cases below.
 * `undefined` for anything outside this map - punctuation and named keys then
 * exercise the fallback deliberately.
 */
function usCodeFor(key: string): string | undefined {
  const lower = key.toLowerCase();
  if (/^[a-z]$/.test(lower)) return `Key${lower.toUpperCase()}`;
  if (/^[0-9]$/.test(lower)) return `Digit${lower}`;
  return undefined;
}

function keyDown(
  key: string,
  mods: {
    readonly meta: boolean;
    readonly control: boolean;
    readonly shift: boolean;
    readonly alt: boolean;
  },
): BrowserViewKeyInput {
  return { key, code: usCodeFor(key), ...mods, isAutoRepeat: false };
}

/**
 * A keystroke named by its PHYSICAL key and the character that key produces
 * under the reader's layout - the two disagreeing is the whole point.
 */
function layoutKeyDown(
  code: string,
  key: string,
  mods: {
    readonly meta: boolean;
    readonly control: boolean;
    readonly shift: boolean;
    readonly alt: boolean;
  },
): BrowserViewKeyInput {
  return { key, code, ...mods, isAutoRepeat: false };
}

function heldKeyDown(
  key: string,
  mods: {
    readonly meta: boolean;
    readonly control: boolean;
    readonly shift: boolean;
    readonly alt: boolean;
  },
): BrowserViewKeyInput {
  return { key, code: usCodeFor(key), ...mods, isAutoRepeat: true };
}

const NO_MODS = {
  meta: false,
  control: false,
  shift: false,
  alt: false,
} as const;

/** The window every table in this file is registered under, unless named. */
const TEST_WINDOW = "window-1";

function chordsFor(
  tokens: readonly string[],
  platform: HostPlatform,
): BrowserViewChords {
  const chords = new BrowserViewChords({
    getWindow: () => null,
    hostPlatform: platform,
    send: () => true,
  });
  chords.setReservedChords(
    TEST_WINDOW,
    tokens.map((token) => ({ token, command: null })),
  );
  return chords;
}

describe("registered token vocabulary", () => {
  it("claims canonical chord strings, including punctuation and f13+", () => {
    const chords = chordsFor(["mod+k", "mod+/", "mod+f13"], "darwin");
    expect(
      chords.match(TEST_WINDOW, keyDown("k", { ...NO_MODS, meta: true })),
    ).toMatchObject({ key: "k", mod: true });
    expect(
      chords.match(TEST_WINDOW, keyDown("/", { ...NO_MODS, meta: true })),
    ).not.toBeNull();
    expect(
      chords.match(TEST_WINDOW, keyDown("F13", { ...NO_MODS, meta: true })),
    ).not.toBeNull();
  });

  it("drops malformed, unmodified, and unreplayable tokens", () => {
    const chords = chordsFor(
      ["mod+", "shift+mod+k", "k", "", "mod+mediatracknext"],
      "darwin",
    );
    // "shift+mod+k" is non-canonical token order, so it never registers.
    expect(
      chords.match(
        TEST_WINDOW,
        keyDown("k", { ...NO_MODS, meta: true, shift: true }),
      ),
    ).toBeNull();
    expect(chords.match(TEST_WINDOW, keyDown("k", NO_MODS))).toBeNull();
    expect(
      chords.match(
        TEST_WINDOW,
        keyDown("mediatracknext", { ...NO_MODS, meta: true }),
      ),
    ).toBeNull();
  });

  it("never matches a bare modifier press", () => {
    const chords = chordsFor(["mod+k"], "darwin");
    expect(
      chords.match(TEST_WINDOW, keyDown("Meta", { ...NO_MODS, meta: true })),
    ).toBeNull();
  });
});

describe("platform resolution", () => {
  it("matches mod+k via Command on darwin, not Control", () => {
    const chords = chordsFor(["mod+k"], "darwin");
    expect(
      chords.match(TEST_WINDOW, keyDown("k", { ...NO_MODS, meta: true })),
    ).not.toBeNull();
    expect(
      chords.match(TEST_WINDOW, keyDown("k", { ...NO_MODS, control: true })),
    ).toBeNull();
  });

  it("folds a registered ctrl chord onto mod off darwin", () => {
    const chords = chordsFor(["ctrl+k"], "other");
    // Case-insensitive on the event key, as before-input-event reports it.
    expect(
      chords.match(TEST_WINDOW, keyDown("K", { ...NO_MODS, control: true })),
    ).toMatchObject({ mod: true, ctrl: false });
  });

  it("keeps Control distinct from Command on darwin", () => {
    const chords = chordsFor(["ctrl+m"], "darwin");
    expect(
      chords.match(TEST_WINDOW, keyDown("m", { ...NO_MODS, control: true })),
    ).toMatchObject({ mod: false, ctrl: true });
    expect(
      chords.match(TEST_WINDOW, keyDown("m", { ...NO_MODS, meta: true })),
    ).toBeNull();
  });
});

/**
 * A chord token names a PHYSICAL key, so the two halves of the guest-focused
 * policy must both derive one from `code`.
 *
 * The table was already shared; the MATCHERS were not, and membership tests
 * could not see it - the renderer reserved `mod+1` and this side, deriving
 * from `input.key`, returned null for the very keystroke that produced it. So
 * these drive the real matcher with real non-US events rather than asserting
 * that a token is present.
 *
 * The AZERTY numbers are what Electron actually reports: physical `Digit1`
 * carries `key: "&"` unshifted, `key: "!"` with Shift.
 */
describe("layout independence", () => {
  const CTRL = {
    meta: false,
    control: true,
    shift: false,
    alt: false,
  } as const;

  it("matches a reserved digit from the physical key, whatever it prints", () => {
    const chords = chordsFor(["mod+1"], "other");

    expect(chords.match(TEST_WINDOW, keyDown("1", CTRL))).not.toBeNull();
    // Redden: deriving the token from `input.key` returns null for both, and
    // the shortcut is forwarded to the guest.
    expect(
      chords.match(TEST_WINDOW, layoutKeyDown("Digit1", "&", CTRL)),
    ).not.toBeNull();
    expect(
      chords.match(
        TEST_WINDOW,
        layoutKeyDown("Digit1", "!", { ...CTRL, shift: true }),
      ),
    ).toBeNull();
    // Shift is part of the chord, so `mod+shift+1` is a DIFFERENT token and
    // `mod+1` correctly declines it - the point is that it declines on the
    // modifier, not on the character.
    expect(
      chordsFor(["mod+shift+1"], "other").match(
        TEST_WINDOW,
        layoutKeyDown("Digit1", "!", { ...CTRL, shift: true }),
      ),
    ).not.toBeNull();
  });

  it("matches a reserved letter from the physical key, on a layout that moves it", () => {
    const chords = chordsFor(["mod+w"], "other");

    expect(chords.match(TEST_WINDOW, keyDown("w", CTRL))).not.toBeNull();
    // AZERTY puts `z` where US has `w`. Pre-existing: ⌘W never reached the
    // tile's close on that layout, because only the digits were new.
    expect(
      chords.match(TEST_WINDOW, layoutKeyDown("KeyW", "z", CTRL)),
    ).not.toBeNull();
    // And the key that PRINTS `w` there is a different physical key, so it
    // must NOT claim the chord.
    expect(
      chords.match(TEST_WINDOW, layoutKeyDown("KeyZ", "w", CTRL)),
    ).toBeNull();
  });

  it("falls back to the character when there is no usable code", () => {
    const chords = chordsFor(["mod+w"], "other");

    // No `code` at all, and a code this map does not know: both keep today's
    // behaviour rather than becoming a new refusal.
    expect(
      chords.match(TEST_WINDOW, {
        key: "w",
        code: undefined,
        ...CTRL,
        isAutoRepeat: false,
      }),
    ).not.toBeNull();
    expect(
      chords.match(TEST_WINDOW, layoutKeyDown("Lang1", "w", CTRL)),
    ).not.toBeNull();
  });
});

describe("hostSendKeyCodeForToken", () => {
  it("maps single characters, f-keys, and named keys", () => {
    expect(hostSendKeyCodeForToken("k")).toBe("K");
    expect(hostSendKeyCodeForToken("5")).toBe("5");
    expect(hostSendKeyCodeForToken("/")).toBe("/");
    expect(hostSendKeyCodeForToken("f5")).toBe("F5");
    expect(hostSendKeyCodeForToken("f24")).toBe("F24");
    expect(hostSendKeyCodeForToken("enter")).toBe("Enter");
    expect(hostSendKeyCodeForToken("escape")).toBe("Esc");
    expect(hostSendKeyCodeForToken("arrowleft")).toBe("Left");
  });

  it("returns null for unmappable tokens", () => {
    expect(hostSendKeyCodeForToken("mediatracknext")).toBeNull();
    expect(hostSendKeyCodeForToken("")).toBeNull();
  });
});

/**
 * The guest-focused input policy, at the seam that decides it. A browser-scoped
 * chord must NEVER be replayed into the host renderer (that is what made Cmd+W
 * close the app's task tab), and an app-forwarded one must never be delivered
 * as a tile command.
 */
describe("guest-focused dispositions", () => {
  const SURFACE = {
    windowId: "window-1",
    viewTabId: "view-1",
    paneId: "pane-1",
    tileInstanceId: "tile-1",
    pageSessionId: "page-1",
  };

  function dispatchHarness(policy: readonly BrowserViewReservedChord[]) {
    const sendInputEvent = vi.fn();
    const focus = vi.fn();
    const calls: string[] = [];
    const send = vi.fn(() => {
      calls.push("send");
      return true;
    });
    const chords = new BrowserViewChords({
      getWindow: () => ({
        webContents: {
          on: vi.fn(),
          off: vi.fn(),
          focus: () => {
            calls.push("focus");
            focus();
          },
          sendInputEvent,
        },
        isDestroyed: () => false,
      }),
      hostPlatform: "darwin",
      send,
    });
    chords.setReservedChords(TEST_WINDOW, policy);
    /**
     * Deliver a keystroke exactly as the guest seam would: a match is what
     * `preventDefault`s, and only a first press also dispatches.
     */
    const press = (input: BrowserViewKeyInput): void => {
      const matched = chords.match(TEST_WINDOW, input);
      if (matched !== null && !input.isAutoRepeat) {
        chords.dispatch(SURFACE, matched);
      }
    };
    const fire = (input: BrowserViewKeyInput): void => {
      expect(chords.match(TEST_WINDOW, input)).not.toBeNull();
      press(input);
    };
    return { calls, fire, focus, press, send, sendInputEvent, chords };
  }

  it("turns a browser-scoped chord into a tile command, never a key replay", () => {
    const { fire, send, sendInputEvent } = dispatchHarness([
      { token: "mod+w", command: "closeTab" },
    ]);
    fire(keyDown("w", { ...NO_MODS, meta: true }));
    expect(sendInputEvent).not.toHaveBeenCalled();
    expect(send).toHaveBeenCalledWith(
      "window-1",
      RunnerHostEvent.browserViewTileCommand,
      {
        viewTabId: "view-1",
        paneId: "pane-1",
        tileInstanceId: "tile-1",
        pageSessionId: "page-1",
        command: "closeTab",
      },
    );
  });

  it("replays an app-forwarded chord into the host renderer", () => {
    const { fire, send, sendInputEvent } = dispatchHarness([
      { token: "mod+shift+w", command: null },
    ]);
    fire(keyDown("W", { ...NO_MODS, meta: true, shift: true }));
    expect(send).not.toHaveBeenCalled();
    expect(sendInputEvent).toHaveBeenCalledWith({
      type: "keyDown",
      keyCode: "W",
      modifiers: ["meta", "shift"],
    });
  });

  it("leaves an unlisted chord to the page", () => {
    const { chords } = dispatchHarness([
      { token: "mod+w", command: "closeTab" },
    ]);
    expect(
      chords.match(TEST_WINDOW, keyDown("t", { ...NO_MODS, meta: true })),
    ).toBeNull();
  });

  it("fires once per press - a held key never repeats the command", () => {
    const { press, send } = dispatchHarness([
      { token: "mod+t", command: "newTab" },
    ]);
    press(keyDown("t", { ...NO_MODS, meta: true }));
    for (let repeat = 0; repeat < 25; repeat += 1) {
      press(heldKeyDown("t", { ...NO_MODS, meta: true }));
    }
    expect(send).toHaveBeenCalledOnce();
  });

  it("still CLAIMS a held chord, so a repeat never reaches the menu", () => {
    // The seam `preventDefault`s on a match. Letting a repeat fall through
    // would hand Cmd+W back to the focus-blind application accelerator while
    // the first press's asynchronous browser-tab close is still pending.
    const { chords } = dispatchHarness([
      { token: "mod+w", command: "closeTab" },
    ]);
    expect(
      chords.match(TEST_WINDOW, heldKeyDown("w", { ...NO_MODS, meta: true })),
    ).not.toBeNull();
  });

  it("claims a held app-forwarded chord but never replays it", () => {
    const { press, chords, sendInputEvent } = dispatchHarness([
      { token: "mod+k", command: null },
    ]);
    expect(
      chords.match(TEST_WINDOW, heldKeyDown("k", { ...NO_MODS, meta: true })),
    ).not.toBeNull();
    press(heldKeyDown("k", { ...NO_MODS, meta: true }));
    expect(sendInputEvent).not.toHaveBeenCalled();
  });

  it("takes OS keyboard focus off the guest before asking for the caret", () => {
    const { calls, fire, focus } = dispatchHarness([
      { token: "mod+l", command: "focusAddressBar" },
    ]);
    fire(keyDown("l", { ...NO_MODS, meta: true }));
    expect(focus).toHaveBeenCalledOnce();
    // Order matters: the renderer focuses the field on receipt, so the host
    // window must already own OS focus by then.
    expect(calls).toEqual(["focus", "send"]);
  });

  it("does not steal focus for a command that needs no caret", () => {
    const { fire, focus } = dispatchHarness([
      { token: "mod+w", command: "closeTab" },
    ]);
    fire(keyDown("w", { ...NO_MODS, meta: true }));
    expect(focus).not.toHaveBeenCalled();
  });
});

/**
 * The table belongs to the WINDOW that registered it.
 *
 * Every renderer derives its own set from its own surface state - a window
 * showing a Start Page browser reserves the panel's extra chords, one showing
 * a canvas does not - and there is one manager serving all of them. Held as a
 * single array, the last window to register decided the policy for every
 * window, and nothing re-registers on OS focus: returning to a Start Page
 * window whose tab state had not changed left it matching the canvas window's
 * table, so its ⌘J went to the guest. The reverse cost the canvas guest keys
 * the canvas has no handler for.
 */
describe("reserved chords are scoped to their window", () => {
  const LANDING_WINDOW = "window-landing";
  const CANVAS_WINDOW = "window-canvas";

  function twoWindows(): BrowserViewChords {
    const chords = new BrowserViewChords({
      getWindow: () => ({
        webContents: {
          on: vi.fn(),
          off: vi.fn(),
          focus: vi.fn(),
          sendInputEvent: vi.fn(),
        },
        isDestroyed: () => false,
      }),
      hostPlatform: "darwin",
      send: () => true,
    });
    // The Start Page window forwards the panel's chord; the canvas window,
    // registering second, does not.
    chords.setReservedChords(LANDING_WINDOW, [
      { token: "mod+j", command: null },
    ]);
    chords.setReservedChords(CANVAS_WINDOW, [
      { token: "mod+w", command: null },
    ]);
    return chords;
  }

  const modJ = keyDown("j", { ...NO_MODS, meta: true });

  it("keeps matching the landing window's table after another window registers", () => {
    const chords = twoWindows();

    // Redden: one shared array, and the canvas window's registration is what
    // this now matches against - so the reader's ⌘J falls through to the page.
    expect(chords.match(LANDING_WINDOW, modJ)).not.toBeNull();
  });

  it("does not lend one window's chord to another window's guest", () => {
    const chords = twoWindows();

    expect(chords.match(CANVAS_WINDOW, modJ)).toBeNull();
  });

  it("claims nothing for a guest whose window is unknown or unregistered", () => {
    const chords = twoWindows();

    expect(chords.match(null, modJ)).toBeNull();
    expect(chords.match("window-never-registered", modJ)).toBeNull();
  });

  it("forgets a window that has gone, and only that one", () => {
    const live = new Set([LANDING_WINDOW]);
    const chords = new BrowserViewChords({
      getWindow: (windowId) =>
        live.has(windowId)
          ? {
              webContents: {
                on: vi.fn(),
                off: vi.fn(),
                focus: vi.fn(),
                sendInputEvent: vi.fn(),
              },
              isDestroyed: () => false,
            }
          : null,
      hostPlatform: "darwin",
      send: () => true,
    });
    chords.setReservedChords(CANVAS_WINDOW, [
      { token: "mod+j", command: null },
    ]);
    expect(chords.match(CANVAS_WINDOW, modJ)).not.toBeNull();

    // The canvas window closes; the next registration from a live window is
    // where its table is dropped.
    chords.setReservedChords(LANDING_WINDOW, [
      { token: "mod+j", command: null },
    ]);

    expect(chords.match(CANVAS_WINDOW, modJ)).toBeNull();
    expect(chords.match(LANDING_WINDOW, modJ)).not.toBeNull();
  });
});
