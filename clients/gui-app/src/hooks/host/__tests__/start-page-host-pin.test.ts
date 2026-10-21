import { describe, expect, it } from "vitest";
import { startPageHostPin } from "@/hooks/host/use-composer-surface-host-pin";
import type { SurfaceHostPin } from "@/hooks/host/use-surface-host-pin";

/**
 * On HEAD `startPageHostPin` does not exist, so every case here is red until
 * the Start Page wrapper lands.
 */

function pin(overrides: Partial<SurfaceHostPin>): SurfaceHostPin {
  return {
    selection: null,
    honoredSelection: null,
    setSelection: () => undefined,
    resolvedHostId: null,
    followingHostId: "host-effective",
    isPinned: false,
    latchOnFirstUse: () => undefined,
    ...overrides,
  };
}

const TEAM_SANDBOX = "sbx-team";

describe("startPageHostPin", () => {
  it("resolves a team-owned honored selection onto the following host and keeps the stored pin", () => {
    const stored = pin({
      selection: TEAM_SANDBOX,
      honoredSelection: TEAM_SANDBOX,
      resolvedHostId: TEAM_SANDBOX,
      isPinned: true,
    });

    const result = startPageHostPin(
      stored,
      (hostId) => hostId === TEAM_SANDBOX,
    );

    expect(result.honoredSelection).toBeNull();
    expect(result.resolvedHostId).toBe("host-effective");
    expect(result.selection).toBe(TEAM_SANDBOX);
    expect(result.isPinned).toBe(true);
  });

  it("returns the same pin object for a selection no team owns", () => {
    const stored = pin({
      selection: "host-mine",
      honoredSelection: "host-mine",
      resolvedHostId: "host-mine",
      isPinned: true,
    });

    expect(startPageHostPin(stored, () => false)).toBe(stored);
  });

  it("returns the same pin object when nothing is honored, without asking who owns a host", () => {
    const unpinned = pin({ resolvedHostId: "host-effective" });
    const deposed = pin({
      selection: TEAM_SANDBOX,
      honoredSelection: null,
      resolvedHostId: "host-effective",
      isPinned: true,
    });
    const neverAsked = (): boolean => {
      throw new Error("ownership must not be consulted without an honored pin");
    };

    expect(startPageHostPin(unpinned, neverAsked)).toBe(unpinned);
    expect(startPageHostPin(deposed, neverAsked)).toBe(deposed);
  });
});
