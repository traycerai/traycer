import { describe, expect, it } from "vitest";
import {
  checkpointEventTurnKey,
  latestCheckpointPerTurn,
} from "@traycer/protocol/persistence/epic/checkpoint-manifests";

/**
 * The one selection every checkpoint reader shares: a turn's LAST checkpoint,
 * in the order the turns first wrote one. A closing session rewrites a turn's
 * checkpoint under a new id, and the rewrite supersedes the original.
 */
describe("latestCheckpointPerTurn", () => {
  interface Checkpoint {
    readonly turn: string;
    readonly id: string;
  }

  it("keeps the last checkpoint per key, at the position of the first", () => {
    const checkpoints: readonly Checkpoint[] = [
      { turn: "t1", id: "t1-first" },
      { turn: "t2", id: "t2-only" },
      { turn: "t1", id: "t1-rewrite" },
      { turn: "t3", id: "t3-first" },
      { turn: "t3", id: "t3-rewrite" },
    ];
    expect(
      latestCheckpointPerTurn(checkpoints, (checkpoint) => checkpoint.turn),
    ).toEqual([
      // t1 holds the position of its first checkpoint and the content of its last.
      { turn: "t1", id: "t1-rewrite" },
      { turn: "t2", id: "t2-only" },
      { turn: "t3", id: "t3-rewrite" },
    ]);
  });

  it("honours the key function it is given", () => {
    const checkpoints: readonly Checkpoint[] = [
      { turn: "t1", id: "a" },
      { turn: "t2", id: "a" },
      { turn: "t3", id: "b" },
    ];
    // Keyed by `id`, the first two collapse; keyed by `turn`, nothing does.
    expect(
      latestCheckpointPerTurn(checkpoints, (checkpoint) => checkpoint.id),
    ).toEqual([
      { turn: "t2", id: "a" },
      { turn: "t3", id: "b" },
    ]);
    expect(
      latestCheckpointPerTurn(checkpoints, (checkpoint) => checkpoint.turn),
    ).toEqual(checkpoints);
  });

  it("returns an empty list for no checkpoints", () => {
    expect(
      latestCheckpointPerTurn<Checkpoint>([], (checkpoint) => checkpoint.turn),
    ).toEqual([]);
  });
});

describe("checkpointEventTurnKey", () => {
  it("keys an event by its turn id", () => {
    expect(checkpointEventTurnKey({ turnId: "t-1", eventId: "e-1" })).toBe(
      "t-1",
    );
  });

  it("keys an event with no turn id by the event id, so it supersedes nothing", () => {
    const first = checkpointEventTurnKey({ turnId: null, eventId: "e-1" });
    const second = checkpointEventTurnKey({ turnId: null, eventId: "e-2" });
    expect(first).not.toBe(second);
    expect(
      latestCheckpointPerTurn(
        [
          { turnId: null, eventId: "e-1" },
          { turnId: null, eventId: "e-2" },
        ],
        checkpointEventTurnKey,
      ),
    ).toHaveLength(2);
  });

  it("cannot collide an event-id key with a real turn id", () => {
    expect(checkpointEventTurnKey({ turnId: null, eventId: "t-1" })).not.toBe(
      checkpointEventTurnKey({ turnId: "t-1", eventId: "e-9" }),
    );
  });
});
