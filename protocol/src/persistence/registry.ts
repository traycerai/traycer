import {
  defineRecordContract,
  defineRecordDowngradePath,
  defineRecordUpgradePath,
  defineVersionedRecordRegistry,
  type RecordValue,
} from "@traycer/protocol/framework/index";
import {
  chatHeadRecordSchema,
  chatShardRecordSchema,
} from "@traycer/protocol/persistence/_internal/chat-sync-schemas";
import { CHAT_SYNC_SCHEMA_VERSION } from "@traycer/protocol/persistence/chat-sync/version";
import {
  epicSchema,
  epicSchemaPreReasonix,
} from "@traycer/protocol/persistence/_internal/epic-schemas";
import { roomMetadataSchema } from "@traycer/protocol/persistence/_internal/room-metadata-schemas";

/**
 * Traycer 3.0 persistence record protocol.
 * Compatibility rules and the frozen epic-schema review workflow live in `COMPATIBILITY.md` beside this registry.
 */

export const epicRecordV200 = defineRecordContract({
  name: "epic",
  schemaVersion: { major: 2, minor: 0 } as const,
  schema: epicSchemaPreReasonix,
});

export const epicRecordV300 = defineRecordContract({
  name: "epic",
  schemaVersion: { major: 3, minor: 0 } as const,
  schema: epicSchema,
});

const epicUpgradeV200ToV300 = defineRecordUpgradePath<
  typeof epicRecordV200,
  typeof epicRecordV300
>({
  from: epicRecordV200.schemaVersion,
  to: epicRecordV300.schemaVersion,
  upgradeRecord: (record) => epicRecordV300.schema.parse(record),
});

const epicDowngradeV300ToV200 = defineRecordDowngradePath<
  typeof epicRecordV300,
  typeof epicRecordV200
>({
  from: epicRecordV300.schemaVersion,
  to: epicRecordV200.schemaVersion,
  downgradeRecord: (record) => {
    const parsed = epicRecordV200.schema.safeParse(record);
    if (parsed.success) return { ok: true as const, value: parsed.data };
    return {
      ok: false as const,
      error: {
        code: "DOWNGRADE_UNSUPPORTED" as const,
        message:
          "Epic contains Reasonix harness state that the 2.0 record contract cannot represent",
      },
    };
  },
});

export const roomMetadataRecordV100 = defineRecordContract({
  name: "room-metadata",
  schemaVersion: { major: 1, minor: 0 } as const,
  schema: roomMetadataSchema,
});

// Both bind the SAME `CHAT_SYNC_SCHEMA_VERSION` object the payload schemas are pinned to - identity, not a repeated literal.

export const chatHeadRecordV130 = defineRecordContract({
  name: "chat-head",
  schemaVersion: CHAT_SYNC_SCHEMA_VERSION,
  schema: chatHeadRecordSchema,
});

export const chatShardRecordV130 = defineRecordContract({
  name: "chat-shard",
  schemaVersion: CHAT_SYNC_SCHEMA_VERSION,
  schema: chatShardRecordSchema,
});

export const persistenceRecordRegistry = defineVersionedRecordRegistry({
  epic: {
    2: {
      latestMinor: 0,
      versions: {
        0: { contract: epicRecordV200, upgradeFromPreviousVersion: null },
      },
      downgradePathsFromLatest: {},
    },
    3: {
      latestMinor: 0,
      versions: {
        0: {
          contract: epicRecordV300,
          upgradeFromPreviousVersion: epicUpgradeV200ToV300,
        },
      },
      downgradePathsFromLatest: { 2: epicDowngradeV300ToV200 },
    },
  },
  "room-metadata": {
    1: {
      latestMinor: 0,
      versions: {
        0: {
          contract: roomMetadataRecordV100,
          upgradeFromPreviousVersion: null,
        },
      },
      downgradePathsFromLatest: {},
    },
  },
  "chat-head": {
    1: {
      latestMinor: 3,
      versions: {
        3: { contract: chatHeadRecordV130, upgradeFromPreviousVersion: null },
      },
      downgradePathsFromLatest: {},
    },
  },
  "chat-shard": {
    1: {
      latestMinor: 3,
      versions: {
        3: { contract: chatShardRecordV130, upgradeFromPreviousVersion: null },
      },
      downgradePathsFromLatest: {},
    },
  },
});

export type PersistenceRecordRegistry = typeof persistenceRecordRegistry;

// Types via `RecordValue<>` so runtime + type stay in lock-step.

export type Epic = RecordValue<PersistenceRecordRegistry, "epic">;
export type RoomMetadata = RecordValue<
  PersistenceRecordRegistry,
  "room-metadata"
>;
export type ChatHead = RecordValue<PersistenceRecordRegistry, "chat-head">;
export type ChatShard = RecordValue<PersistenceRecordRegistry, "chat-shard">;
