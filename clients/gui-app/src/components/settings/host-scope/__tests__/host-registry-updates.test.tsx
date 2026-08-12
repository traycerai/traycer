/**
 * `ApplyNowControl` refusal composition: the drain-gate force names a count
 * ("Apply now — ends N sessions") and destroys that many sessions on
 * confirm. This pins the review's ask directly — with the dialog open,
 * `liveBusySessionCount` changing underneath it (to a different number, and
 * to `null`) must make confirming a NO-OP and change the description copy,
 * following the same arm-time-capture pattern `targetMoved` already uses.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import type { HostListItem } from "@traycer/protocol/host/host-status";

const { mutateSpy } = vi.hoisted(() => ({ mutateSpy: vi.fn() }));

vi.mock("@/hooks/auth/use-update-host-version-mutation", () => ({
  useUpdateHostVersionPolicy: () => ({
    mutate: mutateSpy,
    isPending: false,
  }),
}));

import { HostRegistryUpdates } from "@/components/settings/host-scope/host-registry-updates";

function pendingRegistryItem(hostId: string): HostListItem {
  return {
    hostId,
    displayName: "Studio Mac",
    platform: "darwin-arm64",
    kind: "personal",
    publicKey: "pk",
    createdAt: "2026-01-01T00:00:00Z",
    updatePolicy: "manual",
    status: {
      connectivity: "connectable",
      viewerReachability: "unknown",
      clientCloud: "ok",
      updateState: "pending",
      appVersion: "1.4.2",
      lastSeenAt: "2026-01-01T00:00:00Z",
    },
  };
}

afterEach(() => {
  cleanup();
  mutateSpy.mockClear();
});

describe("ApplyNowControl — armed count vs live count at confirm time", () => {
  it("arms with the current live count, then refuses to confirm once that count changes — description explains why", () => {
    const item = pendingRegistryItem("host-a");
    const { rerender } = render(
      <HostRegistryUpdates item={item} liveBusySessionCount={2} />,
    );

    fireEvent.click(screen.getByTestId("host-apply-now-trigger-host-a"));
    const dialog = screen.getByRole("dialog");
    expect(dialog.textContent).toMatch(
      /ends every open terminal and agent session/i,
    );

    // The live count moves while the dialog stands open — a session opened,
    // or the read simply changed between renders.
    rerender(<HostRegistryUpdates item={item} liveBusySessionCount={5} />);

    expect(dialog.textContent).toMatch(/no longer 2/);
    fireEvent.click(within(dialog).getByTestId("confirm-action"));

    expect(mutateSpy).not.toHaveBeenCalled();
  });

  it("withdraws the whole drain-gate force (trigger AND open dialog) when the live count is lost — never a stale confirm surface", () => {
    // NOTE for the reviewer: `describeApplyNowConfirmation`'s `armedCount ===
    // null` branch ("We can't currently see how many sessions are open…")
    // reads as if it is reachable with the dialog left open and a refusal
    // message shown, mirroring the moved-to-a-different-number case below.
    // It is not, as composed here: `deriveUpdateAffordance` nulls
    // `applyNowLabel` itself whenever `liveBusySessionCount` is `null` while
    // `updateState` is `pending`, and `HostRegistryUpdates` gates the ENTIRE
    // block (trigger button, `ApplyNowControl`, and therefore any open
    // dialog) on `applyNowLabel !== null`. So losing the live count doesn't
    // leave a stale, unconfirmable dialog behind — it unmounts the affordance
    // outright, dialog included. Still safe (no confirm can fire on a control
    // that no longer exists), but the `armedCount === null` copy branch this
    // suite's brief called out is unreachable through this component as
    // currently composed; see the handoff report.
    const item = pendingRegistryItem("host-b");
    const { rerender } = render(
      <HostRegistryUpdates item={item} liveBusySessionCount={3} />,
    );

    fireEvent.click(screen.getByTestId("host-apply-now-trigger-host-b"));
    expect(screen.getByRole("dialog")).not.toBeNull();

    rerender(<HostRegistryUpdates item={item} liveBusySessionCount={null} />);

    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.queryByTestId("host-apply-now-trigger-host-b")).toBeNull();
    expect(mutateSpy).not.toHaveBeenCalled();
  });

  it("confirms normally when the live count stays exactly what was armed", () => {
    const item = pendingRegistryItem("host-c");
    render(<HostRegistryUpdates item={item} liveBusySessionCount={4} />);

    fireEvent.click(screen.getByTestId("host-apply-now-trigger-host-c"));
    const dialog = screen.getByRole("dialog");
    fireEvent.click(within(dialog).getByTestId("confirm-action"));

    expect(mutateSpy).toHaveBeenCalledTimes(1);
    expect(mutateSpy).toHaveBeenCalledWith(
      { updatePolicy: undefined, desiredVersion: undefined, force: true },
      expect.anything(),
    );
  });
});
