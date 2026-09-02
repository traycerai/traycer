import { describe, expect, it } from "vitest";
import { parseReservedChords } from "../browser-view-ipc-payload";

/**
 * The guest-focused input policy arrives from the renderer, which may be newer
 * than this build. One unrecognized row must cost that row and nothing else -
 * dropping the array would leave every reserved chord unclaimed, so Cmd+W
 * would silently go back to closing the app's task tab.
 */
describe("parseReservedChords", () => {
  it("keeps the rows it understands when one is from a newer renderer", () => {
    const parsed = parseReservedChords({
      chords: [
        { token: "mod+w", command: "closeTab" },
        { token: "mod+f12", command: "teleport" },
        { token: "mod+k", command: null },
      ],
    });
    expect(parsed).toEqual([
      { token: "mod+w", command: "closeTab" },
      { token: "mod+k", command: null },
    ]);
  });

  it("yields an empty policy for a payload that is not a chord list", () => {
    expect(parseReservedChords({ chords: "mod+w" })).toEqual([]);
    expect(parseReservedChords(null)).toEqual([]);
  });
});
