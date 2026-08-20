import { describe, expect, it } from "vitest";
import { unaryRequestPayloadSchema } from "../mux";

const requestWithoutCaller = {
  requestId: "request-1",
  method: "agent.sendMessage",
  schemaVersion: { major: 1, minor: 0 },
  params: {},
  idempotencyKey: null,
};

describe("unaryRequestPayloadSchema caller attribution", () => {
  it("defaults an old sender's omitted callerAgentId to null", () => {
    expect(unaryRequestPayloadSchema.parse(requestWithoutCaller)).toEqual({
      ...requestWithoutCaller,
      callerAgentId: null,
    });
  });

  it("preserves a multiplexed sender agent id", () => {
    expect(
      unaryRequestPayloadSchema.parse({
        ...requestWithoutCaller,
        callerAgentId: "agent-123",
      }).callerAgentId,
    ).toBe("agent-123");
  });
});
