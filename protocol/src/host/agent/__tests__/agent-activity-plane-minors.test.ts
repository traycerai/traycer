import { describe, expect, it } from "vitest";
import { hostStreamRpcRegistry } from "@traycer/protocol/host/index";
import {
  agentActivitySubscribeOpenRequestSchema,
  agentActivitySubscribeOpenRequestSchemaPre12,
  agentActivitySubscribeServerFrameSchema,
  agentActivitySubscribeV10,
  agentActivitySubscribeV11,
  agentActivitySubscribeV12,
  agentActivitySubscribeV13,
} from "@traycer/protocol/host/agent/activity";

describe("agent.activity.subscribe@1.2", () => {
  it("is registered alongside the frozen 1.0 and 1.1 contracts", () => {
    const registry = hostStreamRpcRegistry["agent.activity.subscribe"];
    expect(registry[1].latestMinor).toBe(3);
    expect(registry[1].versions[0].contract.schemaVersion).toEqual({
      major: 1,
      minor: 0,
    });
    expect(registry[1].versions[1].contract.schemaVersion).toEqual({
      major: 1,
      minor: 1,
    });
    expect(registry[1].versions[2].contract.schemaVersion).toEqual({
      major: 1,
      minor: 2,
    });
  });

  it("registers 1.3 as the latest minor, wire-identical to 1.2", () => {
    const registry = hostStreamRpcRegistry["agent.activity.subscribe"];
    expect(registry[1].versions[3].contract).toBe(agentActivitySubscribeV13);
    expect(registry[1].versions[3].contract.schemaVersion).toEqual({
      major: 1,
      minor: 3,
    });
    expect(agentActivitySubscribeV13.openRequestSchema).toBe(
      agentActivitySubscribeV12.openRequestSchema,
    );
    expect(agentActivitySubscribeV13.serverFrameSchema).toBe(
      agentActivitySubscribeV12.serverFrameSchema,
    );
    expect(agentActivitySubscribeV13.clientFrameSchema).toBe(
      agentActivitySubscribeV12.clientFrameSchema,
    );
  });

  it("frozen line strips the plane selector", () => {
    const parsed = agentActivitySubscribeOpenRequestSchemaPre12.parse({
      plane: "local-only",
    });
    expect(parsed).not.toHaveProperty("plane");
    expect(parsed).toEqual({});
  });

  it("1.2 carries the plane selector and keeps its absence representable", () => {
    expect(
      agentActivitySubscribeOpenRequestSchema.parse({ plane: "local-only" }),
    ).toEqual({ plane: "local-only" });
    const withoutPlane = agentActivitySubscribeOpenRequestSchema.parse({});
    expect(withoutPlane).not.toHaveProperty("plane");
    expect(withoutPlane).toEqual({});
  });

  it("1.2 rejects an unknown plane value", () => {
    const result = agentActivitySubscribeOpenRequestSchema.safeParse({
      plane: "cloud-only",
    });
    expect(result.success).toBe(false);
  });

  it("the released 1.0 and 1.1 contracts point at the frozen open request", () => {
    expect(
      agentActivitySubscribeV10.openRequestSchema.parse({
        plane: "local-only",
      }),
    ).toEqual({});
    expect(
      agentActivitySubscribeV11.openRequestSchema.parse({
        plane: "local-only",
      }),
    ).toEqual({});
  });

  it("1.2's server frame is identical to 1.1's", () => {
    expect(agentActivitySubscribeV12.serverFrameSchema).toBe(
      agentActivitySubscribeServerFrameSchema,
    );
  });
});
