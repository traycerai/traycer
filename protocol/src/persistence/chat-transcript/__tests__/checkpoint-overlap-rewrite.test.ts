import { describe, expect, it } from "vitest";
import {
  chatEventSchema,
  type ChatEvent,
} from "@traycer/protocol/persistence/epic/chat-events";
import { turnKeysWithLaterOverlappingChanges } from "@traycer/protocol/persistence/chat-transcript/row-projection";

/**
 * A closing session rewrites a turn's checkpoint: same `turnId`, a NEW
 * `checkpointId`, the earlier entries plus the carried ones. The later-overlap
 * note must weigh each turn's LAST checkpoint only, so a rewritten turn is not
 * flagged by its own rewrite while a genuinely later turn still flags it.
 */

function checkpointEvent(fields: {
  eventId: string;
  turnId: string;
  checkpointId: string;
  entries: readonly {
    filePath: string;
    beforeHash: string;
    afterHash: string;
  }[];
}): ChatEvent {
  return chatEventSchema.parse({
    eventId: fields.eventId,
    type: "checkpoint.captured",
    timestamp: 1_000,
    clientActionId: null,
    actor: null,
    message: null,
    turnId: fields.turnId,
    messageId: null,
    queueItemId: null,
    approvalId: null,
    blockId: null,
    severity: "info",
    metadata: {
      schemaVersion: 1,
      checkpointId: fields.checkpointId,
      capturingUserId: "u-1",
      capturingHostId: "h-1",
      allowedRoots: ["/w"],
      workingDirectory: "/w",
      capturedAt: 1_000,
      entries: fields.entries.map((entry) => ({
        filePath: entry.filePath,
        operation: "edit" as const,
        beforeHash: entry.beforeHash,
        afterHash: entry.afterHash,
        undoable: true,
        reason: null,
        artifact: null,
      })),
    },
  });
}

const P = "/w/p.ts";

describe("turnKeysWithLaterOverlappingChanges over a rewritten checkpoint", () => {
  const original = checkpointEvent({
    eventId: "e-t-first",
    turnId: "t",
    checkpointId: "t",
    entries: [{ filePath: P, beforeHash: "x0", afterHash: "x1" }],
  });
  // The close rewrite: the same turn, a new id, the carried helper edit folded in.
  const rewrite = checkpointEvent({
    eventId: "e-t-rewrite",
    turnId: "t",
    checkpointId: "u",
    entries: [{ filePath: P, beforeHash: "x0", afterHash: "x2" }],
  });

  it("does not contain the turn whose own checkpoint was rewritten", () => {
    expect(turnKeysWithLaterOverlappingChanges([original, rewrite])).toEqual(
      new Set(),
    );
  });

  it("still flags an earlier turn that a genuinely later turn overlaps", () => {
    const later = checkpointEvent({
      eventId: "e-t2",
      turnId: "t2",
      checkpointId: "t2",
      entries: [{ filePath: P, beforeHash: "x2", afterHash: "x3" }],
    });
    expect(
      turnKeysWithLaterOverlappingChanges([original, rewrite, later]),
    ).toEqual(new Set(["t"]));
  });

  it("does not judge a turn on the checkpoint an UNREADABLE rewrite replaced", () => {
    // The selection reads RAW events and the parse comes after it, so a
    // rewrite this reader cannot parse still supersedes its predecessor and
    // the turn then contributes no manifest at all.
    //
    // Parsing first would drop the rewrite before it could supersede anything
    // and leave t2 judged on entries the writer has already replaced - here
    // that would flag t1, for an overlap stated by a manifest that is no
    // longer t2's. It also has to be the answer `restoreCumulative` gives:
    // `earliestEntriesByPath` skips an unparseable manifest too, so a warning
    // derived from the superseded one would describe a restore that will not
    // happen.
    const t1 = checkpointEvent({
      eventId: "e-t1",
      turnId: "t1",
      checkpointId: "t1",
      entries: [{ filePath: P, beforeHash: "x0", afterHash: "x1" }],
    });
    const t2First = checkpointEvent({
      eventId: "e-t2-first",
      turnId: "t2",
      checkpointId: "t2",
      entries: [{ filePath: P, beforeHash: "x1", afterHash: "x2" }],
    });
    const t2Unreadable = chatEventSchema.parse({
      ...t2First,
      eventId: "e-t2-rewrite",
      metadata: { ...t2First.metadata, schemaVersion: 2 },
    });
    // Its predecessor alone would flag t1; the pair must not.
    expect(turnKeysWithLaterOverlappingChanges([t1, t2First])).toEqual(
      new Set(["t1"]),
    );
    expect(
      turnKeysWithLaterOverlappingChanges([t1, t2First, t2Unreadable]),
    ).toEqual(new Set());
  });

  it("does not flag an earlier turn by a later turn's SUPERSEDED checkpoint", () => {
    // t2 first touched P for real; its rewrite settles the path as a net
    // no-op. Only t2's last checkpoint counts, and a no-op drives no note.
    const t1 = checkpointEvent({
      eventId: "e-t1",
      turnId: "t1",
      checkpointId: "t1",
      entries: [{ filePath: P, beforeHash: "x0", afterHash: "x1" }],
    });
    const t2First = checkpointEvent({
      eventId: "e-t2-first",
      turnId: "t2",
      checkpointId: "t2",
      entries: [{ filePath: P, beforeHash: "x1", afterHash: "x2" }],
    });
    const t2Rewrite = checkpointEvent({
      eventId: "e-t2-rewrite",
      turnId: "t2",
      checkpointId: "t2-rewrite",
      entries: [{ filePath: P, beforeHash: "x2", afterHash: "x2" }],
    });
    expect(
      turnKeysWithLaterOverlappingChanges([t1, t2First, t2Rewrite]),
    ).toEqual(new Set());
  });
});
