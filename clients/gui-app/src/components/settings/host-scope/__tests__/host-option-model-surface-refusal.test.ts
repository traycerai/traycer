import { describe, expect, it } from "vitest";
import { hostScopeOptionFixture } from "@/components/settings/host-scope/host-scope-fixture";
import {
  AVAILABLE_HOST_ROW_SURFACE_STATE,
  hostOptionStatusWord,
  hostRowSurfaceState,
  isHostOptionSelectable,
} from "@/components/settings/host-scope/host-option-model";

const CONNECTABLE = hostScopeOptionFixture({
  hostId: "host-ready",
  name: "Ready host",
});

const REFUSED = { kind: "refused" as const, word: "needs update" };
const INERT = { kind: "inert" as const };

describe("isHostOptionSelectable surfaceState", () => {
  it("a refused surface makes a connectable host inert under bind", () => {
    expect(
      isHostOptionSelectable(
        CONNECTABLE,
        "bind",
        AVAILABLE_HOST_ROW_SURFACE_STATE,
      ),
    ).toBe(true);
    expect(isHostOptionSelectable(CONNECTABLE, "bind", REFUSED)).toBe(false);
  });

  it("a refused surface also wins under view — the row is not a legal pick here", () => {
    expect(
      isHostOptionSelectable(
        CONNECTABLE,
        "view",
        AVAILABLE_HOST_ROW_SURFACE_STATE,
      ),
    ).toBe(true);
    expect(isHostOptionSelectable(CONNECTABLE, "view", REFUSED)).toBe(false);
  });

  it("an inert surface is not selectable", () => {
    expect(isHostOptionSelectable(CONNECTABLE, "bind", INERT)).toBe(false);
  });
});

describe("hostOptionStatusWord surfaceState", () => {
  it("shows the surface word on a connectable host, and connectivity first when it cannot be dialed", () => {
    expect(
      hostOptionStatusWord(CONNECTABLE, AVAILABLE_HOST_ROW_SURFACE_STATE),
    ).toBeNull();
    expect(hostOptionStatusWord(CONNECTABLE, REFUSED)).toBe("needs update");
    const unreachable = hostScopeOptionFixture({
      hostId: "host-down",
      connectable: false,
      planRestricted: false,
    });
    expect(hostOptionStatusWord(unreachable, REFUSED)).toBe("unreachable");
  });

  it("inert yields no word on a connectable host", () => {
    expect(hostOptionStatusWord(CONNECTABLE, INERT)).toBeNull();
  });

  it("inert silences connectivity words, and only then", () => {
    const unreachable = hostScopeOptionFixture({
      hostId: "host-down",
      connectable: false,
      planRestricted: false,
    });
    const gated = hostScopeOptionFixture({
      hostId: "host-gated",
      connectable: false,
      planRestricted: true,
    });
    expect(hostOptionStatusWord(unreachable, INERT)).toBeNull();
    expect(hostOptionStatusWord(gated, INERT)).toBeNull();
    expect(
      hostOptionStatusWord(unreachable, AVAILABLE_HOST_ROW_SURFACE_STATE),
    ).toBe("unreachable");
    expect(hostOptionStatusWord(gated, AVAILABLE_HOST_ROW_SURFACE_STATE)).toBe(
      "requires upgrade",
    );
  });
});

describe("hostRowSurfaceState", () => {
  it("inert leads so a per-host word cannot share a row with class silence", () => {
    expect(
      hostRowSurfaceState({
        surfaceRefusal: "needs update",
        surfaceInert: true,
      }),
    ).toEqual(INERT);
    expect(hostOptionStatusWord(CONNECTABLE, INERT)).toBeNull();
    expect(isHostOptionSelectable(CONNECTABLE, "bind", INERT)).toBe(false);
  });
});
