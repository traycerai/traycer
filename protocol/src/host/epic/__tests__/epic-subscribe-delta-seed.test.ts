import { describe, expect, it } from "vitest";
import {
  epicSubscribeOpenRequestSchema,
  epicSubscribeOpenRequestSchemaV10,
  epicSubscribeServerFrameSchemaV13,
  epicSubscribeV10,
  epicSubscribeV11,
  epicSubscribeV12,
  epicSubscribeV13,
} from "@traycer/protocol/host/epic/subscribe";
import {
  snapshotMetaEpicSchema,
  snapshotMetaEpicSchemaV10,
  snapshotMetaEpicSchemaV12,
} from "@traycer/protocol/host/epic/snapshot-meta";
import { hostStreamRpcRegistry } from "@traycer/protocol/host/registry";

/**
 * `epic.subscribe@1.3` - delta-seeded reattach. Covers the two new optional
 * wire keys (`seedOffer` on the open request, `seededFromOffer` on the
 * snapshot frame's `meta`) and the registry/contract wiring around them.
 */

const baseMetaV10Fields = {
  schemaVersion: "1.0.0",
  epicLight: null,
  permissionRole: "owner" as const,
  repos: [],
  workspaces: [],
  repoMapping: [],
  workspaceFolders: [],
  unresolvedRepos: [],
  hostStateVectorBase64: "AQ==",
};

describe("epic.subscribe@1.3 open request - seedOffer", () => {
  it("strips seedOffer under the frozen @1.0/@1.1/@1.2 open request shape", () => {
    const parsed = epicSubscribeOpenRequestSchemaV10.parse({
      epicId: "epic-1",
      seedOffer: {
        stateVectorBase64: "AQ==",
        roomId: "room-1",
      },
    });
    expect(parsed).toEqual({ epicId: "epic-1" });
    expect("seedOffer" in parsed).toBe(false);
  });

  it("accepts a well-formed seedOffer under @1.3", () => {
    const parsed = epicSubscribeOpenRequestSchema.parse({
      epicId: "epic-1",
      seedOffer: {
        stateVectorBase64: "AQ==",
        roomId: "room-1",
      },
    });
    expect(parsed.seedOffer).toEqual({
      stateVectorBase64: "AQ==",
      roomId: "room-1",
    });
  });

  it("accepts an @1.3 open request with no seedOffer at all", () => {
    const parsed = epicSubscribeOpenRequestSchema.parse({ epicId: "epic-1" });
    expect(parsed.epicId).toBe("epic-1");
    expect(parsed.seedOffer).toBeUndefined();
  });

  it("rejects a seedOffer missing roomId", () => {
    expect(() =>
      epicSubscribeOpenRequestSchema.parse({
        epicId: "epic-1",
        seedOffer: { stateVectorBase64: "AQ==" },
      }),
    ).toThrow();
  });

  it("rejects a seedOffer missing stateVectorBase64", () => {
    expect(() =>
      epicSubscribeOpenRequestSchema.parse({
        epicId: "epic-1",
        seedOffer: { roomId: "room-1" },
      }),
    ).toThrow();
  });

  it("rejects a seedOffer with an empty-string roomId", () => {
    expect(() =>
      epicSubscribeOpenRequestSchema.parse({
        epicId: "epic-1",
        seedOffer: { stateVectorBase64: "AQ==", roomId: "" },
      }),
    ).toThrow();
  });

  it("rejects a seedOffer with an empty-string stateVectorBase64", () => {
    expect(() =>
      epicSubscribeOpenRequestSchema.parse({
        epicId: "epic-1",
        seedOffer: { stateVectorBase64: "", roomId: "room-1" },
      }),
    ).toThrow();
  });
});

describe("epic.subscribe@1.3 snapshot meta - seededFromOffer", () => {
  it("the frozen @1.0/@1.1 meta shape has no seededFromOffer key", () => {
    const parsed = snapshotMetaEpicSchemaV10.parse(baseMetaV10Fields);
    expect("seededFromOffer" in parsed).toBe(false);
  });

  it("the frozen @1.2 meta shape has no seededFromOffer key", () => {
    const parsed = snapshotMetaEpicSchemaV12.parse({
      ...baseMetaV10Fields,
      roomId: "room-1",
    });
    expect("seededFromOffer" in parsed).toBe(false);
  });

  it("strips seededFromOffer when a @1.3-built meta is parsed under the frozen @1.2 shape", () => {
    const parsed = snapshotMetaEpicSchemaV12.parse({
      ...baseMetaV10Fields,
      roomId: "room-1",
      seededFromOffer: true,
    });
    expect("seededFromOffer" in parsed).toBe(false);
  });

  it("accepts seededFromOffer: true at @1.3", () => {
    const parsed = snapshotMetaEpicSchema.parse({
      ...baseMetaV10Fields,
      roomId: "room-1",
      seededFromOffer: true,
    });
    expect(parsed.seededFromOffer).toBe(true);
  });

  it("accepts an @1.3 meta with seededFromOffer absent (full snapshot)", () => {
    const parsed = snapshotMetaEpicSchema.parse({
      ...baseMetaV10Fields,
      roomId: "room-1",
    });
    expect(parsed.seededFromOffer).toBeUndefined();
  });

  it("rejects seededFromOffer: false - absence is the only encoding of full snapshot", () => {
    expect(() =>
      snapshotMetaEpicSchema.parse({
        ...baseMetaV10Fields,
        roomId: "room-1",
        seededFromOffer: false,
      }),
    ).toThrow();
  });
});

describe("epic.subscribe@1.3 contracts and registry wiring", () => {
  it("keeps @1.0/@1.1/@1.2 openRequestSchema pinned to the frozen V10 object", () => {
    expect(epicSubscribeV10.openRequestSchema).toBe(
      epicSubscribeOpenRequestSchemaV10,
    );
    expect(epicSubscribeV11.openRequestSchema).toBe(
      epicSubscribeOpenRequestSchemaV10,
    );
    expect(epicSubscribeV12.openRequestSchema).toBe(
      epicSubscribeOpenRequestSchemaV10,
    );
  });

  it("wires @1.3's openRequestSchema and serverFrameSchema to the grown shapes", () => {
    expect(epicSubscribeV13.openRequestSchema).toBe(
      epicSubscribeOpenRequestSchema,
    );
    expect(epicSubscribeV13.serverFrameSchema).toBe(
      epicSubscribeServerFrameSchemaV13,
    );
    expect(epicSubscribeV13.schemaVersion).toEqual({ major: 1, minor: 3 });
  });

  it("registers epic.subscribe@1.3 with a 3: version entry above @1.2", () => {
    const line = hostStreamRpcRegistry["epic.subscribe"][1];
    // Not `latestMinor` - the status minors (@1.4-@1.6) sit above this one,
    // and the top of the line is pinned once in `versioned-stream-rpc.test.ts`
    // rather than re-asserted by every minor's own test.
    expect(line.versions[3]?.contract).toBe(epicSubscribeV13);
    expect(line.versions[0]?.contract).toBe(epicSubscribeV10);
    expect(line.versions[1]?.contract).toBe(epicSubscribeV11);
    expect(line.versions[2]?.contract).toBe(epicSubscribeV12);
  });
});
