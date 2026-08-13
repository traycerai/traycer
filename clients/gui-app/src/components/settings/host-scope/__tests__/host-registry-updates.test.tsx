/**
 * `ApplyNowControl` refusal composition: the drain-gate force names a count
 * ("Apply now — ends N sessions") and destroys that many sessions on
 * confirm. This pins the review's ask directly — with the dialog open,
 * `liveBusySessionCount` changing underneath it (to a different number, and
 * to `null`) must make confirming a NO-OP and change the description copy,
 * following the same arm-time-capture pattern `targetMoved` already uses.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
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

describe("ApplyNowControl — armed count vs settled count at confirm time", () => {
  it("arms with the current settled count, then refuses to confirm once that count changes — description explains why", () => {
    const item = pendingRegistryItem("host-a");
    const { rerender } = render(
      <HostRegistryUpdates
        item={item}
        liveBusySessionCount={2}
        settledBusySessionCount={2}
      />,
    );

    fireEvent.click(screen.getByTestId("host-apply-now-trigger-host-a"));
    const dialog = screen.getByRole("dialog");
    expect(dialog.textContent).toMatch(
      /ends every open terminal and agent session/i,
    );

    // The count moves while the dialog stands open — a session opened,
    // or the read simply changed between renders.
    rerender(
      <HostRegistryUpdates
        item={item}
        liveBusySessionCount={5}
        settledBusySessionCount={5}
      />,
    );

    expect(dialog.textContent).toMatch(/no longer 2/);
    fireEvent.click(within(dialog).getByTestId("confirm-action"));

    expect(mutateSpy).not.toHaveBeenCalled();
  });

  it("withdraws the whole drain-gate force (trigger AND open dialog) when the display count is lost — never a stale confirm surface", () => {
    // Losing the DISPLAY read is still the strongest outcome:
    // `deriveUpdateAffordance` nulls `applyNowLabel` whenever
    // `liveBusySessionCount` is `null` while `updateState` is `pending`, and
    // `HostRegistryUpdates` gates the ENTIRE block (trigger button,
    // `ApplyNowControl`, and therefore any open dialog) on
    // `applyNowLabel !== null`. So this does not leave a stale, unconfirmable
    // dialog behind — it unmounts the affordance outright, dialog included.
    //
    // What is NOT covered by that unmount is the settled read going away on
    // its own while the display read survives, which is what a refetch does.
    // That case is the next two tests, and it is why this component takes two
    // numbers.
    const item = pendingRegistryItem("host-b");
    const { rerender } = render(
      <HostRegistryUpdates
        item={item}
        liveBusySessionCount={3}
        settledBusySessionCount={3}
      />,
    );

    fireEvent.click(screen.getByTestId("host-apply-now-trigger-host-b"));
    expect(screen.getByRole("dialog")).not.toBeNull();

    rerender(
      <HostRegistryUpdates
        item={item}
        liveBusySessionCount={null}
        settledBusySessionCount={null}
      />,
    );

    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.queryByTestId("host-apply-now-trigger-host-b")).toBeNull();
    expect(mutateSpy).not.toHaveBeenCalled();
  });

  it("confirms normally when the settled count stays exactly what was armed", () => {
    const item = pendingRegistryItem("host-c");
    render(
      <HostRegistryUpdates
        item={item}
        liveBusySessionCount={4}
        settledBusySessionCount={4}
      />,
    );

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

/**
 * The display/destructive split (repair round 3, finding 4).
 *
 * A retained-through-refetch count is good enough to READ and not good enough
 * to DESTROY things by. The two tests below are the two halves of that
 * sentence, and they are deliberately adjacent: pass them the same props and
 * one asserts the row still says "2", the other asserts nothing can be armed
 * from it.
 */
describe("ApplyNowControl — refetch splits display from arming", () => {
  it("keeps rendering the retained count while a replacement read is in flight", () => {
    const item = pendingRegistryItem("host-d");
    render(
      <HostRegistryUpdates
        item={item}
        liveBusySessionCount={2}
        settledBusySessionCount={null}
      />,
    );

    // The row does not blank for the length of a round trip.
    expect(
      screen.getByTestId("host-apply-now-trigger-host-d").textContent,
    ).toContain("ends 2 sessions");
  });

  it("refuses to arm from that same retained count", () => {
    const item = pendingRegistryItem("host-e");
    render(
      <HostRegistryUpdates
        item={item}
        liveBusySessionCount={2}
        settledBusySessionCount={null}
      />,
    );

    const trigger = screen.getByTestId("host-apply-now-trigger-host-e");
    expect(trigger.hasAttribute("disabled")).toBe(true);

    fireEvent.click(trigger);

    expect(screen.queryByRole("dialog")).toBeNull();
    expect(mutateSpy).not.toHaveBeenCalled();
  });

  it("auto-disarms an already-open confirmation when a refetch starts", () => {
    // The concrete failure this closes: armed at 2, a focus refetch begins
    // while the host is actually at 5, and the confirm-time guard compares the
    // retained 2 to the armed 2, agrees with itself, and ends five sessions
    // while promising two. With the settled read the guard has nothing to
    // agree with, so it refuses.
    const item = pendingRegistryItem("host-f");
    const { rerender } = render(
      <HostRegistryUpdates
        item={item}
        liveBusySessionCount={2}
        settledBusySessionCount={2}
      />,
    );

    fireEvent.click(screen.getByTestId("host-apply-now-trigger-host-f"));
    const dialog = screen.getByRole("dialog");

    rerender(
      <HostRegistryUpdates
        item={item}
        liveBusySessionCount={2}
        settledBusySessionCount={null}
      />,
    );

    expect(dialog.textContent).toMatch(
      /can't currently see how many sessions/i,
    );
    fireEvent.click(within(dialog).getByTestId("confirm-action"));

    expect(mutateSpy).not.toHaveBeenCalled();
  });
});
