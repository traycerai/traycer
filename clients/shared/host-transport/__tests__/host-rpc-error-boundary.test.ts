import { describe, expect, it } from "vitest";
import {
  HostRpcError,
  RetryableTransportError,
  toHostRpcError,
  withHostRpcErrorBoundary,
} from "../host-messenger";

const worktreeBusyHolders = [
  {
    ownerRef: {
      epicId: "epic-1",
      ownerKind: "chat" as const,
      ownerId: "chat-1",
    },
    holdKind: "chat-turn" as const,
    activity: "working" as const,
    label: "Chat is mid-turn",
  },
];

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

describe("HostRpcError holders", () => {
  it("fromErrorDetails keeps a valid WORKTREE_BUSY holder list", () => {
    const error = HostRpcError.fromErrorDetails(
      {
        code: "WORKTREE_BUSY",
        message: "in use",
        holders: worktreeBusyHolders,
      },
      "req-1",
      "worktree.delete",
    );
    expect(error.holders).toEqual(worktreeBusyHolders);
  });

  it("fromErrorDetails leaves holders null when the envelope omitted them", () => {
    const error = HostRpcError.fromErrorDetails(
      { code: "WORKTREE_BUSY", message: "in use" },
      "req-1",
      "worktree.delete",
    );
    expect(error.holders).toBeNull();
  });

  it("fromWireEnvelope keeps holders and collapses unknown codes", () => {
    const error = HostRpcError.fromWireEnvelope(
      {
        code: "WORKTREE_BUSY",
        message: "in use",
        holders: worktreeBusyHolders,
      },
      "req-2",
      "worktree.delete",
    );
    expect(error.code).toBe("WORKTREE_BUSY");
    expect(error.holders).toEqual(worktreeBusyHolders);
  });

  it("fromErrorDetails ignores a valid holder list on a non-busy code", () => {
    const error = HostRpcError.fromErrorDetails(
      {
        code: "RPC_ERROR",
        message: "resolver failed",
        holders: worktreeBusyHolders,
      },
      "req-4",
      "worktree.delete",
    );
    expect(error.code).toBe("RPC_ERROR");
    expect(error.holders).toBeNull();
  });

  it("fromWireEnvelope ignores a valid holder list on a non-busy code", () => {
    const error = HostRpcError.fromWireEnvelope(
      {
        code: "RPC_ERROR",
        message: "resolver failed",
        holders: worktreeBusyHolders,
      },
      "req-5",
      "worktree.delete",
    );
    expect(error.code).toBe("RPC_ERROR");
    expect(error.holders).toBeNull();
  });

  it("fromWireEnvelope drops a malformed holders payload rather than throwing", () => {
    const error = HostRpcError.fromWireEnvelope(
      {
        code: "WORKTREE_BUSY",
        message: "in use",
        holders: [{ not: "a holder" }],
      },
      "req-3",
      "worktree.delete",
    );
    expect(error.code).toBe("WORKTREE_BUSY");
    expect(error.holders).toBeNull();
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
