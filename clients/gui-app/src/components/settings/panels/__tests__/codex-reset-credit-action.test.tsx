import "../../../../../__tests__/test-browser-apis";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ProvidersConsumeRateLimitResetCreditRequest } from "@traycer/protocol/host/rate-limit";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  isPending: false,
  mutate:
    vi.fn<
      (
        request: ProvidersConsumeRateLimitResetCreditRequest,
        options: { readonly onSuccess: () => void },
      ) => void
    >(),
}));

vi.mock(
  "@/hooks/providers/use-consume-rate-limit-reset-credit-mutation",
  () => ({
    useConsumeRateLimitResetCreditMutation: () => ({
      isPending: mocks.isPending,
      mutate: mocks.mutate,
    }),
  }),
);

import { CodexResetCreditAction } from "../codex-reset-credit-action";

afterEach(() => {
  cleanup();
  mocks.isPending = false;
  mocks.mutate.mockReset();
});

describe("CodexResetCreditAction", () => {
  it("confirms the selected expiry and sends a targeted idempotent request", () => {
    render(
      <CodexResetCreditAction
        profileId="personal"
        availableCount={2}
        selectedCredit={{
          id: "credit-soon",
          resetType: "codexRateLimits",
          status: "available",
          grantedAt: Date.now() - 60 * 60 * 1000,
          expiresAt: Date.now() + 2 * 60 * 60 * 1000,
          title: "Manual reset",
          description: null,
        }}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Use reset" }));
    expect(screen.getByText("Use a Codex manual reset?")).toBeTruthy();
    expect(screen.getByText(/This uses the reset expiring in/)).toBeTruthy();
    expect(screen.getByText(/You'll have 1 manual reset left/)).toBeTruthy();
    expect(mocks.mutate).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId("confirm-action"));
    expect(mocks.mutate).toHaveBeenCalledOnce();
    const request = mocks.mutate.mock.calls[0]?.[0];
    expect(request).toMatchObject({
      providerId: "codex",
      profileId: "personal",
      creditId: "credit-soon",
    });
    expect(typeof request.idempotencyKey).toBe("string");

    fireEvent.click(screen.getByTestId("confirm-action"));
    const retry = mocks.mutate.mock.calls[1]?.[0];
    expect(retry.idempotencyKey).toBe(request.idempotencyKey);
  });

  it("keeps the generic count-only confirmation when credit detail is unavailable", () => {
    render(
      <CodexResetCreditAction
        profileId={null}
        availableCount={3}
        selectedCredit={null}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Use reset" }));
    expect(
      screen.getByText(
        "This uses one manual reset on the currently reached Codex usage limit. The reset can't be returned or undone.",
      ),
    ).toBeTruthy();
    fireEvent.click(screen.getByTestId("confirm-action"));
    expect(mocks.mutate.mock.calls[0]?.[0]).toMatchObject({ creditId: null });
  });
});
