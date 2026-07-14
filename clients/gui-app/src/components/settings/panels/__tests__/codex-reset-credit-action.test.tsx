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
  it("requires confirmation and sends a profile-scoped idempotent request", () => {
    render(<CodexResetCreditAction profileId="personal" />);

    fireEvent.click(screen.getByRole("button", { name: "Use reset" }));
    expect(screen.getByText("Use a Codex manual reset?")).toBeTruthy();
    expect(mocks.mutate).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId("confirm-action"));
    expect(mocks.mutate).toHaveBeenCalledOnce();
    const request = mocks.mutate.mock.calls[0]?.[0];
    expect(request).toMatchObject({
      providerId: "codex",
      profileId: "personal",
    });
    expect(typeof request.idempotencyKey).toBe("string");

    fireEvent.click(screen.getByTestId("confirm-action"));
    const retry = mocks.mutate.mock.calls[1]?.[0];
    expect(retry.idempotencyKey).toBe(request.idempotencyKey);
  });
});
