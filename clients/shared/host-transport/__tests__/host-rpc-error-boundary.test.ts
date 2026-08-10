import { describe, expect, it } from "vitest";
import {
  HostRpcError,
  RetryableTransportError,
  toHostRpcError,
  withHostRpcErrorBoundary,
} from "../host-messenger";

describe("toHostRpcError", () => {
  it("returns a HostRpcError unchanged, preserving the subclass", () => {
    const rpcError = new HostRpcError({
      code: "FORBIDDEN",
      message: "nope",
      requestId: "req-1",
      method: "host.echo",
      fatalDetails: null,
    });
    expect(toHostRpcError(rpcError, "host.echo")).toBe(rpcError);

    const transportError = new RetryableTransportError({
      code: "RPC_ERROR",
      message: "dial timeout",
      requestId: "req-2",
      method: "host.echo",
      fatalDetails: null,
    });
    expect(toHostRpcError(transportError, "host.echo")).toBe(transportError);
  });

  it("wraps a bare Error, preserving its message and stamping the method", () => {
    const wrapped = toHostRpcError(
      new TypeError("Cannot read properties of undefined (reading 'replace')"),
      "git.listChangedFiles",
    );
    expect(wrapped).toBeInstanceOf(HostRpcError);
    expect(wrapped.code).toBe("RPC_ERROR");
    expect(wrapped.method).toBe("git.listChangedFiles");
    expect(wrapped.requestId).toBe("client-normalized");
    expect(wrapped.fatalDetails).toBeNull();
    expect(wrapped.message).toBe(
      "Cannot read properties of undefined (reading 'replace')",
    );
  });

  it("wraps a non-Error rejection value with a generic message", () => {
    const wrapped = toHostRpcError("string throw", "host.echo");
    expect(wrapped).toBeInstanceOf(HostRpcError);
    expect(wrapped.code).toBe("RPC_ERROR");
    expect(wrapped.message).toBe("Unknown host request failure");
  });
});

describe("withHostRpcErrorBoundary", () => {
  it("passes a resolved value through untouched", async () => {
    await expect(
      withHostRpcErrorBoundary("host.echo", () => Promise.resolve(42)),
    ).resolves.toBe(42);
  });

  it("normalizes a bare rejection into a HostRpcError", async () => {
    const rejection = withHostRpcErrorBoundary("host.echo", () =>
      Promise.reject(new Error("bare failure")),
    );
    await expect(rejection).rejects.toBeInstanceOf(HostRpcError);
    await expect(rejection).rejects.toMatchObject({
      code: "RPC_ERROR",
      method: "host.echo",
      message: "bare failure",
    });
  });

  it("normalizes a synchronous throw from the thunk", async () => {
    const rejection = withHostRpcErrorBoundary("host.echo", () => {
      throw new Error("sync failure");
    });
    await expect(rejection).rejects.toBeInstanceOf(HostRpcError);
  });

  it("re-throws an existing HostRpcError by identity", async () => {
    const rpcError = new HostRpcError({
      code: "UNAUTHORIZED",
      message: "expired",
      requestId: "req-3",
      method: "host.echo",
      fatalDetails: null,
    });
    await expect(
      withHostRpcErrorBoundary("host.echo", () => Promise.reject(rpcError)),
    ).rejects.toBe(rpcError);
  });
});
