import {
  defineRecordContract,
  defineRecordDowngradePath,
  defineRecordUpgradePath,
  defineVersionedRecordRegistry,
  type RecordValue,
} from "@traycer/protocol/framework/index";
import {
  chatHeadRecordV180,
  chatShardRecordV180,
} from "@traycer/protocol/persistence/chat-sync-registry";
import { draftHeadRecordSchema } from "@traycer/protocol/persistence/_internal/draft-schemas";
import { DRAFT_HEAD_SCHEMA_VERSION } from "@traycer/protocol/persistence/draft/version";
import {
  epicSchema,
  epicSchemaPreHtml,
  epicSchemaPreReasonix,
} from "@traycer/protocol/persistence/_internal/epic-schemas";
import { roomMetadataSchema } from "@traycer/protocol/persistence/_internal/room-metadata-schemas";

/**
 * Traycer 3.0 persistence record protocol.
 *
 * Each entry describes the on-disk shape of a logical record type:
 *
 * - `epic` - the local on-disk epic document at V200. Legacy pre-V200
 *   shapes live as hand-rolled TS interfaces + migrations inside the host
 *   (the external Traycer Host); protocol keeps
 *   the current record authority aligned to the live V200 / 2.0.0 line
 *   instead of rebasing it to 1.0.
 * - `room-metadata` - Tiptap Cloud Yjs room metadata stored at
 *   `doc.getMap("meta")`. Lives independently of the epic record because
 *   clients read it before interpreting the rest of the room.
 * - `chat-head` / `chat-shard` - a published chat: a small mutable head on the
 *   chat's cloud row plus the immutable, content-addressed shards it names.
 *   Not Yjs shapes - the owning host serializes them and readers on other
 *   release cadences (cloud renderers, clone targets) assemble them. They share
 *   ONE version line (`chat-sync/version.ts`), because a shard embeds the
 *   sub-schemas the head's core is built from.
 * - `draft-head` - a published draft / stash / interview in the personal
 *   `drafts` scope. Same tenant envelope (`parts`) as `chat-head`; the
 *   payload is the `draft/v1` dialect. Images are blobs, so v1 names no
 *   shards and the envelope is empty.
 *
 * Cloud-catalog / task-ref / workspace-association caches are owned by
 * the cloud data client (internal, not in this repo) and are NOT versioned
 * here. Phases were folded into epics in Traycer 3.0, so there is no
 * `phase-light` record here either.
 *
 * Compatibility rules and the frozen epic-schema review workflow live in
 * `COMPATIBILITY.md` beside this registry.
 */

export const epicRecordV200 = defineRecordContract({
  name: "epic",
  schemaVersion: { major: 2, minor: 0 } as const,
  schema: epicSchemaPreReasonix,
});

export const epicRecordV300 = defineRecordContract({
  name: "epic",
  schemaVersion: { major: 3, minor: 0 } as const,
  schema: epicSchemaPreHtml,
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
        // Names no harness, for the same reason as the `harness-id` bridge in
        // `common/registry.ts`: 2.0 froze before Reasonix and every id added
        // after it (Antigravity, and whatever follows) fails closed here too.
        message:
          "Epic contains harness state that the 2.0 record contract cannot represent",
      },
    };
  },
});

export const epicRecordV400 = defineRecordContract({
  name: "epic",
  schemaVersion: { major: 4, minor: 0 } as const,
  schema: epicSchema,
});

const epicUpgradeV300ToV400 = defineRecordUpgradePath<
  typeof epicRecordV300,
  typeof epicRecordV400
>({
  from: epicRecordV300.schemaVersion,
  to: epicRecordV400.schemaVersion,
  upgradeRecord: (record) => epicRecordV400.schema.parse(record),
});

const epicDowngradeV400ToV300 = defineRecordDowngradePath<
  typeof epicRecordV400,
  typeof epicRecordV300
>({
  from: epicRecordV400.schemaVersion,
  to: epicRecordV300.schemaVersion,
  downgradeRecord: (record) => {
    const parsed = epicRecordV300.schema.safeParse(record);
    if (parsed.success) return { ok: true as const, value: parsed.data };
    return {
      ok: false as const,
      error: {
        code: "DOWNGRADE_UNSUPPORTED" as const,
        message:
          "Epic contains artifact kinds the 3.0 record contract cannot represent",
      },
    };
  },
});

// The framework uses direct bridges, so latest must also reach the 2.0 line.
const epicDowngradeV400ToV200 = defineRecordDowngradePath<
  typeof epicRecordV400,
  typeof epicRecordV200
>({
  from: epicRecordV400.schemaVersion,
  to: epicRecordV200.schemaVersion,
  downgradeRecord: (record) => {
    const parsed = epicRecordV200.schema.safeParse(record);
    if (parsed.success) return { ok: true as const, value: parsed.data };
    return {
      ok: false as const,
      error: {
        code: "DOWNGRADE_UNSUPPORTED" as const,
        message:
          "Epic contains artifact kinds or harness state the 2.0 record contract cannot represent",
      },
    };
  },
});

export const roomMetadataRecordV100 = defineRecordContract({
  name: "room-metadata",
  schemaVersion: { major: 1, minor: 0 } as const,
  schema: roomMetadataSchema,
});

// The chat-sync contracts are owned by `chat-sync-registry.ts`, which registers
// them on their own for consumers that encode nothing else; re-exported here so
// this registry keeps offering every contract it registers.
export { chatHeadRecordV180, chatShardRecordV180 };

export const draftHeadRecordV100 = defineRecordContract({
  name: "draft-head",
  schemaVersion: DRAFT_HEAD_SCHEMA_VERSION,
  schema: draftHeadRecordSchema,
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
    4: {
      latestMinor: 0,
      versions: {
        0: {
          contract: epicRecordV400,
          upgradeFromPreviousVersion: epicUpgradeV300ToV400,
        },
      },
      downgradePathsFromLatest: {
        3: epicDowngradeV400ToV300,
        2: epicDowngradeV400ToV200,
      },
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
      latestMinor: 8,
      versions: {
        8: { contract: chatHeadRecordV180, upgradeFromPreviousVersion: null },
      },
      downgradePathsFromLatest: {},
    },
  },
  "chat-shard": {
    1: {
      latestMinor: 8,
      versions: {
        8: { contract: chatShardRecordV180, upgradeFromPreviousVersion: null },
      },
      downgradePathsFromLatest: {},
    },
  },
  "draft-head": {
    1: {
      latestMinor: 0,
      versions: {
        0: { contract: draftHeadRecordV100, upgradeFromPreviousVersion: null },
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
export type DraftHead = RecordValue<PersistenceRecordRegistry, "draft-head">;
