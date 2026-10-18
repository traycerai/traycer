import { describe, expect, it } from "vitest";
import {
  downgradeRecordAcrossMajors,
  getRecordSchema,
  loadRecord,
  validateVersionedRecordRegistry,
  validateVersionedRpcRegistry,
} from "@traycer/protocol/framework/index";
import { hostRpcRegistry } from "@traycer/protocol/host/index";
import { commonRecordRegistry } from "@traycer/protocol/common/registry";
import {
  chatHeadRecordV190,
  chatShardRecordV190,
  type Epic,
  persistenceRecordRegistry,
} from "@traycer/protocol/persistence/registry";
import {
  chatHeadRecordV190 as chatSyncHeadContract,
  chatShardRecordV190 as chatSyncShardContract,
  chatSyncRecordRegistry,
} from "@traycer/protocol/persistence/chat-sync-registry";
import {
  buildDeletedEpicArtifact,
  epicArtifactSchema,
} from "@traycer/protocol/persistence/epic/artifacts";
import { CHAT_SYNC_SCHEMA_VERSION } from "@traycer/protocol/persistence/chat-sync/version";

/**
 * Smoke test that every seeded protocol registry survives the structural
 * + JSON-Schema compatibility validators. Construction (`define*`) is
 * structural-only, so a broken seed no longer blows up on import; these
 * assertions call the full validators explicitly. CI also holds every
 * static registry to the same pass via
 * `protocol/scripts/compat/static-registries.ts`.
 *
 * The CloudData RPC registry has moved out of `protocol/` and now lives
 * beside the `CloudDataClient` HTTP client in the cloud data client
 * (internal, not in this repo). The cloud catalog
 * (`epic-light`), repo association, and workspace-association cached
 * records moved with it; this file keeps only the host + narrowed
 * persistence (`2.0.0` / V200 epic record) registries honest.
 */

