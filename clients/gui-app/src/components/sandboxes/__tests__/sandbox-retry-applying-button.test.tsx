import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

/**
 * "Retry applying" on one host: the click is addressed to that host's own
 * repair, and the surface hears `onApplied` only once the host reports the
 * settings applied.
 */

const mocks = vi.hoisted(() => ({
  hostIds: [] as string[],
  outcome: { guestConfigured: true } as { guestConfigured: boolean },
}));

vi.mock(
  "@/hooks/sandboxes/use-sandbox-repair-guest-configuration-mutation",
  () => ({
    useSandboxRepairGuestConfigurationOnHost: (hostId: string) => {
      mocks.hostIds.push(hostId);
      return {
        isPending: false,
        mutate: (
          _variables: object,
          options: {
            readonly onSuccess: (outcome: { guestConfigured: boolean }) => void;
          },
        ) => {
          options.onSuccess(mocks.outcome);
        },
      };
    },
    useSandboxSettingsOperation: () => null,
  }),
);

import { SandboxRetryApplyingButton } from "@/components/sandboxes/sandbox-retry-applying-button";

afterEach(() => {
  cleanup();
  mocks.hostIds.length = 0;
});

describe("SandboxRetryApplyingButton", () => {
  it("tells the surface once the host reports the settings applied, on that host", () => {
    mocks.outcome = { guestConfigured: true };
    const onApplied = vi.fn();
    render(<SandboxRetryApplyingButton hostId="host-7" onApplied={onApplied} />);

    fireEvent.click(screen.getByRole("button", { name: "Retry applying" }));

    expect(onApplied).toHaveBeenCalledTimes(1);
    expect(new Set(mocks.hostIds)).toEqual(new Set(["host-7"]));
  });

  it("does not tell the surface when the settings still did not apply", () => {
    mocks.outcome = { guestConfigured: false };
    const onApplied = vi.fn();
    render(<SandboxRetryApplyingButton hostId="host-7" onApplied={onApplied} />);

    fireEvent.click(screen.getByRole("button", { name: "Retry applying" }));

    expect(onApplied).not.toHaveBeenCalled();
  });
});
