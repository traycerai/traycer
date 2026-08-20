import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SelectionChangeCause } from "@traycer-clients/shared/host-selection/selection-authority-contract";

const { toastInfo } = vi.hoisted(() => ({ toastInfo: vi.fn() }));
vi.mock("sonner", () => ({ toast: { info: toastInfo } }));

import { toastSelectionSwitched } from "@/lib/host/selection-switch-toast";

beforeEach(() => {
  toastInfo.mockClear();
});

describe("toastSelectionSwitched", () => {
  it("I1: cause failover with a previous host toasts exactly once, naming the new host", () => {
    toastSelectionSwitched({
      cause: "failover",
      previousEffectiveHostId: "L",
      hostLabel: "Cloud VM",
    });

    expect(toastInfo).toHaveBeenCalledTimes(1);
    const [message] = toastInfo.mock.calls[0] as [string];
    expect(message).toContain("Cloud VM");
  });

  it("I2: cause recovery with a previous host toasts exactly once", () => {
    toastSelectionSwitched({
      cause: "recovery",
      previousEffectiveHostId: "L",
      hostLabel: "Preferred Host",
    });

    expect(toastInfo).toHaveBeenCalledTimes(1);
    const [message] = toastInfo.mock.calls[0] as [string];
    expect(message).toContain("Preferred Host");
  });

  it("I3: cause recovery with previousEffectiveHostId null (first provision) is SILENT", () => {
    // Fresh install: the local host becoming usable for the first time is
    // the app starting, not a switch a user experienced. Toasting here would
    // narrate a move that never happened from the user's perspective.
    toastSelectionSwitched({
      cause: "recovery",
      previousEffectiveHostId: null,
      hostLabel: "This Mac",
    });

    expect(toastInfo).not.toHaveBeenCalled();
  });

  it("I4: cause activate is SILENT (the user's own Settings gesture already answers)", () => {
    toastSelectionSwitched({
      cause: "activate",
      previousEffectiveHostId: "L",
      hostLabel: "Cloud VM",
    });

    expect(toastInfo).not.toHaveBeenCalled();
  });

  it("I5: cause deregister-clear and fleet-shift are SILENT (bookkeeping, not a user-caused move)", () => {
    const bookkeepingCauses: SelectionChangeCause[] = [
      "deregister-clear",
      "fleet-shift",
    ];
    for (const cause of bookkeepingCauses) {
      toastSelectionSwitched({
        cause,
        previousEffectiveHostId: "L",
        hostLabel: "Cloud VM",
      });
    }

    expect(toastInfo).not.toHaveBeenCalled();
  });
});
