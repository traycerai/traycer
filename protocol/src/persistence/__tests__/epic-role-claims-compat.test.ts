/**
 * Compatibility for the additive `roleClaims` field on the epic record.
 *
 * Two directions, and the second one is the interesting one.
 *
 * OLD RECORD -> NEW CODE is the easy half: `.default({})` means an epic
 * written before roles existed decodes to an empty registry.
 *
 * NEW RECORD -> OLD HOST is where an earlier draft of this design was simply
 * wrong. The fear was that an old host would strip `roleClaims`, because
 * `z.object` drops unknown keys - which would silently erase live claims on a
 * downgrade/read-write cycle. It does not, and the reason is structural:
 * `epicSchema` is never `.parse()`d at runtime (it exists to derive the `Epic`
 * TYPE), and the durable substrate is Yjs, which is schema-agnostic. Host
 * mutations are per-key `Y.Map.set` inside a transaction, so sibling keys an
 * old host has never heard of survive untouched.
 *
 * That claim is load-bearing enough that it is proven here rather than
 * asserted: the round-trip below mutates a doc through a reader that has no
 * knowledge of `roleClaims` and shows the claims still standing afterwards.
 *
 * Also pins that the record stays at v2.0 - no minor bump, no migrator - and
 * that the claimId/map-key integrity rule actually rejects malformed records.
 */
import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { getRecordSchema } from "@traycer/protocol/framework/index";
import { persistenceRecordRegistry } from "@traycer/protocol/persistence/registry";
import { roleClaimsSchema } from "@traycer/protocol/persistence/epic/role-claims";

const epicSchema = getRecordSchema(persistenceRecordRegistry, "epic", "latest");

const CLAIM_ID = "11111111-1111-4111-8111-111111111111";

function legacyEpicWithoutRoleClaims() {
  return {
    id: "epic-1",
    title: "Legacy epic",
    isTitleEditedByUser: false,
    createdAt: 1,
    updatedAt: 2,
    chats: {},
    artifacts: {},
    deletedArtifacts: {},
    tuiAgents: {},
  };
}

describe("epic record: roleClaims is additive at v2.0", () => {
  it("decodes an epic written before roles existed into an empty registry", () => {
    const parsed = epicSchema.parse(legacyEpicWithoutRoleClaims());

    expect(parsed.roleClaims).toEqual({});
  });

  it("stays on record version 2.0 - no minor bump, so no migrator is dragged in", () => {
    // A bump would be worse than unnecessary. Raising the host's
    // CURRENT_EPIC_VERSION_NUMBER pulls every existing 200-stamped row into a
    // migration loop with no matching case; a MAJOR bump flips old hosts to
    // read-only, which is an availability break for epic work that has nothing
    // to do with roles.
    expect(persistenceRecordRegistry.epic[2].latestMinor).toBe(0);
  });

  it("round-trips an epic that carries claims", () => {
    const withClaims = {
      ...legacyEpicWithoutRoleClaims(),
      roleClaims: {
        [CLAIM_ID]: {
          claimId: CLAIM_ID,
          agentId: "agent-1",
          userId: "user-1",
          role: "Planner",
          scope: "auth migration",
          claimedAt: 10,
        },
      },
    };

    const parsed = epicSchema.parse(withClaims);

    expect(parsed.roleClaims[CLAIM_ID]).toEqual(
      withClaims.roleClaims[CLAIM_ID],
    );
  });
});

describe("epic record: an old host preserves roleClaims", () => {
  it("survives a mutation applied by a reader that has never heard of the key", () => {
    // A doc written by a NEW host: it carries roleClaims.
    const newHostDoc = new Y.Doc();
    const root = newHostDoc.getMap("epic");
    newHostDoc.transact(() => {
      root.set("id", "epic-1");
      root.set("title", "Shared epic");
      const claims = new Y.Map<unknown>();
      const claim = new Y.Map<unknown>();
      claim.set("claimId", CLAIM_ID);
      claim.set("agentId", "agent-1");
      claim.set("userId", "user-1");
      claim.set("role", "Planner");
      claim.set("scope", "auth migration");
      claim.set("claimedAt", 10);
      claims.set(CLAIM_ID, claim);
      root.set("roleClaims", claims);
    });

    // An OLD host syncs that doc and mutates it. It knows nothing about
    // `roleClaims` - it only ever touches the keys in its own schema, exactly
    // as the real host does (per-key `Y.Map.set`, never a rebuild-and-replace
    // of the root map).
    const oldHostDoc = new Y.Doc();
    Y.applyUpdate(oldHostDoc, Y.encodeStateAsUpdate(newHostDoc));
    const oldHostRoot = oldHostDoc.getMap("epic");
    expect(oldHostRoot.has("roleClaims")).toBe(true);

    oldHostDoc.transact(() => {
      oldHostRoot.set("title", "Renamed by an old host");
      oldHostRoot.set("updatedAt", 999);
    });

    // ... and the new host syncs the old host's edit back.
    Y.applyUpdate(newHostDoc, Y.encodeStateAsUpdate(oldHostDoc));

    const survivingClaims = newHostDoc.getMap("epic").get("roleClaims");
    expect(survivingClaims).toBeInstanceOf(Y.Map);
    expect(newHostDoc.getMap("epic").get("title")).toBe(
      "Renamed by an old host",
    );

    const claim =
      survivingClaims instanceof Y.Map
        ? survivingClaims.get(CLAIM_ID)
        : undefined;
    expect(claim).toBeInstanceOf(Y.Map);
    expect(claim instanceof Y.Map ? claim.get("role") : null).toBe("Planner");
    expect(claim instanceof Y.Map ? claim.get("agentId") : null).toBe(
      "agent-1",
    );
  });
});

describe("roleClaims integrity", () => {
  it("rejects a record whose map key disagrees with its claimId", () => {
    const mismatched = {
      "99999999-9999-4999-8999-999999999999": {
        claimId: CLAIM_ID,
        agentId: "agent-1",
        userId: "user-1",
        role: "Planner",
        scope: "auth migration",
        claimedAt: 10,
      },
    };

    expect(() => roleClaimsSchema.parse(mismatched)).toThrow();
  });

  it("rejects a non-UUID claim key", () => {
    const notAUuid = {
      "claim-1": {
        claimId: "claim-1",
        agentId: "agent-1",
        userId: "user-1",
        role: "Planner",
        scope: "auth migration",
        claimedAt: 10,
      },
    };

    expect(() => roleClaimsSchema.parse(notAUuid)).toThrow();
  });

  it("accepts a well-formed registry", () => {
    const wellFormed = {
      [CLAIM_ID]: {
        claimId: CLAIM_ID,
        agentId: "agent-1",
        userId: "user-1",
        role: "Planner",
        scope: "auth migration",
        claimedAt: 10,
      },
    };

    expect(() => roleClaimsSchema.parse(wellFormed)).not.toThrow();
  });
});
