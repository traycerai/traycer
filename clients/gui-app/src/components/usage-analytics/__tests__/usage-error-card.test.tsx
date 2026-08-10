import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import type { RpcErrorCode } from "@traycer/protocol/framework";
import { UsageErrorCard } from "@/components/usage-analytics/usage-error-card";

afterEach(cleanup);

function rpcError(code: RpcErrorCode, message: string): HostRpcError {
  return new HostRpcError({
    code,
    message,
    requestId: "test",
    method: "host.usage.summary",
    fatalDetails: null,
  });
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

  it("falls back to a generic cloud-unreachable headline for other failures", () => {
    render(
      <UsageErrorCard
        error={rpcError("RPC_ERROR", "network blip")}
        onRetry={() => undefined}
      />,
    );
    expect(
      screen.getByText("Couldn't reach Traycer Cloud for usage data."),
    ).not.toBeNull();
  });
});
