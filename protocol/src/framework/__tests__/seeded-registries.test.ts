import { describe, expect, it } from "vitest";
import {
  downgradeRecordAcrossMajors,
  loadRecord,
  validateVersionedRecordRegistry,
  validateVersionedRpcRegistry,
} from "@traycer/protocol/framework/index";
import { hostRpcRegistry } from "@traycer/protocol/host/index";
import { commonRecordRegistry } from "@traycer/protocol/common/registry";
import { persistenceRecordRegistry } from "@traycer/protocol/persistence/registry";

/**
 * Smoke test that every seeded protocol registry survives the structural
 * + JSON-Schema compatibility validators. `defineVersionedRpcRegistry()`
 * and `defineVersionedRecordRegistry()` run these at module load, so a
 * broken seed would blow up on import - these assertions just pin the
 * guarantee with explicit coverage.
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
        message: "Reasonix cannot be represented by harness-id record 1.0",
      },
    });
  });

  it("persistence owns the epic, room-metadata and chat-sync records", () => {
    expect(Object.keys(persistenceRecordRegistry).sort()).toEqual([
      "chat-head",
      "chat-shard",
      "epic",
      "room-metadata",
    ]);
    expect(Object.keys(persistenceRecordRegistry.epic).sort()).toEqual([
      "2",
      "3",
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
  });

  it("registers both chat-sync records on one version line", () => {
    // A shard embeds the sub-schemas the head's core is built from, so every
    // change that moves one moves the other. Bound to the SAME constant object,
    // not two equal literals - see `chat-sync/version.ts`.
    expect(
      persistenceRecordRegistry["chat-head"][1].versions[3].contract
        .schemaVersion,
    ).toBe(
      persistenceRecordRegistry["chat-shard"][1].versions[3].contract
        .schemaVersion,
    );
  });

  it("latest local epic record captures on-disk-only fields", () => {
    const epicRecordV300 =
      persistenceRecordRegistry.epic[3].versions[0].contract;
    const onDiskEpicKeys = Object.keys(epicRecordV300.schema.shape);

    expect(epicRecordV300.schemaVersion).toEqual({ major: 3, minor: 0 });

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
    expect(
      downgradeRecordAcrossMajors(
        persistenceRecordRegistry.epic,
        3,
        2,
        upgraded,
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
          "Epic contains Reasonix harness state that the 2.0 record contract cannot represent",
      },
    });
  });
});
