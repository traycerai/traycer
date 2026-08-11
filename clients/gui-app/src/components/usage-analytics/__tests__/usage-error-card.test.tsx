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
