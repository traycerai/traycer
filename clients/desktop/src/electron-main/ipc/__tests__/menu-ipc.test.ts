import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  BrowserWindow: { fromWebContents: () => null },
  Menu: { getApplicationMenu: () => null },
}));

import { scaleMenuAnchor } from "../menu-ipc";

describe("scaleMenuAnchor", () => {
  it("converts renderer CSS coordinates to zoomed popup coordinates", () => {
    expect(scaleMenuAnchor(40, 1.5)).toBe(60);
    expect(scaleMenuAnchor(40, 0.67)).toBe(27);
  });

  it("clamps negative coordinates and rejects invalid zoom factors", () => {
    expect(scaleMenuAnchor(-12, 2)).toBe(0);
    expect(scaleMenuAnchor(40, Number.NaN)).toBe(40);
  });
});
