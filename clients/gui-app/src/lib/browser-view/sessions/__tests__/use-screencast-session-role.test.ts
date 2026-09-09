import { describe, expect, it } from "vitest";
import { screencastRoleForShell } from "@/lib/browser-view/sessions/use-screencast-session";
import { FakeBrowserViewBridge } from "@/lib/browser-view/__tests__/fake-browser-view-bridge";

/**
 * Security review root cause G: only a shell with a native browser of its own
 * may subscribe at the tier that can drive the tab. Both read-only shells
 * answer `browserView: null` - the web bundle mounts no runner host at all,
 * and `MobileRunnerHost` declares the field `null` - so one predicate covers
 * them, and the desktop stays the single `"tile"`.
 */
describe("screencastRoleForShell", () => {
  it("is a viewer on a shell with no runner host at all (web)", () => {
    expect(screencastRoleForShell(null)).toBe("viewer");
  });

  it("is a viewer on a shell whose runner host has no browser (mobile)", () => {
    expect(screencastRoleForShell({ browserView: null })).toBe("viewer");
  });

  it("is a tile only where the shell owns a native browser (desktop)", () => {
    expect(
      screencastRoleForShell({ browserView: new FakeBrowserViewBridge() }),
    ).toBe("tile");
  });
});
