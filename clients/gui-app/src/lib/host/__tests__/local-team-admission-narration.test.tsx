import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import type { HostLeaseSnapshot } from "@traycer-clients/shared/host-selection/selection-authority-contract";
import {
  deriveWindowNarration,
  type WindowNarrationInput,
} from "@/lib/host/window-narration";
import {
  WindowHostModal,
  type WindowHostModalProps,
} from "@/components/layout/dialogs/window-host-modal";
import {
  noteLocalTeamAdmission,
  useLocalTeamAdmissionStore,
} from "@/stores/host/local-team-admission-store";
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
    discoveryConcluded: true,
    localHostId: "local-host",
    ...(overrides ?? {}),
  };
}

function lease(
  hostId: string,
  status: HostLeaseSnapshot["status"],
): HostLeaseSnapshot {
  return { hostId, status, dead: null } as HostLeaseSnapshot;
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
  useLocalTeamAdmissionStore.setState({ byHost: new Map() });
  useAuthStore.setState({
    status: "signed-out",
    contextMetadata: null,
  });
});

describe("local team admission narration", () => {
  it.each([
    ["required", "team-membership-required"],
    ["unavailable", "team-membership-unavailable"],
    ["checking", "team-membership-checking"],
  ] as const)("narrates the local admission state %s", (admission, kind) => {
    expect(
      deriveWindowNarration(narrationInput({ localTeamAdmission: admission })),
    ).toEqual({
      kind: "narrating",
      cause: "no-usable-host",
      variant: { kind },
    });
  });

  it("does not let local admission state replace a serving remote target", () => {
    const state = deriveWindowNarration(
      narrationInput({
        effectiveHostId: "remote-host",
        targetHostId: "remote-host",
        localTeamAdmission: "required",
        hasBeenServed: true,
        leases: [lease("remote-host", "ready")],
      }),
    );

    expect(state).not.toEqual(
      expect.objectContaining({
        kind: "narrating",
        variant: { kind: "team-membership-required" },
      }),
    );
  });

  it("shows a switch-account action for a nonmember without generic retry or offline copy", () => {
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
    expect(screen.getByRole("button", { name: "Switch account" })).toBeTruthy();
    expect(screen.queryByTestId("window-host-modal-retry")).toBeNull();
    expect(screen.queryByText(/No host is available/i)).toBeNull();
  });

  it.each([
    ["team-membership-unavailable", "Team membership could not be checked"],
    ["team-membership-checking", "Checking team membership"],
  ] as const)(
    "shows specific copy for %s instead of generic offline copy",
    (kind, title) => {
      render(<WindowHostModal {...modalProps({ kind }, undefined)} />);

      expect(
        screen.getByTestId("window-host-modal-title").textContent,
      ).toContain(title);
      expect(screen.queryByText(/No host is available/i)).toBeNull();
      expect(screen.queryByTestId("window-host-modal-retry")).toBeNull();
      cleanup();
    },
  );
});

describe("local team admission store identity scope", () => {
  it("accepts observations only for the active user and clears them when identity changes", () => {
    setSignedInIdentity("user-a");
    noteLocalTeamAdmission("local-host", "user-b", "required");
    expect(useLocalTeamAdmissionStore.getState().byHost.size).toBe(0);

    noteLocalTeamAdmission("local-host", "user-a", "checking");
    expect(
      useLocalTeamAdmissionStore.getState().byHost.get("local-host"),
    ).toEqual({
      userId: "user-a",
      state: "checking",
    });

    setSignedInIdentity("user-b");
    expect(useLocalTeamAdmissionStore.getState().byHost.size).toBe(0);
  });

  it("clears observations on sign-out", () => {
    setSignedInIdentity("user-a");
    noteLocalTeamAdmission("local-host", "user-a", "required");
    expect(useLocalTeamAdmissionStore.getState().byHost.size).toBe(1);

    useAuthStore.setState({ status: "signed-out", contextMetadata: null });
    expect(useLocalTeamAdmissionStore.getState().byHost.size).toBe(0);
  });
});
