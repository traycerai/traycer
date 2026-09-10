import { describe, expect, it } from "vitest";
import {
  EPIC_STATUS_DURABILITY_LEGS_MINOR,
  epicStatusFrameForNegotiatedMinor,
  epicStatusSubscribeServerFrameSchemaV10,
  epicStatusSubscribeServerFrameSchemaV11,
  type EpicStatusSubscribeServerFrameV11,
} from "../status-subscribe";
import { hostStreamRpcRegistry } from "../../registry";

/**
 * `epic.status.subscribe@1.0` shipped in cli-v1.3.0 WITHOUT the durability
 * legs. They were originally written onto `@1.0` itself, on the reading that
 * five optional keys cannot break a peer; the release baseline named that as a
 * breaking change on a host->client slot, because optionality protects a new
 * client reading an old host and does nothing for the case that matters - an
 * old client strict-decoding a new host's extra keys.
 *
 * These pin the resulting split from both directions. The compat gate
 * (`released-baseline-compat.test.ts`) already fails on any drift in `@1.0`'s
 * shape; what it cannot see is whether the LEGS still reach a peer that asked
 * for them, or whether the bridge that strips them leaves the rest of the
 * frame intact.
 */
const LEGS = {
  durability: "cloud",
  pauseReason: undefined,
  promotionState: undefined,
  localProtection: "armed",
  freshness: {
    kind: "lastCloudSyncAt",
    reconciledAtEpochMs: 10,
    state: "current",
  },
} as const;

function snapshotWithLegs(): EpicStatusSubscribeServerFrameV11 {
  return epicStatusSubscribeServerFrameSchemaV11.parse({
    kind: "snapshot",
    authorityEpoch: "epoch-1",
    securityEpoch: 0,
    permissionRole: null,
    cloudSyncStatus: "connected",
    ...LEGS,
    dirty: null,
    migration: null,
    deletion: { state: "none" },
    hasBinaryPayload: false,
  });
}

function cloudSyncStatusWithLegs(): EpicStatusSubscribeServerFrameV11 {
  return epicStatusSubscribeServerFrameSchemaV11.parse({
    kind: "cloudSyncStatus",
    authorityEpoch: "epoch-1",
    status: "disconnected",
    ...LEGS,
    hasBinaryPayload: false,
  });
}

describe("epic.status.subscribe durability legs", () => {
  it("registers the legs above the minor cli-v1.3.0 shipped", () => {
    const major = hostStreamRpcRegistry["epic.status.subscribe"][1];
    expect(major.latestMinor).toBe(EPIC_STATUS_DURABILITY_LEGS_MINOR);
    expect(EPIC_STATUS_DURABILITY_LEGS_MINOR).toBeGreaterThan(0);
    // The floor is a version this registry actually installs - a gate keyed to
    // a minor nothing serves would refuse the legs to every peer forever.
    expect(major.versions[EPIC_STATUS_DURABILITY_LEGS_MINOR]).toBeDefined();
  });

  it("keeps the legs off the shipped @1.0 union", () => {
    // Through the schema, not the type: zod STRIPS unknown keys, so a `@1.0`
    // reader silently discarding them is exactly the behaviour that makes the
    // baseline finding real, and it is what this asserts.
    const parsed = epicStatusSubscribeServerFrameSchemaV10.parse({
      kind: "snapshot",
      authorityEpoch: "epoch-1",
      securityEpoch: 0,
      permissionRole: null,
      cloudSyncStatus: "connected",
      ...LEGS,
      dirty: null,
      migration: null,
      deletion: { state: "none" },
      hasBinaryPayload: false,
    });
    expect(parsed).not.toHaveProperty("durability");
    expect(parsed).not.toHaveProperty("localProtection");
    expect(parsed).not.toHaveProperty("freshness");
  });

  it("carries the legs at @1.1 on both frames that state epic-level status", () => {
    expect(snapshotWithLegs()).toMatchObject({
      durability: "cloud",
      localProtection: "armed",
    });
    expect(cloudSyncStatusWithLegs()).toMatchObject({
      durability: "cloud",
      localProtection: "armed",
    });
  });

  it.each([
    ["snapshot", snapshotWithLegs],
    ["cloudSyncStatus", cloudSyncStatusWithLegs],
  ])("drops every leg from a %s bound for a pre-legs peer", (_kind, build) => {
    const projected = epicStatusFrameForNegotiatedMinor(
      build(),
      EPIC_STATUS_DURABILITY_LEGS_MINOR - 1,
    );

    for (const leg of [
      "durability",
      "pauseReason",
      "promotionState",
      "localProtection",
      "freshness",
    ]) {
      expect(projected).not.toHaveProperty(leg);
    }
    // The projection is a DOWNGRADE, not a refusal: everything the `@1.0` peer
    // is entitled to survives it, which is why the host may keep broadcasting
    // one composed frame to subscribers on either minor.
    expect(
      epicStatusSubscribeServerFrameSchemaV10.safeParse(projected).success,
    ).toBe(true);
    // Narrowed rather than read off the union: `pong` carries no epoch, so
    // reading one straight off the projection would be asserting on a type
    // that does not have it.
    if (projected.kind !== "snapshot" && projected.kind !== "cloudSyncStatus") {
      throw new Error("projection changed the frame kind");
    }
    expect(projected.authorityEpoch).toBe("epoch-1");
  });

  it("passes a frame through untouched at the floor and above", () => {
    const frame = snapshotWithLegs();
    expect(
      epicStatusFrameForNegotiatedMinor(
        frame,
        EPIC_STATUS_DURABILITY_LEGS_MINOR,
      ),
    ).toEqual(frame);
    expect(
      epicStatusFrameForNegotiatedMinor(
        frame,
        EPIC_STATUS_DURABILITY_LEGS_MINOR + 1,
      ),
    ).toEqual(frame);
  });

  it("leaves a frame that never carried legs alone on either side of the floor", () => {
    const pong = epicStatusSubscribeServerFrameSchemaV11.parse({
      kind: "pong",
      hasBinaryPayload: false,
    });
    expect(
      epicStatusFrameForNegotiatedMinor(
        pong,
        EPIC_STATUS_DURABILITY_LEGS_MINOR - 1,
      ),
    ).toEqual(pong);
  });
});
