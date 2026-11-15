import { describe, expect, it } from "vitest";
import {
  hostResponseErrorSchema,
  hostResponseFrameSchema,
} from "@traycer/protocol/framework/ws-protocol";
import { unaryResponsePayloadSchema } from "@traycer/protocol/host-transport/mux";
import { HostRpcError } from "@traycer/protocol/host-transport/remote/rpc-types";

/**
 * `notWritten: true` on a response error says the host refused the request
 * before it wrote anything, for that attempt only. Optional like `holders`
 * and `staleWrite`: a malformed value is sanitized to absent rather than
 * failing an envelope that parsed before the field existed, and the client's
 * RPC error carries it from both envelopes.
 */

const request = { requestId: "req-1", method: "bot.conversation.send" };

describe("hostResponseErrorSchema notWritten", () => {
  it("keeps notWritten: true", () => {
    const parsed = hostResponseErrorSchema.parse({
      code: "INVALID_ARGUMENT",
      message: "refused",
      notWritten: true,
    });
    expect(parsed.notWritten).toBe(true);
  });

  it("still parses an old { code, message } envelope with no notWritten", () => {
    const parsed = hostResponseErrorSchema.parse({
      code: "RPC_ERROR",
      message: "resolver failed",
    });
    expect(parsed.notWritten).toBeUndefined();
  });

  it.each([["yes"], [1], [false], [null], [{}], [[]]])(
    "sanitizes %j to absent instead of rejecting the envelope",
    (notWritten) => {
      const parsed = hostResponseErrorSchema.safeParse({
        code: "RPC_ERROR",
        message: "refused",
        notWritten,
      });
      expect(parsed.success).toBe(true);
      if (parsed.success) {
        expect(parsed.data.message).toBe("refused");
        expect(parsed.data.notWritten).toBeUndefined();
      }
    },
  );

  it("keeps notWritten through the full `response` frame", () => {
    const parsed = hostResponseFrameSchema.parse({
      kind: "response",
      requestId: "req-1",
      method: "bot.conversation.send",
      schemaVersion: { major: 1, minor: 7 },
      result: null,
      error: { code: "INVALID_ARGUMENT", message: "refused", notWritten: true },
    });
    expect(parsed.error?.notWritten).toBe(true);
  });
});

describe("unaryResponsePayloadSchema notWritten", () => {
  const envelope = (notWritten: unknown) => ({
    requestId: "req-1",
    method: "bot.conversation.send",
    result: null,
    error: { code: "RPC_ERROR", message: "refused", notWritten },
  });

  it("keeps notWritten: true", () => {
    expect(
      unaryResponsePayloadSchema.parse(envelope(true)).error?.notWritten,
    ).toBe(true);
  });

  it("sanitizes a malformed notWritten to absent instead of rejecting the envelope", () => {
    const parsed = unaryResponsePayloadSchema.safeParse(envelope("yes"));
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.error?.code).toBe("RPC_ERROR");
      expect(parsed.data.error?.notWritten).toBeUndefined();
    }
  });
});

describe("HostRpcError.notWritten", () => {
  it("carries the marker from a wire envelope and from error details", () => {
    const wire = HostRpcError.fromWireEnvelope(
      { code: "RPC_ERROR", message: "refused", notWritten: true },
      request.requestId,
      request.method,
    );
    const details = HostRpcError.fromErrorDetails(
      { code: "RPC_ERROR", message: "refused", notWritten: true },
      request.requestId,
      request.method,
    );
    expect([wire.notWritten, details.notWritten]).toEqual([true, true]);
  });

  it("is false when the envelope omits it or carries it malformed", () => {
    for (const notWritten of [undefined, "yes"]) {
      const error = HostRpcError.fromWireEnvelope(
        { code: "RPC_ERROR", message: "refused", notWritten },
        request.requestId,
        request.method,
      );
      expect(error.notWritten).toBe(false);
    }
  });

  it("keeps the marker its constructor is given, and is false by default", () => {
    const base = {
      code: "RPC_ERROR",
      message: "refused",
      requestId: request.requestId,
      method: request.method,
      fatalDetails: null,
    } as const;
    expect(new HostRpcError({ ...base, notWritten: true }).notWritten).toBe(
      true,
    );
    expect(new HostRpcError(base).notWritten).toBe(false);
  });
});
