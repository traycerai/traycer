import { describe, expect, it } from "vitest";
import { hostScopeOptionFixture } from "@/components/settings/host-scope/host-scope-fixture";
import {
  hostOptionStatusWord,
  isHostOptionSelectable,
} from "@/components/settings/host-scope/host-option-model";

const CONNECTABLE = hostScopeOptionFixture({
  hostId: "host-ready",
  name: "Ready host",
});

describe("isHostOptionSelectable surfaceRefusal", () => {
  it("a surface refusal makes a connectable host inert under bind", () => {
    expect(isHostOptionSelectable(CONNECTABLE, "bind", null)).toBe(true);
    expect(isHostOptionSelectable(CONNECTABLE, "bind", "needs update")).toBe(
      false,
    );
  });

  it("a surface refusal also wins under view — the row is not a legal pick here", () => {
    expect(isHostOptionSelectable(CONNECTABLE, "view", null)).toBe(true);
    expect(isHostOptionSelectable(CONNECTABLE, "view", "needs update")).toBe(
      false,
    );
  });
});

describe("hostOptionStatusWord surfaceRefusal", () => {
  it("shows the surface word on a connectable host, and connectivity first when it cannot be dialed", () => {
    expect(hostOptionStatusWord(CONNECTABLE, null)).toBeNull();
    expect(hostOptionStatusWord(CONNECTABLE, "needs update")).toBe(
      "needs update",
    );
    const unreachable = hostScopeOptionFixture({
      hostId: "host-down",
      connectable: false,
      planRestricted: false,
    });
    expect(hostOptionStatusWord(unreachable, "needs update")).toBe(
      "unreachable",
    );
  });
});
