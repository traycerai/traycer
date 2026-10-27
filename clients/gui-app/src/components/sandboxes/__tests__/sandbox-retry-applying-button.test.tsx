import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

/**
 * The recovery on one host: `Retry applying` for a host that negotiated the
 * combined retry, where the surface hears `onApplied` only once the host
 * reports the settings applied (a configured guest alone is not that); and,
 * on a host that negotiated only the guest-only repair, `Repair setup` for a
 * guest that really failed - never for settings that merely did not apply.
 */

interface Outcome {
  readonly guestConfigured: boolean;
  readonly settingsApplied: boolean;
}

const mocks = vi.hoisted(() => ({
  hostIds: [] as string[],
  supportedHostIds: [] as string[],
  legacyHostIds: [] as string[],
  supported: true,
  legacySupported: false,
  outcome: { guestConfigured: true, settingsApplied: true } as Outcome,
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
        mutate: (
          variables: object,
          options: { readonly onSuccess: (outcome: Outcome) => void },
        ) => {
          mocks.combinedMutate(variables);
          options.onSuccess(mocks.outcome);
        },
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
  it("tells the surface once the host reports the settings applied, on that host", () => {
    mocks.outcome = { guestConfigured: true, settingsApplied: true };
    const onApplied = vi.fn();
    render(
      <SandboxRetryApplyingButton
        hostId="host-7"
        guestSetupFailed={false}
        onApplied={onApplied}
      />,
    );

    click("Retry applying");

    expect(onApplied).toHaveBeenCalledTimes(1);
    expect(new Set(mocks.hostIds)).toEqual(new Set(["host-7"]));
    expect(new Set(mocks.supportedHostIds)).toEqual(new Set(["host-7"]));
  });

  it("does not tell the surface when the guest is configured but the settings did not apply", () => {
    mocks.outcome = { guestConfigured: true, settingsApplied: false };
    const onApplied = vi.fn();
    render(
      <SandboxRetryApplyingButton
        hostId="host-7"
        guestSetupFailed={null}
        onApplied={onApplied}
      />,
    );

    click("Retry applying");

    expect(onApplied).not.toHaveBeenCalled();
  });

  it("offers Retry applying alone, even for a failed guest", () => {
    render(
      <SandboxRetryApplyingButton
        hostId="host-7"
        guestSetupFailed
        onApplied={vi.fn()}
      />,
    );

    expect(screen.getByRole("button", { name: "Retry applying" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Repair setup" })).toBeNull();
  });
});

describe("SandboxRetryApplyingButton on a host with only the guest-only repair", () => {
  function mountLegacy(
    guestSetupFailed: boolean | null,
    onApplied: () => void,
  ): void {
    mocks.supported = false;
    mocks.legacySupported = true;
    render(
      <SandboxRetryApplyingButton
        hostId="host-7"
        guestSetupFailed={guestSetupFailed}
        onApplied={onApplied}
      />,
    );
  }

  it("offers Repair setup for a guest that really failed, and never reports the settings applied", () => {
    const onApplied = vi.fn();
    mountLegacy(true, onApplied);

    expect(screen.queryByRole("button", { name: "Retry applying" })).toBeNull();
    click("Repair setup");

    expect(mocks.legacyMutate).toHaveBeenCalledTimes(1);
    expect(new Set(mocks.legacyHostIds)).toEqual(new Set(["host-7"]));
    expect(mocks.combinedMutate).not.toHaveBeenCalled();
    expect(onApplied).not.toHaveBeenCalled();
  });

  it.each([
    ["a configured guest", false],
    ["an unknown guest", null],
  ])(
    "offers nothing for %s: settings that did not apply are not a guest failure",
    (_name, guestSetupFailed) => {
      mountLegacy(guestSetupFailed, vi.fn());

      expect(screen.queryByRole("button")).toBeNull();
    },
  );
});

describe("SandboxRetryApplyingButton on a host that serves neither", () => {
  it("offers nothing, even for a failed guest", () => {
    mocks.supported = false;
    mocks.legacySupported = false;
    render(
      <SandboxRetryApplyingButton
        hostId="host-7"
        guestSetupFailed
        onApplied={vi.fn()}
      />,
    );

    expect(screen.queryByRole("button")).toBeNull();
  });
});
