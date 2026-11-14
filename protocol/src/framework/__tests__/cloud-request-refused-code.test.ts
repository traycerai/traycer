import { describe, expect, it } from "vitest";
import { hostResponseFrameSchema } from "@traycer/protocol/framework/ws-protocol";
import { unaryResponsePayloadSchema } from "@traycer/protocol/host-transport/mux";
import { HostRpcError } from "@traycer/protocol/host-transport/remote/rpc-types";

const CODE = "E_CLOUD_REQUEST_REFUSED";

describe("E_CLOUD_REQUEST_REFUSED on the wire", () => {
  it("survives the ws `response` frame and decodes to a HostRpcError with that code", () => {
    const frame = hostResponseFrameSchema.parse({
      kind: "response",
      requestId: "req-1",
      method: "bot.conversation.list",
      schemaVersion: { major: 1, minor: 0 },
      result: null,
      error: { code: CODE, message: "egress budget refused" },
    });
    if (frame.error === undefined || frame.error === null) {
      throw new Error("the envelope lost its error");
    }
    const error = HostRpcError.fromWireEnvelope(
      frame.error,
      frame.requestId,
      frame.method,
    );
    expect(error.code).toBe(CODE);
    expect(error.message).toBe("egress budget refused");
  });

  it("survives the mux unary response envelope and decodes to a HostRpcError with that code", () => {
    const payload = unaryResponsePayloadSchema.parse({
      requestId: "req-2",
      method: "bot.list",
      result: null,
      error: { code: CODE, message: "egress budget refused" },
    });
    if (payload.error === undefined || payload.error === null) {
      throw new Error("the envelope lost its error");
    }
    const error = HostRpcError.fromWireEnvelope(
      payload.error,
      payload.requestId,
      payload.method,
    );
    expect(error.code).toBe(CODE);
  });
});
