import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import type { HostLeaseSnapshot } from "@traycer-clients/shared/host-selection/selection-authority-contract";
import type { HostDoorState } from "@traycer-clients/shared/host-transport/host-door-state";
import {
  deriveWindowNarration,
  type WindowNarrationInput,
} from "@/lib/host/window-narration";
import { noteHostMembershipChanged } from "@/lib/host/local-admission-invalidation";
import {
  WindowHostModal,
  type WindowHostModalProps,
} from "@/components/layout/dialogs/window-host-modal";
import {
  hostDoorStateFor,
  noteHostDoorState,
  useHostDoorStateStore,
} from "@/stores/host/host-door-state-store";
import { useAuthStore } from "@/stores/auth/auth-store";

function narrationInput(
  overrides: Partial<WindowNarrationInput> | undefined,
): WindowNarrationInput {
  return {
    attached: true,
    effectiveHostId: null,
    targetHostId: null,
    leases: [],
    hasBeenServed: false,
    localHostExpected: true,
    discoveryConcluded: false,
    localHostId: "local-host",
    ...(overrides ?? {}),
  };
}

function servingLease(hostId: string): HostLeaseSnapshot {
  return { hostId, status: "ready", dead: null };
}

function door(kind: HostDoorState["kind"], hostId: string): HostDoorState {
  return { hostId, kind, detail: null };
}

function modalProps(
  variant: WindowHostModalProps["variant"],
  overrides: Partial<WindowHostModalProps> | undefined,
): WindowHostModalProps {
  return {
    cause: "no-usable-host",
    variant,
    progress: null,
    bootBody: null,
    onRetry: null,
    retryPending: false,
    onUpdateHost: null,
    onOpenSettings: () => undefined,
    showReportIssue: false,
    settingsEmphasis: "button",
    settingsOnly: false,
    ...(overrides ?? {}),
  };
}

function setSignedInIdentity(userId: string): void {
  useAuthStore.setState({
    status: "signed-in",
    contextMetadata: { userId, username: userId },
  });
}

afterEach(() => {
  cleanup();
  useHostDoorStateStore.setState({ byHost: new Map() });
  useAuthStore.setState({
    status: "signed-out",
    contextMetadata: null,
  });
});

describe("door state narration", () => {
  it("draws the team cover for not-a-member even while a host is serving", () => {
    const served = narrationInput({
      effectiveHostId: "remote-host",
      targetHostId: "remote-host",
      hasBeenServed: true,
      leases: [servingLease("remote-host")],
    });

    expect(
      deriveWindowNarration({
        ...served,
        doorState: door("not-a-member", "local-host"),
      }),
    ).toEqual({
      kind: "narrating",
      cause: "no-usable-host",
      variant: { kind: "team-membership-required" },
    });
  });

  it("draws the offline cover for another blocking state only while nothing serves", () => {
    const waiting = narrationInput({});
    expect(
      deriveWindowNarration({
        ...waiting,
        doorState: door("token-unavailable", "local-host"),
      }),
    ).toEqual({
      kind: "narrating",
      cause: "no-usable-host",
      variant: { kind: "offline" },
    });
    expect(deriveWindowNarration(waiting)).toEqual({
      kind: "narrating",
      cause: "cold-start",
      variant: { kind: "offline" },
    });

    const served = narrationInput({
      effectiveHostId: "remote-host",
      targetHostId: "remote-host",
      hasBeenServed: true,
      leases: [servingLease("remote-host")],
    });
    expect(
      deriveWindowNarration({
        ...served,
        doorState: door("older-host", "local-host"),
      }),
    ).toEqual(deriveWindowNarration(served));
  });

  it("draws nothing for a non-blocking door state", () => {
    const waiting = narrationInput({});
    expect(
      deriveWindowNarration({
        ...waiting,
        doorState: door("access-check-delayed", "local-host"),
      }),
    ).toEqual(deriveWindowNarration(waiting));
  });

  it("shows the switch-account sentence for a non-member and the offline sentence for every other block", () => {
    render(
      <WindowHostModal
        {...modalProps(
          { kind: "team-membership-required" },
          { onSwitchAccount: () => undefined },
        )}
      />,
    );

    expect(screen.getByTestId("window-host-modal-title").textContent).toContain(
      "This computer belongs to a team",
    );
    expect(
      screen.getByText(
        "This account is not a member. Switch accounts to use Traycer here.",
      ),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "Switch account" })).toBeTruthy();
    expect(screen.queryByTestId("window-host-modal-retry")).toBeNull();
    expect(screen.queryByText(/No host is available/i)).toBeNull();

    cleanup();
    render(<WindowHostModal {...modalProps({ kind: "offline" }, undefined)} />);

    expect(screen.getByTestId("window-host-modal-title").textContent).toContain(
      "No host is available",
    );
    expect(screen.queryByRole("button", { name: "Switch account" })).toBeNull();
    expect(screen.queryByText(/Update/i)).toBeNull();
  });
});

describe("door state store", () => {
  it("drops every state when the signed-in person changes or signs out", () => {
    setSignedInIdentity("user-a");
    noteHostDoorState(door("not-a-member", "local-host"));
    noteHostDoorState(door("token-unavailable", "other-host"));
    expect(useHostDoorStateStore.getState().byHost.size).toBe(2);

    setSignedInIdentity("user-b");
    expect(useHostDoorStateStore.getState().byHost.size).toBe(0);

    noteHostDoorState(door("not-admitted", "local-host"));
    expect(useHostDoorStateStore.getState().byHost.size).toBe(1);

    useAuthStore.setState({ status: "signed-out", contextMetadata: null });
    expect(useHostDoorStateStore.getState().byHost.size).toBe(0);
  });

  it("clears one host when its membership changes", () => {
    noteHostDoorState(door("not-a-member", "local-host"));
    noteHostDoorState(door("older-host", "remote-host"));

    noteHostMembershipChanged("local-host");

    expect(hostDoorStateFor("local-host")).toBeNull();
    expect(hostDoorStateFor("remote-host")).toEqual(
      door("older-host", "remote-host"),
    );
  });
});
