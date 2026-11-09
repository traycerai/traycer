import type { ReactNode } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
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

interface CardExtra {
  readonly busy?: boolean;
  readonly busySessionCount?: number | null;
  readonly busyBreakdown?: HostBusyBreakdown | null;
  readonly healthAction?: ReactNode;
  readonly lifecycleLine?: ReactNode;
  readonly costLine?: ReactNode;
}

function renderCard(host: HostScopeOption, extra: CardExtra | null): void {
  render(
    <TooltipProvider delayDuration={0}>
      <HostIdentityCard
        host={host}
        displayName={host.name}
        version={host.version}
        nameAction={null}
        nameInput={null}
        busy={extra?.busy ?? false}
        busySessionCount={extra?.busySessionCount ?? null}
        busyBreakdown={extra?.busyBreakdown ?? null}
        actions={null}
        healthAction={extra?.healthAction ?? null}
        lifecycleLine={extra?.lifecycleLine ?? null}
        costLine={extra?.costLine}
      >
        {host.sandbox === null ? null : (
          <SandboxHeaderNotices sandbox={host.sandbox} teamName={null} />
        )}
      </HostIdentityCard>
    </TooltipProvider>,
  );
}

describe("<HostIdentityCard /> a sandbox's state word against its health", () => {
  it("shows the health, not Awake, for an awake sandbox that cannot be reached", () => {
    renderCard(sandboxHost("awake", "offline", false), null);

    expect(screen.queryByTestId("host-identity-sandbox-state")).toBeNull();
    expect(screen.getByTestId("host-identity-health").textContent).toBe(
      "Offline",
    );
  });

  it("shows Suspended, and no health word, for a suspended sandbox that cannot be reached", () => {
    renderCard(sandboxHost("suspended", "offline", false), null);

    expect(screen.getByTestId("host-identity-sandbox-state").textContent).toBe(
      "Suspended",
    );
    expect(screen.queryByTestId("host-identity-health")).toBeNull();
  });

  it("keeps the Awake word for an awake sandbox that is reachable", () => {
    renderCard(sandboxHost("awake", "online", false), null);

    expect(screen.getByTestId("host-identity-sandbox-state").textContent).toBe(
      "Awake",
    );
    expect(screen.queryByTestId("host-identity-health")).toBeNull();
  });

  it("shows Out of credits beside the suspended state for a frozen sandbox", () => {
    renderCard(sandboxHost("suspended", "offline", true), null);

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
    renderCard(host, null);

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
    const visible = "2 agents · 1 terminal agent · 3 terminals";
    const host = sandboxHost("awake", "online", false);

    renderCard(host, {
      busy: true,
      busySessionCount: 6,
      busyBreakdown: breakdown,
    });

    const trigger = screen.getByRole("button", { name: visible });
    expect(screen.getByTestId("host-active-sessions").textContent).toBe(
      visible,
    );

    await user.tab();

    expect(document.activeElement).toBe(trigger);
    expect((await screen.findByRole("tooltip")).textContent).toBe(label);
    expect(
      screen.getByRole("button", { name: visible, description: label }),
    ).toBe(trigger);
  });
});

describe("<HostIdentityCard /> the name row and the fact line", () => {
  function computer(overrides: Partial<HostScopeOption>): HostScopeOption {
    return hostScopeOptionFixture({
      hostId: "host-a",
      name: "Studio Mac",
      kind: "personal",
      platform: "darwin-arm64",
      version: "1.4.2",
      ...overrides,
    });
  }

  function factLine(): HTMLElement {
    return screen.getByTestId("host-identity-fact-line");
  }

  it("puts the kind tag on the name row", () => {
    renderCard(computer({}), null);
    const row = screen.getByTestId("host-identity-name-row");
    expect(within(row).getByText("Computer")).toBeTruthy();
    expect(factLine().textContent).not.toContain("Computer");

    cleanup();
    renderCard(sandboxHost("awake", "online", false), null);
    const sandboxRow = screen.getByTestId("host-identity-name-row");
    expect(within(sandboxRow).getByText("Sandbox")).toBeTruthy();
    expect(
      screen.getByTestId("host-identity-sandbox-state").parentElement
        ?.textContent,
    ).not.toContain("Sandbox");
  });

  it("reads state, then platform, architecture, and version, then the work", () => {
    renderCard(
      computer({
        health: {
          state: "online",
          label: "Online",
          detail: null,
          tone: "live",
          live: true,
        },
      }),
      {
        busy: true,
        busySessionCount: 2,
        busyBreakdown: null,
      },
    );

    const text = factLine().textContent;
    const stateAt = text.indexOf("Online");
    const placeAt = text.indexOf("macOS · arm64 · v1.4.2");
    const workAt = text.indexOf("2 sessions");
    expect(stateAt).toBeGreaterThanOrEqual(0);
    expect(placeAt).toBeGreaterThan(stateAt);
    expect(workAt).toBeGreaterThan(placeAt);
    expect(screen.getByTestId("host-active-sessions").textContent).toBe(
      "2 sessions",
    );
  });

  it("keeps Idle when the host reports no work", () => {
    renderCard(computer({}), { busy: false, busySessionCount: 0 });
    expect(screen.getByTestId("host-active-sessions").textContent).toBe("Idle");
  });

  it("renders no work control when the host has not answered", () => {
    renderCard(computer({}), {
      busy: false,
      busySessionCount: null,
      busyBreakdown: null,
    });
    expect(screen.queryByTestId("host-active-sessions")).toBeNull();
  });

  it("keeps a live health detail off the line, and shows a detail with its remedy when the host needs an update or is not live", () => {
    renderCard(
      computer({
        health: {
          state: "online",
          label: "Online",
          detail: "Checked in moments ago",
          tone: "live",
          live: true,
        },
      }),
      null,
    );
    expect(factLine().textContent).not.toContain("Checked in moments ago");

    cleanup();
    renderCard(
      computer({
        health: {
          state: "update-required",
          label: "Update required",
          detail: "This host needs an update",
          tone: "idle",
          live: false,
        },
      }),
      { healthAction: <button type="button">Install the update</button> },
    );
    expect(factLine().textContent).toContain("This host needs an update");
    expect(
      screen.getByRole("button", { name: "Install the update" }),
    ).toBeTruthy();

    cleanup();
    renderCard(
      computer({
        health: {
          state: "offline",
          label: "Offline",
          detail: "last seen 3h ago",
          tone: "idle",
          live: false,
        },
      }),
      { healthAction: <button type="button">Reconnect</button> },
    );
    expect(factLine().textContent).toContain("last seen 3h ago");
    expect(screen.getByRole("button", { name: "Reconnect" })).toBeTruthy();
  });
});
