import { describe, expect, it } from "vitest";
import {
  hostSendKeyCodeForToken,
  parseReservedChordToken,
  reservedChordFromKeyEvent,
  reservedChordMatchesEvent,
  reservedChordToken,
  resolveReservedChordForPlatform,
} from "../reserved-chords";

describe("parseReservedChordToken", () => {
  it("parses the renderer chord vocabulary", () => {
    expect(parseReservedChordToken("mod+k")).toEqual({
      key: "k",
      mod: true,
      ctrl: false,
      shift: false,
      alt: false,
    });
    expect(parseReservedChordToken("mod+shift+h")).toEqual({
      key: "h",
      mod: true,
      ctrl: false,
      shift: true,
      alt: false,
    });
    expect(parseReservedChordToken("ctrl+shift+m")).toEqual({
      key: "m",
      mod: false,
      ctrl: true,
      shift: true,
      alt: false,
    });
    expect(parseReservedChordToken("mod+alt+arrowleft")).toEqual({
      key: "arrowleft",
      mod: true,
      ctrl: false,
      shift: false,
      alt: true,
    });
  });

  it("accepts aliases and whitespace", () => {
    const parsed = parseReservedChordToken(" CommandOrControl + , ");
    expect(parsed).not.toBeNull();
    expect(parsed?.key).toBe(",");
    expect(parsed?.mod).toBe(true);
    expect(parseReservedChordToken("option+alt+p")?.key).toBe("p");
  });

  it("rejects unparsable, modifier-only, and unmodified input", () => {
    expect(parseReservedChordToken("mod+shift+")).toBeNull();
    expect(parseReservedChordToken("mod")).toBeNull();
    expect(parseReservedChordToken("mod+k+j")).toBeNull();
    // Unmodified chords would swallow normal typing inside pages.
    expect(parseReservedChordToken("k")).toBeNull();
    expect(parseReservedChordToken("")).toBeNull();
  });
});

describe("platform resolution + matching", () => {
  const eventFor = (
    rawKey: string,
    mods: { meta?: boolean; control?: boolean; shift?: boolean; alt?: boolean },
    platform: "darwin" | "other",
  ) => {
    const event = reservedChordFromKeyEvent(
      {
        key: rawKey,
        meta: mods.meta === true,
        control: mods.control === true,
        shift: mods.shift === true,
        alt: mods.alt === true,
      },
      platform,
    );
    if (event === null) throw new Error("invalid fixture key");
    return event;
  };

  it("matches mod+k via Command on darwin", () => {
    const chord = parseReservedChordToken("mod+k");
    if (chord === null) throw new Error("unparsable fixture");
    expect(
      reservedChordMatchesEvent(chord, eventFor("k", { meta: true }, "darwin")),
    ).toBe(true);
    expect(
      reservedChordMatchesEvent(
        chord,
        eventFor("k", { control: true }, "darwin"),
      ),
    ).toBe(false);
  });

  it("folds physical Control into mod on other platforms", () => {
    const parsed = parseReservedChordToken("ctrl+k");
    if (parsed === null) throw new Error("unparsable fixture");
    const registered = resolveReservedChordForPlatform(parsed, "other");
    expect(registered).toMatchObject({ mod: true, ctrl: false });
    expect(
      reservedChordMatchesEvent(
        registered,
        eventFor("K", { control: true }, "other"),
      ),
    ).toBe(true);
  });

  it("keeps Control distinct from Command on darwin", () => {
    const parsed = parseReservedChordToken("ctrl+m");
    if (parsed === null) throw new Error("unparsable fixture");
    const chord = resolveReservedChordForPlatform(parsed, "darwin");
    expect(chord).toMatchObject({ mod: false, ctrl: true });
    expect(
      reservedChordMatchesEvent(chord, eventFor("m", { control: true }, "darwin")),
    ).toBe(true);
    expect(
      reservedChordMatchesEvent(chord, eventFor("m", { meta: true }, "darwin")),
    ).toBe(false);
  });

  it("is case-insensitive on the event key", () => {
    const chord = parseReservedChordToken("mod+k");
    if (chord === null) throw new Error("unparsable fixture");
    expect(
      reservedChordMatchesEvent(chord, eventFor("K", { meta: true }, "darwin")),
    ).toBe(true);
  });
});

describe("hostSendKeyCodeForToken", () => {
  it("maps letters, digits, f-keys, and named keys to accelerator codes", () => {
    expect(hostSendKeyCodeForToken("k")).toBe("K");
    expect(hostSendKeyCodeForToken("5")).toBe("5");
    expect(hostSendKeyCodeForToken("f5")).toBe("F5");
    expect(hostSendKeyCodeForToken("enter")).toBe("Enter");
    expect(hostSendKeyCodeForToken("escape")).toBe("Esc");
    expect(hostSendKeyCodeForToken("arrowleft")).toBe("Left");
  });

  it("returns null for unmappable tokens", () => {
    expect(hostSendKeyCodeForToken("mediatracknext")).toBeNull();
    expect(hostSendKeyCodeForToken("")).toBeNull();
  });
});

describe("round trip", () => {
  it("token → parse → token is stable", () => {
    const token = "mod+shift+h";
    const parsed = parseReservedChordToken(token);
    if (parsed === null) throw new Error("unparsable fixture");
    expect(reservedChordToken(parsed)).toBe(token);
  });
});
