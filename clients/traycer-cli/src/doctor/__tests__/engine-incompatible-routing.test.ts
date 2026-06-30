import { describe, expect, it } from "vitest";
import type { IncompatibilityUpgradeGuidance } from "@traycer/protocol/framework/index";
import { routeIncompatibleRecovery } from "../engine";
import { CLIENT_UPGRADE_HINT_FOR_SOURCE } from "../../host/compat-recovery";

// T7/C2 fixup: Doctor must route a handshake incompatibility to an action that
// can actually heal the host under the softened production trigger (ordinary
// launches no longer auto-update). The two gaps the Codex gate caught:
//   1. a MUTUAL verdict (both stale) must update the host, not just restart.
//   2. DOWNGRADE_UNSUPPORTED (client newer ⇒ host stale) must update the
//      host, even though the frame carries no upgradeGuidance.

function guidance(
  hostShouldUpgrade: boolean,
  clientShouldUpgrade: boolean,
): IncompatibilityUpgradeGuidance {
  return { hostShouldUpgrade, clientShouldUpgrade };
}

describe("routeIncompatibleRecovery", () => {
  it("host-only verdict → host-install-latest / 'traycer host update'", () => {
    const r = routeIncompatibleRecovery(
      "INCOMPATIBLE",
      guidance(true, false),
      "manual",
    );
    expect(r.fixAction).toBe("host-install-latest");
    expect(r.terminalCommand).toBe("traycer host update");
  });

  it("MUTUAL verdict → host-install-latest (NOT restart), client hint as copy", () => {
    const r = routeIncompatibleRecovery(
      "INCOMPATIBLE",
      guidance(true, true),
      "homebrew",
    );
    // The host is stale, so the actionable fix is an update even though the
    // client is stale too. The client side rides along as copy in the summary.
    expect(r.fixAction).toBe("host-install-latest");
    expect(r.terminalCommand).toBe("traycer host update");
    expect(r.plan.summary).toContain(CLIENT_UPGRADE_HINT_FOR_SOURCE.homebrew);
    expect(r.plan.clientUpgrade).not.toBeNull();
  });

  it("client-only verdict → no auto-fix button, vector-aware copy", () => {
    const r = routeIncompatibleRecovery(
      "INCOMPATIBLE",
      guidance(false, true),
      "homebrew",
    );
    expect(r.fixAction).toBeNull();
    expect(r.terminalCommand).toBeNull();
    expect(r.plan.summary).toContain("brew upgrade");
  });

  it("DOWNGRADE_UNSUPPORTED (null guidance) → host-install-latest, not restart", () => {
    const r = routeIncompatibleRecovery(
      "DOWNGRADE_UNSUPPORTED",
      null,
      "manual",
    );
    // Client newer than host with no bridge ⇒ host is the stale side and
    // must update. A restart would loop forever under the softened trigger.
    expect(r.fixAction).toBe("host-install-latest");
    expect(r.terminalCommand).toBe("traycer host update");
    expect(r.plan.reinstallHost).toBe(true);
  });

  it("INCOMPATIBLE with no guidance → conservative host-restart fallback", () => {
    const r = routeIncompatibleRecovery("INCOMPATIBLE", null, "manual");
    expect(r.fixAction).toBe("host-restart");
    expect(r.terminalCommand).toBe("traycer host restart");
  });
});
