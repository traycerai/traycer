import { CAPTURED_RESIDUAL_LEVELS } from "@traycer/protocol/persistence/chat-sync/captured-levels";
// Importing the barrel builds every schema reachable from both records, which
// is what populates the registration list below. Without it the guard would
// measure whatever happened to be loaded.
import "@traycer/protocol/persistence/chat-sync/index";
import { listCapturedLevelRegistrations } from "@traycer/protocol/persistence/chat-sync/residual";
import { describe, expect, it } from "vitest";

/**
 * The residual-capture manifest is complete and its ids mean what they say.
 *
 * Residual capture is what makes a newer minor's unmodeled FIELDS survive an
 * older reader. That only holds if every capture site is known, so this guard -
 * not a reviewer - is what makes adding a level to `CAPTURED_RESIDUAL_LEVELS`
 * non-optional.
 *
 * The declared-key table pins the other half: an id is a CONTRACT, and reusing
 * one for a level that means something different would leave a consumer's
 * special case (a clone importer blanks exactly `hostPrivate`) pointed at the
 * wrong data, silently. A restructure fails here instead.
 */

const FROZEN_LEVEL_KEYS: Readonly<Record<string, readonly string[]>> = {
  head: [
    "schemaVersion",
    "parentHeadSha256",
    "throughRecordSeq",
    "capturedAt",
    "minReaderVersion",
    "core",
    "messageShards",
    "events",
    "eventShards",
    "hostPrivate",
    "hostPrivateShard",
  ],
  shard: ["schemaVersion", "chatId", "section", "messages", "events", "hostPrivate"],
  core: [
    "chatId",
    "parentChatId",
    "ownerUserId",
    "originHostId",
    "title",
    "isTitleEditedByUser",
    "createdAt",
    "updatedAt",
    "lifecycle",
    "settings",
  ],
  "core.lifecycle": ["state", "archivedAt", "deletedAt"],
  "core.settings": [
    "harnessId",
    "model",
    "permissionMode",
    "reasoningEffort",
    "serviceTier",
    "agentMode",
    "profileId",
  ],
  hostPrivate: ["revision", "data"],
};

describe("chat-sync captured residual levels", () => {
  it("registers exactly the levels the manifest declares", () => {
    const registered = listCapturedLevelRegistrations().map((level) => level.id);
    const declared = CAPTURED_RESIDUAL_LEVELS.map((level) => level.id);

    // Set equality both ways: a capture site with no manifest entry is a level
    // nothing downstream knows to carry, and a manifest entry with no site is a
    // promise nothing keeps.
    expect([...registered].sort()).toEqual([...declared].sort());
  });

  it("registers each level exactly once", () => {
    // `reprojectResidualCapture` exists so the reader schemas can reuse a level
    // without double-counting it. If a reader schema started registering, this
    // is what would catch it.
    const registered = listCapturedLevelRegistrations().map((level) => level.id);
    expect(registered).toHaveLength(new Set(registered).size);
  });

  it("pins each level id to its declared keys", () => {
    for (const level of listCapturedLevelRegistrations()) {
      const frozen = FROZEN_LEVEL_KEYS[level.id];
      if (frozen === undefined) {
        throw new Error(`Captured level "${level.id}" has no frozen key set`);
      }
      expect([...level.declaredKeys].sort()).toEqual([...frozen].sort());
    }
  });

  it("never declares a modeled field named residual", () => {
    // The name is reserved at every captured level - a modeled `residual` would
    // collide with the bag the encoder merges back.
    for (const level of listCapturedLevelRegistrations()) {
      expect(level.declaredKeys).not.toContain("residual");
    }
  });
});
