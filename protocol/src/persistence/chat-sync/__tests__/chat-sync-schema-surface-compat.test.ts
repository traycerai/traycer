import { getRecordSchema } from "@traycer/protocol/framework/index";
import { chatHeadStorageSchema } from "@traycer/protocol/persistence/chat-sync/head";
import type { JsonObject } from "@traycer/protocol/persistence/chat-sync/json";
import { chatShardStorageSchema } from "@traycer/protocol/persistence/chat-sync/shard";
import { persistenceRecordRegistry } from "@traycer/protocol/persistence/registry";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { chatSyncSchemaSurfaceBaseline } from "./__fixtures__/chat-sync-schema-surface";

/**
 * Frozen surface of the registered `chat-head` / `chat-shard` contract.
 *
 * These records leave the machine that wrote them. Their readers - cloud
 * renderers, clone targets, the backfill job - ship on their own cadences, so a
 * change here reaches shipped code that cannot be redeployed alongside it. That
 * is a stronger constraint than the epic record's, which is why the guard exists
 * BEFORE the records have any writers.
 *
 * Both surfaces are frozen, for both records:
 *
 * - `storage` comes from the explicit WIRE projections, NOT from the registered
 *   schemas' own input surfaces. Both records capture unmodeled keys through
 *   `z.preprocess`, and `z.toJSONSchema` reports a preprocess's inner
 *   (post-capture) schema in both IO modes: that surface requires the internal
 *   `residual` key and marks every captured child optional, so freezing it would
 *   assert the opposite of the truth. The projections are built from the same
 *   shape maps. Preserved variants (message / block / event) and the opaque
 *   host-private payload still render as `{}`, because what they accept really
 *   is "any JSON" - their schemas are predicate checks that hand back the value
 *   unchanged, which is what keeps an own `__proto__` key from being rebuilt
 *   away.
 * - `domain` (default/output) describes the parsed value exposed to readers.
 *   This is the substantial half - it is where drift in the interpreted
 *   message / block / event shapes lands.
 *
 * A frozen schema can be frozen and wrong, so the storage projections also
 * carry semantic assertions below: each must accept a real wire record, reject
 * a truncated one, and never mention `residual`.
 *
 * This test fails on ANY drift, including a compatible additive change. The
 * failure is a review gate, not an assertion that all drift is breaking.
 * Classify the change using `src/persistence/COMPATIBILITY.md`; then either
 * regenerate the baseline for a compatible same-major change or introduce the
 * required version/migration path for a breaking change.
 *
 * Regenerate the reviewable baseline with:
 *   bun run protocol/scripts/snapshot-chat-sync-schema-surface.ts > \
 *     protocol/src/persistence/chat-sync/__tests__/__fixtures__/chat-sync-schema-surface.ts
 */
describe("registered chat-sync persistence surface is frozen", () => {
  const chatHeadSchema = getRecordSchema(
    persistenceRecordRegistry,
    "chat-head",
    "latest",
  );

  const chatShardSchema = getRecordSchema(
    persistenceRecordRegistry,
    "chat-shard",
    "latest",
  );

  it("head storage (wire projection) JSON Schema matches the baseline", () => {
    expect(z.toJSONSchema(chatHeadStorageSchema, { io: "input" })).toEqual(
      chatSyncSchemaSurfaceBaseline.head.storage,
    );
  });

  it("head domain (default/output) JSON Schema matches the baseline", () => {
    expect(z.toJSONSchema(chatHeadSchema)).toEqual(
      chatSyncSchemaSurfaceBaseline.head.domain,
    );
  });

  it("shard storage (wire projection) JSON Schema matches the baseline", () => {
    expect(z.toJSONSchema(chatShardStorageSchema, { io: "input" })).toEqual(
      chatSyncSchemaSurfaceBaseline.shard.storage,
    );
  });

  it("shard domain (default/output) JSON Schema matches the baseline", () => {
    expect(z.toJSONSchema(chatShardSchema)).toEqual(
      chatSyncSchemaSurfaceBaseline.shard.domain,
    );
  });
});

/**
 * A frozen surface can be frozen and wrong. These assertions pin what the
 * storage projections MEAN, so a projection that drifts away from the wire
 * fails here rather than sitting green in the fixture.
 */
