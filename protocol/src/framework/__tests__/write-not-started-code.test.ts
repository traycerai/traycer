import { describe, expect, it } from "vitest";
import { hostResponseFrameSchema } from "@traycer/protocol/framework/ws-protocol";
import { unaryResponsePayloadSchema } from "@traycer/protocol/host-transport/mux";
import { HostRpcError } from "@traycer/protocol/host-transport/remote/rpc-types";

describe("authoritative write refusal codes on the wire", () => {
  it.each([
    ["E_WRITE_NOT_STARTED", "E_WRITE_NOT_STARTED"],
    ["E_UNRECOGNIZED_WRITE_ERROR", "RPC_ERROR"],
  ])("decodes %s as %s in both unary envelopes", (code, expectedCode) => {
    const request = {
      requestId: "req-1",
      method: "epic.renameArtifact",
      result: null,
      error: { code, message: "The write did not start." },
    };
    const frame = hostResponseFrameSchema.parse({
      ...request,
      kind: "response",
      schemaVersion: { major: 1, minor: 0 },
    });
    const payload = unaryResponsePayloadSchema.parse(request);
    for (const decoded of [frame, payload]) {
      if (decoded.error === null) throw new Error("Missing unary error");
      const error = HostRpcError.fromWireEnvelope(
        decoded.error,
        decoded.requestId,
        decoded.method,
      );
      expect(error.code).toBe(expectedCode);
      expect(error.message).toBe(request.error.message);
    }
  });
});
