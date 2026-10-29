import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

/**
 * The recovery on one host: `Retry applying` for a host that negotiated the
 * combined retry; and, on a host that negotiated only the guest-only repair,
 * `Repair setup` for a guest that really failed - never for settings that
 * merely did not apply.
 */

const mocks = vi.hoisted(() => ({
  hostIds: [] as string[],
  supportedHostIds: [] as string[],
  legacyHostIds: [] as string[],
  supported: true,
  legacySupported: false,
  legacyMutate: vi.fn(),
  combinedMutate: vi.fn(),
}));

vi.mock(
  "@/hooks/sandboxes/use-sandbox-repair-guest-configuration-mutation",
  () => ({
    useSandboxRepairGuestConfigurationOnHost: (hostId: string) => {
      mocks.hostIds.push(hostId);
      return {
        isPending: false,
        mutate: mocks.combinedMutate,
      };
    },
    useSandboxRetryApplyingSupported: (hostId: string) => {
      mocks.supportedHostIds.push(hostId);
      return mocks.supported;
    },
    useSandboxGuestSetupRepairSupported: () => mocks.legacySupported,
    useSandboxRepairGuestSetupOnHost: (hostId: string) => {
      mocks.legacyHostIds.push(hostId);
      return { isPending: false, mutate: mocks.legacyMutate };
    },
    useSandboxSettingsOperation: () => null,
  }),
);

import { SandboxRetryApplyingButton } from "@/components/sandboxes/sandbox-retry-applying-button";

afterEach(() => {
  cleanup();
  mocks.hostIds.length = 0;
  mocks.supportedHostIds.length = 0;
  mocks.legacyHostIds.length = 0;
  mocks.supported = true;
  mocks.legacySupported = false;
  mocks.legacyMutate.mockReset();
  mocks.combinedMutate.mockReset();
});

function click(name: string): void {
  fireEvent.click(screen.getByRole("button", { name }));
}

describe("SandboxRetryApplyingButton on a host with the combined retry", () => {
  it("retries on the named host", () => {
    render(
      <SandboxRetryApplyingButton hostId="host-7" guestSetupFailed={false} />,
    );

    click("Retry applying");

    expect(mocks.combinedMutate).toHaveBeenCalledTimes(1);
    expect(mocks.legacyMutate).not.toHaveBeenCalled();
    expect(new Set(mocks.hostIds)).toEqual(new Set(["host-7"]));
    expect(new Set(mocks.supportedHostIds)).toEqual(new Set(["host-7"]));
  });

  it("offers Retry applying alone, even for a failed guest", () => {
    render(<SandboxRetryApplyingButton hostId="host-7" guestSetupFailed />);

    expect(screen.getByRole("button", { name: "Retry applying" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Repair setup" })).toBeNull();
  });
});

describe("SandboxRetryApplyingButton on a host with only the guest-only repair", () => {
  function mountLegacy(guestSetupFailed: boolean | null): void {
    mocks.supported = false;
    mocks.legacySupported = true;
    render(
      <SandboxRetryApplyingButton
        hostId="host-7"
        guestSetupFailed={guestSetupFailed}
      />,
    );
  }

  it("offers Repair setup for a guest that really failed", () => {
    mountLegacy(true);

    expect(screen.queryByRole("button", { name: "Retry applying" })).toBeNull();
    click("Repair setup");

    expect(mocks.legacyMutate).toHaveBeenCalledTimes(1);
    expect(new Set(mocks.legacyHostIds)).toEqual(new Set(["host-7"]));
    expect(mocks.combinedMutate).not.toHaveBeenCalled();
  });

  it.each([
    ["a configured guest", false],
    ["an unknown guest", null],
  ])(
    "offers nothing for %s: settings that did not apply are not a guest failure",
    (_name, guestSetupFailed) => {
      mountLegacy(guestSetupFailed);

      expect(screen.queryByRole("button")).toBeNull();
    },
  );
});

describe("SandboxRetryApplyingButton on a host that serves neither", () => {
  it("offers nothing, even for a failed guest", () => {
    mocks.supported = false;
    mocks.legacySupported = false;
    render(<SandboxRetryApplyingButton hostId="host-7" guestSetupFailed />);

    expect(screen.queryByRole("button")).toBeNull();
  });
});
