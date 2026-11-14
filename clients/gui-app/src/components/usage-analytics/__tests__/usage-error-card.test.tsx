import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import type { RpcErrorCode } from "@traycer/protocol/framework";
import type { FatalErrorDetails } from "@traycer/protocol/framework/ws-protocol";
import { useAuthStore } from "@/stores/auth/auth-store";
import { UsageErrorCard } from "@/components/usage-analytics/usage-error-card";

afterEach(() => {
  cleanup();
  useAuthStore.getState().setSignedOut();
});

function rpcError(code: RpcErrorCode, message: string): HostRpcError {
  return new HostRpcError({
    code,
    message,
    requestId: "test",
    method: "host.usage.summary",
    fatalDetails: null,
  });
}

function headlineRpcError(
  code: RpcErrorCode,
  doorReason: string | undefined,
): HostRpcError {
  const doorRefusal: FatalErrorDetails | null =
    doorReason === undefined
      ? null
      : {
          code,
          reason: "host refused the request",
          incompatibleMethods: null,
          upgradeGuidance: null,
          doorReason,
        };
  return new HostRpcError({
    code,
    message: "host refused the request",
    requestId: "req-usage-headline",
    method: "host.usage.summary",
    fatalDetails: null,
    doorRefusal,
  });
}

function setSignedInForHeadline(): void {
  useAuthStore.getState().setSignedIn(
    { userId: "user-1", userName: "U", email: "u@example.com" },
    { userId: "user-1", username: "U" },
    [],
  );
}

describe("UsageErrorCard", () => {
  it("offers a Retry action that calls back - the cloud-unavailable path is retryable, never a silent local fallback", () => {
    const onRetry = vi.fn();
    render(
      <UsageErrorCard
        error={rpcError("RPC_ERROR", "cloud call failed")}
        onRetry={onRetry}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(onRetry).toHaveBeenCalledOnce();
  });

  it("shows a sign-in specific headline for UNAUTHORIZED", () => {
    render(
      <UsageErrorCard
        error={rpcError("UNAUTHORIZED", "expired session")}
        onRetry={() => undefined}
      />,
    );
    expect(screen.getByText("Please sign in again.")).not.toBeNull();
  });

  it.each([
    {
      name: "token_expired under UNAUTHORIZED while signed in",
      code: "UNAUTHORIZED",
      doorReason: "token_expired",
      signedIn: true,
      headline: "Couldn't load usage data.",
    },
    {
      name: "reasonless UNAUTHORIZED while signed in",
      code: "UNAUTHORIZED",
      doorReason: undefined,
      signedIn: true,
      headline: "Couldn't load usage data.",
    },
    {
      name: "reasonless UNAUTHORIZED while signed out",
      code: "UNAUTHORIZED",
      doorReason: undefined,
      signedIn: false,
      headline: "Please sign in again.",
    },
    {
      name: "reasonless FORBIDDEN",
      code: "FORBIDDEN",
      doorReason: undefined,
      signedIn: true,
      headline: "You don't have permission to view usage for this host.",
    },
  ] as const)("renders the $name headline", (testCase) => {
    if (testCase.signedIn) setSignedInForHeadline();
    else useAuthStore.getState().setSignedOut();
    render(
      <UsageErrorCard
        error={headlineRpcError(testCase.code, testCase.doorReason)}
        onRetry={() => undefined}
      />,
    );
    expect(screen.getByText(testCase.headline)).not.toBeNull();
  });

  it("falls back to a plane-neutral headline, since a failed read never reveals which reader would have answered", () => {
    render(
      <UsageErrorCard
        error={rpcError("RPC_ERROR", "sqlite: database is locked")}
        onRetry={() => undefined}
      />,
    );
    // Naming Traycer Cloud here would send a local-plane account chasing
    // connectivity for a local-database failure.
    expect(screen.getByText("Couldn't load usage data.")).not.toBeNull();
    expect(screen.queryByText(/Traycer Cloud/)).toBeNull();
    // The specific cause still reaches the reader through the message line.
    expect(screen.getByText("sqlite: database is locked")).not.toBeNull();
  });
});
