import { describe, expect, it } from "vitest";
import {
  ENVIRONMENT_WRITE_STALE_CODE,
  environmentChangedBySchema,
  environmentStaleWriteSchema,
  staleWriteForCode,
  staleWriteWireFieldSchema,
  type EnvironmentStaleWrite,
} from "@traycer/protocol/framework/environment-stale-write";
import {
  RPC_ERROR_CODES,
  isRpcErrorCode,
} from "@traycer/protocol/framework/versioned-rpc-types";
import {
  hostResponseErrorSchema,
  hostResponseFrameSchema,
} from "@traycer/protocol/framework/ws-protocol";
import { unaryResponsePayloadSchema } from "@traycer/protocol/host-transport/mux";
import { HostRpcError } from "@traycer/protocol/host-transport/remote/rpc-types";
import { environmentChangedBySchema as hostEnvironmentChangedBySchema } from "@traycer/protocol/host/environment-schemas";

/**
 * Fixture coverage for the `ENVIRONMENT_WRITE_STALE` error code and its typed
 * `staleWrite` detail: the schema, the lenient wire field, both envelope
 * schemas (WS `response` and mux unary response), and `HostRpcError`'s
 * code-gated `staleWrite`. Modelled on the `holders` / `holdersRevision`
 * coverage in `ws-protocol.test.ts`.
 */

const dashboardStale: EnvironmentStaleWrite = {
  changedBy: { kind: "dashboard" },
  currentRevision: 7,
};

const hostStale: EnvironmentStaleWrite = {
  changedBy: { kind: "host", hostId: "host-laptop", hostLabel: "Work laptop" },
  currentRevision: 12,
};

describe("ENVIRONMENT_WRITE_STALE error code", () => {
  it("is a member of RPC_ERROR_CODES", () => {
    expect(RPC_ERROR_CODES).toContain("ENVIRONMENT_WRITE_STALE");
    expect(ENVIRONMENT_WRITE_STALE_CODE).toBe("ENVIRONMENT_WRITE_STALE");
  });

  it("is accepted by isRpcErrorCode", () => {
    expect(isRpcErrorCode("ENVIRONMENT_WRITE_STALE")).toBe(true);
    expect(isRpcErrorCode("ENVIRONMENT_WRITE_STALE_NOPE")).toBe(false);
  });
});

describe("environmentStaleWriteSchema", () => {
  it("accepts a dashboard changedBy with an integer revision", () => {
    expect(environmentStaleWriteSchema.parse(dashboardStale)).toEqual(
      dashboardStale,
    );
  });

  it("accepts a dashboard changedBy with a null revision", () => {
    const value = { changedBy: { kind: "dashboard" }, currentRevision: null };
    expect(environmentStaleWriteSchema.parse(value)).toEqual(value);
  });

  it("accepts a host changedBy with a hostLabel string", () => {
    expect(environmentStaleWriteSchema.parse(hostStale)).toEqual(hostStale);
  });

  it("accepts a host changedBy with a null hostLabel and null revision", () => {
    const value = {
      changedBy: { kind: "host", hostId: "host-1", hostLabel: null },
      currentRevision: null,
    };
    expect(environmentStaleWriteSchema.parse(value)).toEqual(value);
  });

  it("rejects a non-integer revision", () => {
    expect(
      environmentStaleWriteSchema.safeParse({
        changedBy: { kind: "dashboard" },
        currentRevision: 1.5,
      }).success,
    ).toBe(false);
  });

  it("rejects a missing changedBy", () => {
    expect(
      environmentStaleWriteSchema.safeParse({ currentRevision: 3 }).success,
    ).toBe(false);
  });

  it("rejects an unknown changedBy kind", () => {
    expect(
      environmentStaleWriteSchema.safeParse({
        changedBy: { kind: "cli" },
        currentRevision: 3,
      }).success,
    ).toBe(false);
  });

  it("rejects an empty hostId", () => {
    expect(
      environmentStaleWriteSchema.safeParse({
        changedBy: { kind: "host", hostId: "", hostLabel: null },
        currentRevision: 3,
      }).success,
    ).toBe(false);
  });
});

describe("staleWriteWireFieldSchema", () => {
  it("passes a valid value through", () => {
    expect(staleWriteWireFieldSchema.parse(hostStale)).toEqual(hostStale);
  });

  it("parses an absent value to undefined", () => {
    expect(staleWriteWireFieldSchema.parse(undefined)).toBeUndefined();
  });

  it("sanitizes malformed values to undefined without throwing", () => {
    const malformed = [
      { changedBy: { kind: "nope" } },
      { changedBy: { kind: "dashboard" }, currentRevision: "7" },
      "stale",
      42,
      null,
      [],
    ];
    for (const value of malformed) {
      const parsed = staleWriteWireFieldSchema.safeParse(value);
      expect(parsed.success).toBe(true);
      if (parsed.success) {
        expect(parsed.data).toBeUndefined();
      }
    }
  });
});

