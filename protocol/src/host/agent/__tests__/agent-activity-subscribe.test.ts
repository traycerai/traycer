import { describe, expect, it } from "vitest";
import {
  agentActivitySubscribeClientFrameSchema,
  agentActivitySubscribeServerFrameSchema,
  agentActivitySubscribeV10,
} from "@traycer/protocol/host/agent/activity";
import { hostStreamRpcRegistry } from "@traycer/protocol/host/registry";

describe("agent.activity.subscribe@1.0", () => {
  it("accepts a full replacement state from either host-selected plane", () => {
    for (const servedBy of ["local", "cloud"] as const) {
      expect(
        agentActivitySubscribeServerFrameSchema.parse({
          kind: "state",
          servedBy,
          byEpic: {
            "epic-1": { working: ["agent-1"], turn: ["agent-1"] },
          },
          hasBinaryPayload: false,
        }),
      ).toEqual({
        kind: "state",
        servedBy,
        byEpic: {
          "epic-1": { working: ["agent-1"], turn: ["agent-1"] },
        },
        hasBinaryPayload: false,
      });
    }
    expect(
      agentActivitySubscribeServerFrameSchema.parse({
        kind: "pong",
        hasBinaryPayload: false,
      }),
    ).toEqual({ kind: "pong", hasBinaryPayload: false });
  });

  it("rejects malformed buckets and binary activity frames", () => {
    expect(
      agentActivitySubscribeServerFrameSchema.safeParse({
        kind: "state",
        servedBy: "local",
        byEpic: { "epic-1": { working: "agent-1", turn: [] } },
        hasBinaryPayload: false,
      }).success,
    ).toBe(false);
    expect(
      agentActivitySubscribeServerFrameSchema.safeParse({
        kind: "state",
        servedBy: "cloud",
        byEpic: {},
        hasBinaryPayload: true,
      }).success,
    ).toBe(false);
  });

  it("registers the stream at v1.0", () => {
    expect(
      agentActivitySubscribeClientFrameSchema.parse({
        kind: "ping",
        hasBinaryPayload: false,
      }),
    ).toEqual({ kind: "ping", hasBinaryPayload: false });
    const entry = hostStreamRpcRegistry["agent.activity.subscribe"];
    expect(entry[1].latestMinor).toBe(0);
    expect(entry[1].versions[0].contract).toBe(agentActivitySubscribeV10);
  });
});