describe("chat-sync storage projections describe the wire", () => {
  const wireHead: JsonObject = {
    schemaVersion: { major: 1, minor: 2 },
    parentHeadSha256: null,
    throughRecordSeq: 4,
    capturedAt: 1_700_000_000_000,
    minReaderVersion: { major: 1, minor: 2 },
    cdc: {
      algorithm: "fastcdc-gear-v1",
      mask: 65_535,
      target: 65_536,
      min: 16_384,
      max: 262_144,
    },
    core: {
      chatId: "chat-1",
      parentChatId: null,
      ownerUserId: "u-1",
      originHostId: "host-1",
      title: "A chat",
      isTitleEditedByUser: false,
      createdAt: 1,
      updatedAt: 2,
      lifecycle: { state: "active", archivedAt: null, deletedAt: null },
      settings: null,
    },
    messageShards: [],
    events: [],
    eventShards: [],
    hostPrivate: { revision: 0, data: {} },
    hostPrivateShard: null,
  };

  // Non-empty on purpose: a shard IS a cohort, so the registered schema rejects
  // an empty selected section (see `refineChatShardSection`). The storage
  // PROJECTION cannot express that - a refinement has no JSON-Schema form - so
  // this record has to satisfy both to prove the two describe the same wire.
  const wireShard: JsonObject = {
    schemaVersion: { major: 1, minor: 2 },
    chatId: "chat-1",
    section: "messages",
    messages: [
      {
        role: "user",
        messageId: "m-1",
        sender: { type: "user", userId: "u-1" },
        message: { kind: "user", content: { type: "doc" } },
        timestamp: 1,
        sessionAnchor: null,
      },
    ],
    events: [],
    hostPrivate: null,
  };

  it("accepts real wire records - ones with no residual keys at all", () => {
    expect(chatHeadStorageSchema.safeParse(wireHead).success).toBe(true);
    expect(chatShardStorageSchema.safeParse(wireShard).success).toBe(true);

    // And the registered schemas agree, so the two describe the same input.
    expect(
      getRecordSchema(
        persistenceRecordRegistry,
        "chat-head",
        "latest",
      ).safeParse(wireHead).success,
    ).toBe(true);
    expect(
      getRecordSchema(
        persistenceRecordRegistry,
        "chat-shard",
        "latest",
      ).safeParse(wireShard).success,
    ).toBe(true);
  });

  it("accepts wire records carrying unmodeled keys", () => {
    expect(
      chatHeadStorageSchema.safeParse({ ...wireHead, futureTopLevel: 1 })
        .success,
    ).toBe(true);
    expect(
      chatShardStorageSchema.safeParse({ ...wireShard, futureTopLevel: 1 })
        .success,
    ).toBe(true);
  });

  it("rejects a record missing a required section", () => {
    // The bug this guards: the preprocess surface marks captured children
    // optional, so a truncated record would "pass" a frozen storage schema.
    for (const omitted of [
      "core",
      "hostPrivate",
      "schemaVersion",
      "messageShards",
    ]) {
      const truncated: JsonObject = { ...wireHead };
      delete truncated[omitted];
      expect(chatHeadStorageSchema.safeParse(truncated).success).toBe(false);
    }

    for (const omitted of ["schemaVersion", "chatId", "section", "messages"]) {
      const truncated: JsonObject = { ...wireShard };
      delete truncated[omitted];
      expect(chatShardStorageSchema.safeParse(truncated).success).toBe(false);
    }
  });

  it("never mentions residual on the persisted surfaces", () => {
    // `residual` is an internal domain-side field; it must not appear as a
    // property or a requirement of anything a writer puts on the wire.
    for (const surface of [
      JSON.stringify(z.toJSONSchema(chatHeadStorageSchema, { io: "input" })),
      JSON.stringify(z.toJSONSchema(chatShardStorageSchema, { io: "input" })),
      JSON.stringify(chatSyncSchemaSurfaceBaseline.head.storage),
      JSON.stringify(chatSyncSchemaSurfaceBaseline.shard.storage),
    ]) {
      expect(surface).not.toContain("residual");
    }
  });

  it("keeps the captured levels required and open", () => {
    const parsed = z.parse(
      z.object({
        required: z.array(z.string()),
        additionalProperties: z.unknown(),
        properties: z.object({
          core: z.object({
            required: z.array(z.string()),
            additionalProperties: z.unknown(),
          }),
        }),
      }),
      z.toJSONSchema(chatHeadStorageSchema, { io: "input" }),
    );

    expect(parsed.required).toEqual(
      expect.arrayContaining([
        "schemaVersion",
        "parentHeadSha256",
        "core",
        "messageShards",
        "hostPrivate",
      ]),
    );
    expect(parsed.properties.core.required).toEqual(
      expect.arrayContaining(["chatId", "lifecycle", "settings"]),
    );
    // Unmodeled keys are accepted at every captured level - that is what makes
    // residual capture possible in the first place.
    expect(parsed.additionalProperties).toBeDefined();
    expect(parsed.properties.core.additionalProperties).toBeDefined();
  });
});
