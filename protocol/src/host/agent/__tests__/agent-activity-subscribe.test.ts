import { describe, expect, it } from "vitest";
import {
  agentActivitySubscribeClientFrameSchema,
  agentActivitySubscribeServerFrameSchema,
  agentActivitySubscribeV10,
  agentActivitySubscribeV11,
} from "@traycer/protocol/host/agent/activity";
import { hostStreamRpcRegistry } from "@traycer/protocol/host/registry";

describe("agent.activity.subscribe@1.1", () => {
  it("accepts a full replacement state from either host-selected plane", () => {
    for (const servedBy of ["local", "cloud"] as const) {
      expect(
        agentActivitySubscribeServerFrameSchema.parse({
          kind: "state",
          servedBy,
          byEpic: {
            "epic-1": { working: ["agent-1"], turn: ["agent-1"] },
          },
          cloudSyncStatus: servedBy === "cloud" ? "connected" : null,
          hasBinaryPayload: false,
        }),
      ).toEqual({
        kind: "state",
        servedBy,
        byEpic: {
          "epic-1": { working: ["agent-1"], turn: ["agent-1"] },
        },
        cloudSyncStatus: servedBy === "cloud" ? "connected" : null,
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

  // A `1.0` host never writes the key. The `1.1` client must read that as NO
  // CLAIM, never as "connected" - inventing a healthy cloud link for a host
  // that cannot make the claim is the lie the field exists to end.
  it("defaults an absent cloudSyncStatus (1.0 host) to null, never connected", () => {
    expect(
      agentActivitySubscribeServerFrameSchema.parse({
        kind: "state",
        servedBy: "cloud",
        byEpic: {},
        hasBinaryPayload: false,
      }),
    ).toEqual({
      kind: "state",
      servedBy: "cloud",
      byEpic: {},
      cloudSyncStatus: null,
      hasBinaryPayload: false,
    });
  });

  it("accepts every cloud-link status and rejects an unknown one", () => {
    for (const cloudSyncStatus of [
      "connected",
      "reconnecting",
      "disconnected",
    ] as const) {
      expect(
        agentActivitySubscribeServerFrameSchema.safeParse({
          kind: "state",
          servedBy: "cloud",
          byEpic: {},
          cloudSyncStatus,
          hasBinaryPayload: false,
        }).success,
      ).toBe(true);
    }
    expect(
      agentActivitySubscribeServerFrameSchema.safeParse({
        kind: "state",
        servedBy: "cloud",
        byEpic: {},
        cloudSyncStatus: "blind",
        hasBinaryPayload: false,
      }).success,
    ).toBe(false);
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

  it("registers 1.0 and 1.1 densely with 1.1 as the latest minor", () => {
    expect(
      agentActivitySubscribeClientFrameSchema.parse({
        kind: "ping",
        hasBinaryPayload: false,
      }),
    ).toEqual({ kind: "ping", hasBinaryPayload: false });
    const entry = hostStreamRpcRegistry["agent.activity.subscribe"];
    expect(entry[1].latestMinor).toBe(1);
    expect(entry[1].versions[0].contract).toBe(agentActivitySubscribeV10);
    expect(entry[1].versions[1].contract).toBe(agentActivitySubscribeV11);
  });

  // Read the schema OFF THE REGISTRY, not the imported symbol: a later edit
  // re-pointing `1.0` at a laxer schema must fail here, not only in the
  // protocol-compat CI gate.
  it("keeps the released 1.0 serverFrame free of cloudSyncStatus (strips it on parse)", () => {
    const v10 =
      hostStreamRpcRegistry["agent.activity.subscribe"][1].versions[0].contract
        .serverFrameSchema;
    const parsed = v10.parse({
      kind: "state",
      servedBy: "cloud",
      byEpic: { "epic-1": { working: ["agent-1"], turn: [] } },
      cloudSyncStatus: "reconnecting",
      hasBinaryPayload: false,
    });
    expect(parsed).toEqual({
      kind: "state",
      servedBy: "cloud",
      byEpic: { "epic-1": { working: ["agent-1"], turn: [] } },
      hasBinaryPayload: false,
    });
    expect(Object.hasOwn(parsed, "cloudSyncStatus")).toBe(false);
  });
});