describe("seeded protocol registries", () => {
  it("host registry validates", () => {
    expect(() => validateVersionedRpcRegistry(hostRpcRegistry)).not.toThrow();
  });

  it("persistence record registry validates", () => {
    expect(() =>
      validateVersionedRecordRegistry(persistenceRecordRegistry),
    ).not.toThrow();
  });

  it("chat-sync record registry validates", () => {
    expect(() =>
      validateVersionedRecordRegistry(chatSyncRecordRegistry),
    ).not.toThrow();
  });

  it("chat-sync and persistence registries resolve the same schema instances", () => {
    // The contracts are defined once in chat-sync-registry.ts and re-exported
    // / re-registered by registry.ts, so a worker that imports only the
    // narrow registry still hashes the same schema object the host uses.
    expect(getRecordSchema(chatSyncRecordRegistry, "chat-head", "latest")).toBe(
      getRecordSchema(persistenceRecordRegistry, "chat-head", "latest"),
    );
    expect(
      getRecordSchema(chatSyncRecordRegistry, "chat-shard", "latest"),
    ).toBe(getRecordSchema(persistenceRecordRegistry, "chat-shard", "latest"));
    expect(chatHeadRecordV190).toBe(chatSyncHeadContract);
    expect(chatShardRecordV190).toBe(chatSyncShardContract);
  });

  it("chat-sync record registry has only the two publication records", () => {
    expect(Object.keys(chatSyncRecordRegistry)).toEqual([
      "chat-head",
      "chat-shard",
    ]);
  });

  it("versions the shared Reasonix harness id as a new record major", () => {
    expect(Object.keys(commonRecordRegistry["harness-id"]).sort()).toEqual([
      "1",
      "2",
    ]);
    expect(
      loadRecord(commonRecordRegistry, "harness-id", "claude", {
        major: 1,
        minor: 0,
      }),
    ).toBe("claude");
    expect(
      downgradeRecordAcrossMajors(
        commonRecordRegistry["harness-id"],
        2,
        1,
        "claude",
      ),
    ).toEqual({ ok: true, value: "claude" });
    expect(
      downgradeRecordAcrossMajors(
        commonRecordRegistry["harness-id"],
        2,
        1,
        "reasonix",
      ),
    ).toEqual({
      ok: false,
      error: {
        code: "DOWNGRADE_UNSUPPORTED",
        message: "This harness cannot be represented by harness-id record 1.0",
      },
    });
  });

  it("versions the shared artifact kind as a new record major", () => {
    expect(
      Object.keys(commonRecordRegistry["epic-artifact-kind"]).sort(),
    ).toEqual(["1", "2"]);
    expect(
      commonRecordRegistry["epic-artifact-kind"][2].versions[
        commonRecordRegistry["epic-artifact-kind"][2].latestMinor
      ].contract.schemaVersion,
    ).toEqual({ major: 2, minor: 0 });

    for (const kind of ["spec", "ticket", "story", "review"] as const) {
      expect(
        loadRecord(commonRecordRegistry, "epic-artifact-kind", kind, {
          major: 1,
          minor: 0,
        }),
      ).toBe(kind);
      expect(
        downgradeRecordAcrossMajors(
          commonRecordRegistry["epic-artifact-kind"],
          2,
          1,
          kind,
        ),
      ).toEqual({ ok: true, value: kind });
    }

    // Every kind added after 1.0 takes the same refusal. The message stays
    // kind-neutral because naming the first new kind would misreport every
    // kind added after it. The schema checks keep the refusal honest: it only
    // means something while 2.0 accepts the kind and 1.0 rejects it.
    for (const kind of ["html", "canvas", "file"] as const) {
      expect(
        getRecordSchema(
          commonRecordRegistry,
          "epic-artifact-kind",
          "latest",
        ).safeParse(kind).success,
      ).toBe(true);
      expect(
        getRecordSchema(commonRecordRegistry, "epic-artifact-kind", {
          major: 1,
          minor: 0,
        }).safeParse(kind).success,
      ).toBe(false);
      expect(
        downgradeRecordAcrossMajors(
          commonRecordRegistry["epic-artifact-kind"],
          2,
          1,
          kind,
        ),
      ).toEqual({
        ok: false,
        error: {
          code: "DOWNGRADE_UNSUPPORTED",
          message:
            "This artifact kind cannot be represented by epic-artifact-kind record 1.0",
        },
      });
    }
  });

  it("persistence owns the epic, room-metadata, chat-sync and draft-head records", () => {
    expect(Object.keys(persistenceRecordRegistry).sort()).toEqual([
      "chat-head",
      "chat-shard",
      "draft-head",
      "epic",
      "room-metadata",
    ]);
    expect(Object.keys(persistenceRecordRegistry.epic).sort()).toEqual([
      "2",
      "3",
      "4",
    ]);
    expect(
      Object.keys(persistenceRecordRegistry["room-metadata"]).sort(),
    ).toEqual(["1"]);
    expect(Object.keys(persistenceRecordRegistry["chat-head"]).sort()).toEqual([
      "1",
    ]);
    expect(Object.keys(persistenceRecordRegistry["chat-shard"]).sort()).toEqual(
      ["1"],
    );
    expect(Object.keys(persistenceRecordRegistry["draft-head"]).sort()).toEqual(
      ["1"],
    );
  });

  it("registers both chat-sync records on one version line", () => {
    // A shard embeds the sub-schemas the head's core is built from, so every
    // change that moves one moves the other. Bound to the SAME constant object,
    // not two equal literals - see `chat-sync/version.ts`.
    // Indexed by the pinned constant rather than a hard-coded minor: this
    // assertion is about the two records sharing ONE version object, and a
    // literal here would have to be edited on every chat-sync bump - turning a
    // green run into a chore instead of a check.
    expect(
      persistenceRecordRegistry["chat-head"][1].versions[
        CHAT_SYNC_SCHEMA_VERSION.minor
      ].contract.schemaVersion,
    ).toBe(
      persistenceRecordRegistry["chat-shard"][1].versions[
        CHAT_SYNC_SCHEMA_VERSION.minor
      ].contract.schemaVersion,
    );
  });

  it("latest local epic record captures on-disk-only fields", () => {
    const epicRecordV400 =
      persistenceRecordRegistry.epic[4].versions[0].contract;
    const onDiskEpicKeys = Object.keys(epicRecordV400.schema.shape);

    expect(epicRecordV400.schemaVersion).toEqual({ major: 4, minor: 0 });

    // `artifacts` and `deletedArtifacts` are the unified on-disk
    // replacements for the four per-kind maps (specs / tickets / stories
    // / reviews) the V200 / `2.0.0` authority uses. `chats` is also
    // on-disk-only.
    for (const field of ["chats", "artifacts", "deletedArtifacts"]) {
      expect(onDiskEpicKeys).toContain(field);
    }
  });

  it("upgrades Epic 2.0 and refuses a lossy Reasonix downgrade", () => {
    const v200 = {
      id: "epic-1",
      title: "Epic",
      isTitleEditedByUser: false,
      createdAt: 1,
      updatedAt: 1,
      chats: {},
      artifacts: {},
      deletedArtifacts: {},
    };
    const upgraded = loadRecord(persistenceRecordRegistry, "epic", v200, {
      major: 2,
      minor: 0,
    });
    expect(upgraded).toMatchObject(v200);
    // `loadRecord` returns the live (seven-kind) epic. The 3.0 bridge accepts
    // only the registered 3.0 record, so re-parse against that major first.
    const upgradedAsV300 =
      persistenceRecordRegistry.epic[3].versions[0].contract.schema.parse(
        upgraded,
      );
    expect(
      downgradeRecordAcrossMajors(
        persistenceRecordRegistry.epic,
        3,
        2,
        upgradedAsV300,
      ),
    ).toMatchObject({ ok: true });

    const reasonixEpic =
      persistenceRecordRegistry.epic[3].versions[0].contract.schema.parse({
        ...v200,
        chats: {
          "chat-1": {
            parentId: null,
            id: "chat-1",
            userId: "user-1",
            hostId: "host-1",
            title: "Reasonix chat",
            createdAt: 1,
            updatedAt: 1,
            isTitleEditedByUser: false,
            messages: [],
            settings: {
              harnessId: "reasonix",
              model: "reasonix/model",
              permissionMode: "supervised",
              reasoningEffort: null,
              agentMode: "regular",
            },
          },
        },
      });
    expect(
      downgradeRecordAcrossMajors(
        persistenceRecordRegistry.epic,
        3,
        2,
        reasonixEpic,
      ),
    ).toEqual({
      ok: false,
      error: {
        code: "DOWNGRADE_UNSUPPORTED",
        message:
          "Epic contains harness state that the 2.0 record contract cannot represent",
      },
    });
  });
  describe("Epic 3.0 to 4.0 (HTML, canvas and file artifacts)", () => {
    const markdownArtifact = {
      kind: "spec" as const,
      id: "artifact-1",
      folderName: "spec-1",
      title: "Spec",
      artifactRoomId: "room-1",
      createdAt: 1,
      updatedAt: 1,
      createdManually: false,
      parentId: null,
    };
    const epicV300 = {
      id: "epic-1",
      title: "Epic",
      isTitleEditedByUser: false,
      createdAt: 1,
      updatedAt: 1,
      chats: {},
      artifacts: { "artifact-1": markdownArtifact },
      deletedArtifacts: {},
    };
    const htmlArtifact = {
      kind: "html" as const,
      id: "artifact-2",
      folderName: "page-1",
      title: "Page",
      createdAt: 1,
      updatedAt: 1,
      createdManually: false,
      parentId: null,
      layout: "folder" as const,
      head: { files: {}, capturedAt: 1 },
    };

    it("upgrades a stored 3.0 epic by parsing it as is", () => {
      const upgraded = loadRecord(persistenceRecordRegistry, "epic", epicV300, {
        major: 3,
        minor: 0,
      });
      expect(upgraded).toMatchObject(epicV300);
    });

    it("downgrades a 4.0 epic holding only markdown artifacts to 3.0 and 2.0", () => {
      const current =
        persistenceRecordRegistry.epic[4].versions[0].contract.schema.parse(
          epicV300,
        );
      for (const target of [3, 2] as const) {
        expect(
          downgradeRecordAcrossMajors(
            persistenceRecordRegistry.epic,
            4,
            target,
            current,
          ),
        ).toMatchObject({ ok: true });
      }
    });

    const canvasArtifact = {
      kind: "canvas" as const,
      id: "artifact-3",
      folderName: "canvas-1",
      title: "Canvas",
      artifactRoomId: "room-3",
      createdAt: 1,
      updatedAt: 1,
      createdManually: false,
      parentId: null,
      layout: "folder" as const,
      head: { files: {}, capturedAt: 1 },
    };
    const fileArtifact = {
      kind: "file" as const,
      id: "artifact-4",
      folderName: "file-1",
      title: "File",
      createdAt: 1,
      updatedAt: 1,
      createdManually: false,
      parentId: null,
      layout: "file" as const,
      sha256: "a".repeat(64),
      byteLength: 12,
      mediaType: "text/html",
      status: "published" as const,
    };
    const newKindArtifacts = [
      { label: "html", id: "artifact-2", artifact: htmlArtifact },
      { label: "canvas", id: "artifact-3", artifact: canvasArtifact },
      { label: "file", id: "artifact-4", artifact: fileArtifact },
    ] as const;

    function expectRefusedAtEveryOlderMajor(current: Epic): void {
      for (const target of [3, 2] as const) {
        expect(
          downgradeRecordAcrossMajors(
            persistenceRecordRegistry.epic,
            4,
            target,
            current,
          ),
        ).toMatchObject({
          ok: false,
          error: { code: "DOWNGRADE_UNSUPPORTED" },
        });
      }
    }

    it.each(newKindArtifacts)(
      "refuses to downgrade a 4.0 epic holding a live $label artifact",
      ({ id, artifact }) => {
        const withNewKind =
          persistenceRecordRegistry.epic[4].versions[0].contract.schema.parse({
            ...epicV300,
            artifacts: { ...epicV300.artifacts, [id]: artifact },
          });
        expectRefusedAtEveryOlderMajor(withNewKind);
      },
    );

    // A tombstone is the only trace of a deleted artifact. An older reader
    // would drop its kind, so the revive would no longer know what to restore.
    it.each(newKindArtifacts)(
      "refuses to downgrade a 4.0 epic whose only $label content is a tombstone",
      ({ id, artifact }) => {
        const tombstone = buildDeletedEpicArtifact(
          epicArtifactSchema.parse(artifact),
          "2026-10-18T00:00:00.000Z",
        );
        const withTombstone =
          persistenceRecordRegistry.epic[4].versions[0].contract.schema.parse({
            ...epicV300,
            deletedArtifacts: { [id]: tombstone },
          });
        expect(Object.keys(withTombstone.artifacts)).toEqual(["artifact-1"]);
        expectRefusedAtEveryOlderMajor(withTombstone);
      },
    );
  });
});
