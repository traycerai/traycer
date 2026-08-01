import { describe, expect, it } from "vitest";
import {
  agentActivitySubscribeClientFrameSchema,
  agentActivitySubscribeServerFrameSchema,
  agentActivitySubscribeV10,
} from "@traycer/protocol/host/agent/activity";
import { hostStreamRpcRegistry } from "@traycer/protocol/host/registry";

describe("agent.activity.subscribe@1.0", () => {
  it("accepts full replacement snapshots and updates", () => {
    for (const kind of ["snapshot", "update"] as const) {
      expect(
        agentActivitySubscribeServerFrameSchema.parse({
          kind,
          byEpic: {
            "epic-1": { working: ["agent-1"], turn: ["agent-1"] },
          },
          hasBinaryPayload: false,
        }),
      ).toEqual({
        kind,
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
        kind: "snapshot",
        byEpic: { "epic-1": { working: "agent-1", turn: [] } },
        hasBinaryPayload: false,
      }).success,
    ).toBe(false);
    expect(
      agentActivitySubscribeServerFrameSchema.safeParse({
        kind: "update",
        byEpic: {},
        hasBinaryPayload: true,
      }).success,
    ).toBe(false);
  });

  it("registers the optional stream at v1.0", () => {
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
