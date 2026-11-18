import { describe, expect, it } from "vitest";
import { parsePerWindowStatePatch } from "../ipc-parsers";

describe("parsePerWindowStatePatch", () => {
  it("keeps the negotiated opaque layout and route while ignoring unknown keys", () => {
    expect(
      parsePerWindowStatePatch({
        tabStripLayout: {
          version: 2,
          items: [],
          activeItemId: null,
          systemTabs: { history: null, settings: null },
        },
        activeRoute: "/settings/general",
        unsupportedFutureField: "ignored",
      }),
    ).toEqual({
      tabStripLayout: {
        version: 2,
        items: [],
        activeItemId: null,
        systemTabs: { history: null, settings: null },
      },
      activeRoute: "/settings/general",
    });
  });

  it("repairs malformed negotiated fields without throwing", () => {
    expect(
      parsePerWindowStatePatch({
        tabStripLayout: () => undefined,
        activeRoute: 3,
      }),
    ).toEqual({ tabStripLayout: null, activeRoute: null });
  });
});