describe("staleWriteForCode", () => {
  it("returns the parsed detail on ENVIRONMENT_WRITE_STALE", () => {
    expect(staleWriteForCode("ENVIRONMENT_WRITE_STALE", hostStale)).toEqual(
      hostStale,
    );
  });

  it("returns null on any other code even with a valid detail", () => {
    expect(staleWriteForCode("WORKTREE_BUSY", hostStale)).toBeNull();
    expect(staleWriteForCode("RPC_ERROR", dashboardStale)).toBeNull();
  });

  it("returns null on the right code when the detail is absent or malformed", () => {
    expect(staleWriteForCode("ENVIRONMENT_WRITE_STALE", undefined)).toBeNull();
    expect(staleWriteForCode("ENVIRONMENT_WRITE_STALE", null)).toBeNull();
    expect(
      staleWriteForCode("ENVIRONMENT_WRITE_STALE", {
        changedBy: { kind: "nope" },
        currentRevision: 1,
      }),
    ).toBeNull();
  });
});

describe("hostResponseErrorSchema staleWrite", () => {
  it("keeps staleWrite on an ENVIRONMENT_WRITE_STALE envelope", () => {
    const parsed = hostResponseErrorSchema.parse({
      code: "ENVIRONMENT_WRITE_STALE",
      message: "changed elsewhere",
      staleWrite: hostStale,
    });
    expect(parsed.staleWrite).toEqual(hostStale);
  });

  it("still parses an old { code, message } envelope with no staleWrite", () => {
    const parsed = hostResponseErrorSchema.parse({
      code: "RPC_ERROR",
      message: "resolver failed",
    });
    expect(parsed.code).toBe("RPC_ERROR");
    expect(parsed.staleWrite).toBeUndefined();
  });

  it("sanitizes a malformed staleWrite to absent instead of rejecting the envelope", () => {
    const parsed = hostResponseErrorSchema.safeParse({
      code: "ENVIRONMENT_WRITE_STALE",
      message: "changed elsewhere",
      staleWrite: { changedBy: { kind: "nope" } },
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.code).toBe("ENVIRONMENT_WRITE_STALE");
      expect(parsed.data.message).toBe("changed elsewhere");
      expect(parsed.data.staleWrite).toBeUndefined();
    }
  });

  it("keeps staleWrite through the full `response` frame", () => {
    const parsed = hostResponseFrameSchema.parse({
      kind: "response",
      requestId: "req-1",
      method: "environment.items.write",
      schemaVersion: { major: 1, minor: 0 },
      result: null,
      error: {
        code: "ENVIRONMENT_WRITE_STALE",
        message: "changed elsewhere",
        staleWrite: dashboardStale,
      },
    });
    expect(parsed.error?.staleWrite).toEqual(dashboardStale);
  });
});

describe("unaryResponsePayloadSchema staleWrite", () => {
  const envelope = (staleWrite: unknown, code: string) => ({
    requestId: "req-1",
    method: "environment.items.write",
    result: null,
    error: { code, message: "changed elsewhere", staleWrite },
  });

  it("keeps staleWrite on an ENVIRONMENT_WRITE_STALE envelope", () => {
    const parsed = unaryResponsePayloadSchema.parse(
      envelope(hostStale, "ENVIRONMENT_WRITE_STALE"),
    );
    expect(parsed.error?.staleWrite).toEqual(hostStale);
  });

  it("still parses an old { code, message } envelope with no staleWrite", () => {
    const parsed = unaryResponsePayloadSchema.parse({
      requestId: "req-1",
      method: "host.status",
      result: null,
      error: { code: "RPC_ERROR", message: "resolver failed" },
    });
    expect(parsed.error?.code).toBe("RPC_ERROR");
    expect(parsed.error?.staleWrite).toBeUndefined();
  });

  it("sanitizes a malformed staleWrite to absent instead of rejecting the envelope", () => {
    const parsed = unaryResponsePayloadSchema.safeParse(
      envelope({ changedBy: { kind: "nope" } }, "ENVIRONMENT_WRITE_STALE"),
    );
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.error?.code).toBe("ENVIRONMENT_WRITE_STALE");
      expect(parsed.data.error?.staleWrite).toBeUndefined();
    }
  });
});

