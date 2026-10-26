import { describe, expect, it } from "vitest";

import { hostStreamRpcRegistry } from "@traycer/protocol/host/index";
import {
  epicStateSubscribeServerFrameSchemaV11,
  epicStateSubscribeServerFrameSchemaV12,
  epicStateSubscribeV12,
} from "@traycer/protocol/host/epic/state-subscribe";

/**
 * `epic.state.subscribe@1.2` carried the files arm of the files plane,
 * removed before any release shipped it (see `host/epic/state-subscribe.ts`).
 * The minor stays installed so `@1.3` keeps its number, with a frame
 * identical to `@1.1`'s.
 */

describe("epic.state.subscribe@1.2 (files arm removed before release)", () => {
  it("is the exact same frame schema as @1.1", () => {
    expect(epicStateSubscribeServerFrameSchemaV12).toBe(
      epicStateSubscribeServerFrameSchemaV11,
    );
  });

  it("stays installed at minor 2, below the @1.5 head", () => {
    expect(epicStateSubscribeV12.schemaVersion).toEqual({
      major: 1,
      minor: 2,
    });
    expect(epicStateSubscribeV12.serverFrameSchema).toBe(
      epicStateSubscribeServerFrameSchemaV12,
    );
    const line = hostStreamRpcRegistry["epic.state.subscribe"][1];
    expect(line.latestMinor).toBe(5);
    expect(line.versions[2].contract).toBe(epicStateSubscribeV12);
  });

  it("refuses a delta that carries no real change", () => {
    const emptyDelta = {
      kind: "delta",
      authorityEpoch: "epoch-1",
      seq: 1,
      artifactUpserts: [],
      artifactTombstones: [],
      commentThreadUpserts: [],
      commentThreadRemovals: [],
      epicMeta: null,
      roleClaims: null,
      hasBinaryPayload: false,
    };
    expect(
      epicStateSubscribeServerFrameSchemaV12.safeParse(emptyDelta).success,
    ).toBe(false);
    // A `files` key - the old files-plane arm - is no longer part of the
    // emptiness check at all: an otherwise-empty envelope stays refused even
    // when a peer still sends one, guarding against the removed files-only
    // exemption quietly coming back.
    expect(
      epicStateSubscribeServerFrameSchemaV12.safeParse({
        ...emptyDelta,
        files: { revision: 1, files: [] },
      }).success,
    ).toBe(false);
  });
});
