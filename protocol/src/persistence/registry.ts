import {
  defineRecordContract,
  defineRecordDowngradePath,
  defineRecordUpgradePath,
  defineVersionedRecordRegistry,
  type RecordValue,
} from "@traycer/protocol/framework/index";
import {
  chatHeadRecordV160,
  chatShardRecordV160,
} from "@traycer/protocol/persistence/chat-sync-registry";
import { draftHeadRecordSchema } from "@traycer/protocol/persistence/_internal/draft-schemas";
import { DRAFT_HEAD_SCHEMA_VERSION } from "@traycer/protocol/persistence/draft/version";
import {
  epicSchema,
  epicSchemaPreReasonix,
} from "@traycer/protocol/persistence/_internal/epic-schemas";
import {
  identityDocumentRecordSchema,
  identityRecordValueSchema,
} from "@traycer/protocol/persistence/_internal/identity-schemas";
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
 * - `identity` / `identity-document` - the two host-written shapes in an agent
 *   identity's ROOT room: the identity's own settings at
 *   `doc.getMap("identity")`, and ONE value of `doc.getMap("documents")`. Two
 *   records rather than one nested shape, because the documents map's leniency
 *   is per entry: a file path a reader cannot parse is dropped without taking
 *   the identity's settings with it. The room's `meta` reuses `room-metadata`
 *   unchanged, and its `files` map is the file plane's manifest - neither is a
 *   record of its own here.
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
        // Names no harness, for the same reason as the `harness-id` bridge in
        // `common/registry.ts`: 2.0 froze before Reasonix and every id added
        // after it (Antigravity, and whatever follows) fails closed here too.
        message:
          "Epic contains harness state that the 2.0 record contract cannot represent",
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
export { chatHeadRecordV160, chatShardRecordV160 };

export const draftHeadRecordV100 = defineRecordContract({
  name: "draft-head",
  schemaVersion: DRAFT_HEAD_SCHEMA_VERSION,
  schema: draftHeadRecordSchema,
});

export const identityRecordV100 = defineRecordContract({
  name: "identity",
  schemaVersion: { major: 1, minor: 0 } as const,
  schema: identityRecordValueSchema,
});

export const identityDocumentRecordV100 = defineRecordContract({
  name: "identity-document",
  schemaVersion: { major: 1, minor: 0 } as const,
  schema: identityDocumentRecordSchema,
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
      latestMinor: 6,
      versions: {
        6: { contract: chatHeadRecordV160, upgradeFromPreviousVersion: null },
      },
      downgradePathsFromLatest: {},
    },
  },
  "chat-shard": {
    1: {
      latestMinor: 6,
      versions: {
        6: { contract: chatShardRecordV160, upgradeFromPreviousVersion: null },
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
  // Both identity records open at 1.0, so there is no previous version to
  // upgrade FROM and no older major to downgrade TO. The empty maps are the
  // shape a first line always has here (`room-metadata` and `draft-head` carry
  // the same pair); the paths arrive with the first real evolution of either
  // shape, and `COMPATIBILITY.md`'s same-major rules govern what may land
  // without one.
  identity: {
    1: {
      latestMinor: 0,
      versions: {
        0: { contract: identityRecordV100, upgradeFromPreviousVersion: null },
      },
      downgradePathsFromLatest: {},
    },
  },
  "identity-document": {
    1: {
      latestMinor: 0,
      versions: {
        0: {
          contract: identityDocumentRecordV100,
          upgradeFromPreviousVersion: null,
        },
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
export type Identity = RecordValue<PersistenceRecordRegistry, "identity">;
export type IdentityDocument = RecordValue<
  PersistenceRecordRegistry,
  "identity-document"
>;
