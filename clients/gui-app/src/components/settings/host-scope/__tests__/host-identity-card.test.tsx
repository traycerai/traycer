import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { HostBusyBreakdown } from "@traycer/protocol/host/status/index";
import { HOST_FROZEN_WORD } from "@traycer/protocol/host/host-status";
import { SandboxHeaderNotices } from "@/components/hosts/sandbox-card";
import { HostIdentityCard } from "@/components/settings/host-scope/host-identity-card";
import { hostScopeOptionFixture } from "@/components/settings/host-scope/host-scope-fixture";
import type { HostScopeOption } from "@/components/settings/host-scope/host-scope-model";
import { TooltipProvider } from "@/components/ui/tooltip";

afterEach(cleanup);

function sandboxHost(
  state: "awake" | "suspended",
  health: "offline" | "online",
  frozen: boolean,
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
    sandbox: { state, frozen, summary: null, teamOwned: false },
  });
}

function teamSandboxHost(
  state: "awake" | "suspended",
  health: "offline" | "online",
  frozen: boolean,
): HostScopeOption {
  const host = sandboxHost(state, health, frozen);
  return {
    ...host,
    sandbox:
      host.sandbox === null ? null : { ...host.sandbox, teamOwned: true },
  };
}

function renderCard(host: HostScopeOption): void {
  render(
    <HostIdentityCard
      host={host}
      displayName={host.name}
      nameAction={null}
      nameInput={null}
      busy={false}
      busySessionCount={null}
      busyBreakdown={null}
      actions={null}
      healthAction={null}
      lifecycleLine={null}
    >
      {host.sandbox === null ? null : (
        <SandboxHeaderNotices sandbox={host.sandbox} teamName={null} />
      )}
    </HostIdentityCard>,
  );
}

describe("<HostIdentityCard /> a sandbox's state word against its health", () => {
  it("shows the health, not Awake, for an awake sandbox that cannot be reached", () => {
    renderCard(sandboxHost("awake", "offline", false));

    expect(screen.queryByTestId("host-identity-sandbox-state")).toBeNull();
    expect(screen.getByTestId("host-identity-health").textContent).toBe(
      "Offline",
    );
  });

  it("shows Suspended, and no health word, for a suspended sandbox that cannot be reached", () => {
    renderCard(sandboxHost("suspended", "offline", false));

    expect(screen.getByTestId("host-identity-sandbox-state").textContent).toBe(
      "Suspended",
    );
    expect(screen.queryByTestId("host-identity-health")).toBeNull();
  });

  it("keeps the Awake word for an awake sandbox that is reachable", () => {
    renderCard(sandboxHost("awake", "online", false));

    expect(screen.getByTestId("host-identity-sandbox-state").textContent).toBe(
      "Awake",
    );
    expect(screen.queryByTestId("host-identity-health")).toBeNull();
  });

  it("shows Out of credits beside the suspended state for a frozen sandbox", () => {
    renderCard(sandboxHost("suspended", "offline", true));

    expect(screen.getByTestId("host-identity-sandbox-state").textContent).toBe(
      "Suspended",
    );
    expect(
      screen.getByTestId("host-identity-sandbox-state").parentElement
        ?.textContent,
    ).toContain(HOST_FROZEN_WORD);
    expect(screen.getByTestId("sandbox-card-state-line").textContent).toBe(
      "Your credits ran out",
    );
  });

  it("shows the frozen word beside the state for a team sandbox", () => {
    const host = teamSandboxHost("suspended", "online", true);
    renderCard(host);

    const state = screen.getByTestId("host-identity-sandbox-state");
    expect(state.parentElement?.textContent).toContain(HOST_FROZEN_WORD);
  });

  it("makes the full busy breakdown available by keyboard through its tooltip", async () => {
    const user = userEvent.setup();
    const breakdown: HostBusyBreakdown = {
      workingAgents: 2,
      activeTerminalAgents: 1,
      busyTerminals: 3,
    };
    const label = "2 agents · 1 terminal agent · 3 terminals working";
    const host = sandboxHost("awake", "online", false);

    render(
      <TooltipProvider delayDuration={0}>
        <HostIdentityCard
          host={host}
          displayName={host.name}
          nameAction={null}
          nameInput={null}
          busy
          busySessionCount={6}
          busyBreakdown={breakdown}
          actions={null}
          healthAction={null}
          lifecycleLine={null}
        >
          {host.sandbox === null ? null : (
            <SandboxHeaderNotices sandbox={host.sandbox} teamName={null} />
          )}
        </HostIdentityCard>
      </TooltipProvider>,
    );

    const trigger = screen.getByRole("button", { name: "Busy" });
    expect(screen.getByTestId("host-active-sessions").textContent).toBe("Busy");

    await user.tab();

    expect(document.activeElement).toBe(trigger);
    expect((await screen.findByRole("tooltip")).textContent).toBe(label);
    expect(
      screen.getByRole("button", { name: "Busy", description: label }),
    ).toBe(trigger);
  });
});
