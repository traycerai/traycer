import { describe, expect, it } from "vitest";
import {
  HostRpcError,
  HostTransportFailureError,
  RetryableTransportError,
  isTransientHostRpcFailure,
} from "../host-messenger";

const base = {
  code: "RPC_ERROR" as const,
  message: "boom",
  requestId: "req-1",
  method: "host.echo",
  fatalDetails: null,
};

describe("isTransientHostRpcFailure", () => {
  it("classifies transport-level failures as transient", () => {
    expect(isTransientHostRpcFailure(new HostTransportFailureError(base))).toBe(
      true,
    );
    expect(isTransientHostRpcFailure(new RetryableTransportError(base))).toBe(
      true,
    );
  });

  it("classifies a retryable fatal frame as transient", () => {
    expect(
      isTransientHostRpcFailure(
        new HostRpcError({
          ...base,
          code: "UNAUTHORIZED",
          fatalDetails: {
            code: "UNAUTHORIZED",
            reason: "signing key unavailable",
            retryable: true,
            incompatibleMethods: null,
            upgradeGuidance: null,
          },
        }),
      ),
    ).toBe(true);
  });

  it("keeps host-originated rejections non-transient", () => {
    expect(isTransientHostRpcFailure(new HostRpcError(base))).toBe(false);
    expect(
      isTransientHostRpcFailure(
        new HostRpcError({
          ...base,
          code: "UNAUTHORIZED",
          fatalDetails: {
            code: "UNAUTHORIZED",
            reason: "token rejected",
            incompatibleMethods: null,
            upgradeGuidance: null,
          },
        }),
      ),
    ).toBe(false);
  });
});
