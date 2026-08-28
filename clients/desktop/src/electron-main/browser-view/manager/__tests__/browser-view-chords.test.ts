import { describe, expect, it, vi } from "vitest";
import {
  BrowserViewChords,
  hostSendKeyCodeForToken,
  type BrowserViewKeyInput,
  type HostPlatform,
} from "../browser-view-chords";

vi.mock("../../../app/logger", () => ({
  log: { info: vi.fn(), warn: vi.fn() },
}));

function keyDown(
  key: string,
  mods: {
    readonly meta: boolean;
    readonly control: boolean;
    readonly shift: boolean;
    readonly alt: boolean;
  },
): BrowserViewKeyInput {
  return { key, ...mods };
}

const NO_MODS = {
  meta: false,
  control: false,
  shift: false,
  alt: false,
} as const;

function chordsFor(
  tokens: readonly string[],
  platform: HostPlatform,
): BrowserViewChords {
  const chords = new BrowserViewChords({
    getWindow: () => null,
    hostPlatform: platform,
  });
  chords.setTokens(tokens);
  return chords;
}

describe("registered token vocabulary", () => {
  it("claims canonical chord strings, including punctuation and f13+", () => {
    const chords = chordsFor(["mod+k", "mod+/", "mod+f13"], "darwin");
    expect(
      chords.match(keyDown("k", { ...NO_MODS, meta: true })),
    ).toMatchObject({ key: "k", mod: true });
    expect(
      chords.match(keyDown("/", { ...NO_MODS, meta: true })),
    ).not.toBeNull();
    expect(
      chords.match(keyDown("F13", { ...NO_MODS, meta: true })),
    ).not.toBeNull();
  });

  it("drops malformed, unmodified, and unreplayable tokens", () => {
    const chords = chordsFor(
      ["mod+", "shift+mod+k", "k", "", "mod+mediatracknext"],
      "darwin",
    );
    // "shift+mod+k" is non-canonical token order, so it never registers.
    expect(
      chords.match(keyDown("k", { ...NO_MODS, meta: true, shift: true })),
    ).toBeNull();
    expect(chords.match(keyDown("k", NO_MODS))).toBeNull();
    expect(
      chords.match(keyDown("mediatracknext", { ...NO_MODS, meta: true })),
    ).toBeNull();
  });

  it("never matches a bare modifier press", () => {
    const chords = chordsFor(["mod+k"], "darwin");
    expect(
      chords.match(keyDown("Meta", { ...NO_MODS, meta: true })),
    ).toBeNull();
  });
});

describe("platform resolution", () => {
  it("matches mod+k via Command on darwin, not Control", () => {
    const chords = chordsFor(["mod+k"], "darwin");
    expect(
      chords.match(keyDown("k", { ...NO_MODS, meta: true })),
    ).not.toBeNull();
    expect(
      chords.match(keyDown("k", { ...NO_MODS, control: true })),
    ).toBeNull();
  });

  it("folds a registered ctrl chord onto mod off darwin", () => {
    const chords = chordsFor(["ctrl+k"], "other");
    // Case-insensitive on the event key, as before-input-event reports it.
    expect(
      chords.match(keyDown("K", { ...NO_MODS, control: true })),
    ).toMatchObject({ mod: true, ctrl: false });
  });

  it("keeps Control distinct from Command on darwin", () => {
    const chords = chordsFor(["ctrl+m"], "darwin");
    expect(
      chords.match(keyDown("m", { ...NO_MODS, control: true })),
    ).toMatchObject({ mod: false, ctrl: true });
    expect(chords.match(keyDown("m", { ...NO_MODS, meta: true }))).toBeNull();
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
