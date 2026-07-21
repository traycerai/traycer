import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

function source(path: string): string {
  return readFileSync(resolve(__dirname, path), "utf8");
}

describe("single route-to-layout authority", () => {
  it("keeps the permanent history observer outside HostReadyGate", () => {
    const root = source("../root-route-components.tsx");
    const bridge = root.indexOf("<TabNavigationRouteBridge");
    const gateOpen = root.indexOf("<HostReadyGate");
    const gateClose = root.indexOf("</HostReadyGate>");

    expect(bridge).toBeGreaterThan(-1);
    expect(gateOpen).toBeGreaterThan(-1);
    expect(gateClose).toBeGreaterThan(gateOpen);
    expect(bridge > gateOpen && bridge < gateClose).toBe(false);
  });

  it("makes the Epic tab-route adapter render-only", () => {
    const route = source("../epic-tab-route-components.tsx");
    const start = route.indexOf("function EpicRouteTabSync");
    const end = route.indexOf("export function PhaseToEpicMigrationGate");
    const adapter = route.slice(start, end);

    expect(adapter).not.toContain("activateTabIntent(");
    expect(adapter).not.toContain("navigate(");
    expect(adapter).not.toContain("ownsLocation");
    expect(adapter).not.toContain("resolveTargetTabForEpic");
  });

  it("makes the Draft adapter render-only with no raw fallback navigation", () => {
    const route = source("../draft-route-components.tsx");
    expect(route).not.toContain("useNavigate");
    expect(route).not.toContain("navigate(");
    expect(route).not.toContain("ownsLocation");
    expect(route).not.toContain("useLandingDraftStore");
  });
});
