import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { HostIdentityCard } from "@/components/settings/host-scope/host-identity-card";
import { hostScopeOptionFixture } from "@/components/settings/host-scope/host-scope-fixture";
import type { HostScopeOption } from "@/components/settings/host-scope/host-scope-model";

afterEach(cleanup);

function sandboxHost(
  state: "awake" | "suspended",
  health: "offline" | "online",
): HostScopeOption {
  return hostScopeOptionFixture({
    hostId: "sbx-a",
    name: "build-box",
    isLocalMachine: false,
    kind: "sandbox",
    health:
      health === "offline"
        ? {
            state: "offline",
            label: "Offline",
            detail: null,
            tone: "idle",
            live: false,
          }
        : {
            state: "online",
            label: "Online",
            detail: null,
            tone: "live",
            live: true,
          },
    sandbox: { state, frozen: false, summary: null },
  });
}

function renderCard(host: HostScopeOption): void {
  render(
    <HostIdentityCard
      host={host}
      displayName={host.name}
      version={null}
      nameAction={null}
      nameInput={null}
      nameRowWraps={false}
      busy={false}
      busySessionCount={null}
      busyBreakdown={null}
      actions={null}
      healthAction={null}
      lifecycleLine={null}
    >
      {null}
    </HostIdentityCard>,
  );
}

describe("<HostIdentityCard /> a sandbox's state word against its health", () => {
  it("shows the health, not Awake, for an awake sandbox that cannot be reached", () => {
    renderCard(sandboxHost("awake", "offline"));

    expect(screen.queryByTestId("host-identity-sandbox-state")).toBeNull();
    expect(screen.getByTestId("host-identity-health").textContent).toBe(
      "Offline",
    );
  });

  it("shows Suspended, and no health word, for a suspended sandbox that cannot be reached", () => {
    renderCard(sandboxHost("suspended", "offline"));

    expect(screen.getByTestId("host-identity-sandbox-state").textContent).toBe(
      "Suspended",
    );
    expect(screen.queryByTestId("host-identity-health")).toBeNull();
  });

  it("keeps the Awake word for an awake sandbox that is reachable", () => {
    renderCard(sandboxHost("awake", "online"));

    expect(screen.getByTestId("host-identity-sandbox-state").textContent).toBe(
      "Awake",
    );
    expect(screen.queryByTestId("host-identity-health")).toBeNull();
  });
});