describe("HostRpcError.staleWrite", () => {
  const request = { requestId: "req-1", method: "environment.items.write" };

  describe("fromWireEnvelope", () => {
    it("carries the parsed detail on ENVIRONMENT_WRITE_STALE", () => {
      const error = HostRpcError.fromWireEnvelope(
        {
          code: "ENVIRONMENT_WRITE_STALE",
          message: "changed elsewhere",
          staleWrite: hostStale,
        },
        request.requestId,
        request.method,
      );
      expect(error.code).toBe("ENVIRONMENT_WRITE_STALE");
      expect(error.staleWrite).toEqual(hostStale);
    });

    it("is null on WORKTREE_BUSY even when a valid staleWrite is present", () => {
      const error = HostRpcError.fromWireEnvelope(
        { code: "WORKTREE_BUSY", message: "in use", staleWrite: hostStale },
        request.requestId,
        request.method,
      );
      expect(error.code).toBe("WORKTREE_BUSY");
      expect(error.staleWrite).toBeNull();
    });

    it("is null on an unknown code (mapped to RPC_ERROR) with a valid staleWrite", () => {
      const error = HostRpcError.fromWireEnvelope(
        {
          code: "SOME_UNKNOWN_CODE",
          message: "nope",
          staleWrite: dashboardStale,
        },
        request.requestId,
        request.method,
      );
      expect(error.code).toBe("RPC_ERROR");
      expect(error.staleWrite).toBeNull();
    });

    it("is null on the right code when staleWrite is absent", () => {
      const error = HostRpcError.fromWireEnvelope(
        { code: "ENVIRONMENT_WRITE_STALE", message: "changed elsewhere" },
        request.requestId,
        request.method,
      );
      expect(error.staleWrite).toBeNull();
    });

    it("is null on the right code when staleWrite is malformed", () => {
      const error = HostRpcError.fromWireEnvelope(
        {
          code: "ENVIRONMENT_WRITE_STALE",
          message: "changed elsewhere",
          staleWrite: { changedBy: { kind: "nope" }, currentRevision: 1 },
        },
        request.requestId,
        request.method,
      );
      expect(error.staleWrite).toBeNull();
    });
  });

  describe("fromErrorDetails", () => {
    it("carries the detail on ENVIRONMENT_WRITE_STALE", () => {
      const error = HostRpcError.fromErrorDetails(
        {
          code: "ENVIRONMENT_WRITE_STALE",
          message: "changed elsewhere",
          staleWrite: dashboardStale,
        },
        request.requestId,
        request.method,
      );
      expect(error.staleWrite).toEqual(dashboardStale);
    });

    it("is null on WORKTREE_BUSY and RPC_ERROR even with a valid staleWrite", () => {
      for (const code of ["WORKTREE_BUSY", "RPC_ERROR"] as const) {
        const error = HostRpcError.fromErrorDetails(
          { code, message: "nope", staleWrite: hostStale },
          request.requestId,
          request.method,
        );
        expect(error.staleWrite).toBeNull();
      }
    });

    it("is null on the right code when staleWrite is absent", () => {
      const error = HostRpcError.fromErrorDetails(
        { code: "ENVIRONMENT_WRITE_STALE", message: "changed elsewhere" },
        request.requestId,
        request.method,
      );
      expect(error.staleWrite).toBeNull();
    });
  });

  describe("constructor", () => {
    const base = {
      message: "changed elsewhere",
      requestId: request.requestId,
      method: request.method,
      fatalDetails: null,
    };

    it("keeps staleWrite on ENVIRONMENT_WRITE_STALE", () => {
      const error = new HostRpcError({
        ...base,
        code: "ENVIRONMENT_WRITE_STALE",
        staleWrite: hostStale,
      });
      expect(error.staleWrite).toEqual(hostStale);
    });

    it("drops staleWrite on any other code", () => {
      const error = new HostRpcError({
        ...base,
        code: "WORKTREE_BUSY",
        staleWrite: hostStale,
      });
      expect(error.staleWrite).toBeNull();
    });

    it("is null when staleWrite is omitted or null", () => {
      expect(
        new HostRpcError({ ...base, code: "ENVIRONMENT_WRITE_STALE" })
          .staleWrite,
      ).toBeNull();
      expect(
        new HostRpcError({
          ...base,
          code: "ENVIRONMENT_WRITE_STALE",
          staleWrite: null,
        }).staleWrite,
      ).toBeNull();
    });
  });
});

describe("environmentChangedBySchema", () => {
  it("is the same object whether imported from host/environment-schemas or the framework module", () => {
    expect(hostEnvironmentChangedBySchema).toBe(environmentChangedBySchema);
  });

  it("strips account identifiers (userId, email) from a host changedBy", () => {
    const parsed = environmentChangedBySchema.parse({
      kind: "host",
      hostId: "host-1",
      hostLabel: "Work laptop",
      userId: "user-123",
      email: "someone@example.com",
    });
    expect(parsed).toEqual({
      kind: "host",
      hostId: "host-1",
      hostLabel: "Work laptop",
    });
    expect(Object.keys(parsed)).not.toContain("userId");
    expect(Object.keys(parsed)).not.toContain("email");
  });

  it("strips account identifiers from a dashboard changedBy and from a nested staleWrite", () => {
    const dashboard = environmentChangedBySchema.parse({
      kind: "dashboard",
      userId: "user-123",
      email: "someone@example.com",
    });
    expect(dashboard).toEqual({ kind: "dashboard" });

    const nested = environmentStaleWriteSchema.parse({
      changedBy: {
        kind: "host",
        hostId: "host-1",
        hostLabel: null,
        email: "someone@example.com",
      },
      currentRevision: 2,
      userId: "user-123",
    });
    expect(nested).toEqual({
      changedBy: { kind: "host", hostId: "host-1", hostLabel: null },
      currentRevision: 2,
    });
  });
});
