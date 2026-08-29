/**
 * Pins the invariants documented on `projection-delivery.ts`:
 *
 * - `createBatchingDelivery`: re-entrant batching commits once per outermost
 *   window, an empty window commits nothing, overlapping keys published
 *   within one window merge with later-wins (`Object.assign` semantics), a
 *   throwing batch body still commits whatever was published before the
 *   throw, and a commit that itself republishes synchronously is not
 *   dropped (pending is cleared BEFORE `commit` runs).
 * - `projectedSlicesView`: `publish` folds the narrow slice over the wide
 *   sink's CURRENT value (via `sink.read()`), including a value the sink
 *   mutated inside an open `transact`, never a value captured before entry.
 */
import { describe, expect, it } from "vitest";
import type { ProjectionSink } from "@traycer-clients/shared/replica-runtime";
import {
  createBatchingDelivery,
  projectedSlicesView,
} from "@/stores/epics/open-epic/runtime/projection-delivery";
import type { EpicRuntimeProjection } from "@/stores/epics/open-epic/runtime/epic-runtime-projection";
import { EMPTY_RECORDS_PROJECTION } from "@/stores/epics/open-epic/runtime/epic-runtime-projection";
import type {
  ChatsSlice,
  EpicProjectedSlices,
} from "@/stores/epics/open-epic/types";
import { EMPTY_PROJECTED_SLICES } from "@/stores/epics/open-epic/types";
import type { EpicRecordsProjection } from "@/stores/epics/open-epic/runtime/epic-runtime-projection";

describe("createBatchingDelivery", () => {
  it("commits exactly once for a nested batch, and only after the outer body returns", () => {
    const commits: Partial<EpicRuntimeProjection>[] = [];
    const order: string[] = [];
    const delivery = createBatchingDelivery(
      (patch: Partial<EpicRuntimeProjection>) => {
        order.push("commit");
        commits.push(patch);
      },
    );

    delivery.batch(() => {
      delivery.publish({ isDirty: true });
      delivery.batch(() => {
        delivery.publish({ unsyncedQueueSize: 5 });
        order.push("inner-batch-body-ran");
      });
      order.push("after-inner-batch-returned");
      expect(order).not.toContain("commit");
      delivery.publish({ bindingEpoch: 2 });
    });

    expect(commits).toHaveLength(1);
    expect(order).toEqual([
      "inner-batch-body-ran",
      "after-inner-batch-returned",
      "commit",
    ]);
    expect(commits[0]).toEqual({
      isDirty: true,
      unsyncedQueueSize: 5,
      bindingEpoch: 2,
    });
  });

  it("commits nothing when a batch window publishes nothing", () => {
    let commitCount = 0;
    const delivery = createBatchingDelivery(() => {
      commitCount += 1;
    });

    delivery.batch(() => {
      // Intentionally empty: no publish inside this window.
    });

    expect(commitCount).toBe(0);
  });

  it("merges same-window publishes with later-wins semantics for overlapping keys", () => {
    const commits: Partial<EpicRuntimeProjection>[] = [];
    const delivery = createBatchingDelivery(
      (patch: Partial<EpicRuntimeProjection>) => {
        commits.push(patch);
      },
    );

    delivery.batch(() => {
      delivery.publish({ isDirty: true, unsyncedQueueSize: 1 });
      delivery.publish({ isDirty: false });
    });

    expect(commits).toHaveLength(1);
    expect(commits[0]).toEqual({ isDirty: false, unsyncedQueueSize: 1 });
  });

  it("still commits whatever was published before a throw, and lets the throw propagate", () => {
    const commits: Partial<EpicRuntimeProjection>[] = [];
    const delivery = createBatchingDelivery(
      (patch: Partial<EpicRuntimeProjection>) => {
        commits.push(patch);
      },
    );

    expect(() => {
      delivery.batch(() => {
        delivery.publish({ isDirty: true });
        throw new Error("body blew up");
      });
    }).toThrow("body blew up");

    expect(commits).toHaveLength(1);
    expect(commits[0]).toEqual({ isDirty: true });
  });

  it("does not drop a publish issued synchronously from inside commit", () => {
    const commits: Partial<EpicRuntimeProjection>[] = [];
    let republished = false;
    const delivery = createBatchingDelivery(
      (patch: Partial<EpicRuntimeProjection>) => {
        commits.push(patch);
        // Simulate the auth-bridge republish: a subscriber woken by this
        // commit publishes again, synchronously, from within the callback.
        if (!republished) {
          republished = true;
          delivery.publish({ bindingEpoch: 99 });
        }
      },
    );

    delivery.batch(() => {
      delivery.publish({ isDirty: true });
    });

    expect(commits).toHaveLength(2);
    expect(commits[0]).toEqual({ isDirty: true });
    expect(commits[1]).toEqual({ bindingEpoch: 99 });
  });
});

describe("projectedSlicesView", () => {
  function makeChatsSlice(id: string): ChatsSlice {
    return {
      byId: {
        [id]: {
          id,
          parentId: null,
          title: id,
          createdAt: 0,
          updatedAt: 0,
          userId: null,
          archivedAt: null,
        },
      },
      allIds: [id],
    };
  }

  function makeFakeRecordsSink(initial: EpicRecordsProjection): {
    sink: ProjectionSink<EpicRecordsProjection>;
    read: () => EpicRecordsProjection;
    mutateBeforeNextTransactBody: (
      mutate: (current: EpicRecordsProjection) => EpicRecordsProjection,
    ) => void;
  } {
    let state = initial;
    let onTransactEnter:
      | ((current: EpicRecordsProjection) => EpicRecordsProjection)
      | null = null;

    const sink: ProjectionSink<EpicRecordsProjection> = {
      read(): EpicRecordsProjection {
        return state;
      },
      publish(next: EpicRecordsProjection): void {
        state = next;
      },
      transact(body: () => void): void {
        if (onTransactEnter !== null) {
          state = onTransactEnter(state);
          onTransactEnter = null;
        }
        body();
      },
      revision(): number {
        return 0;
      },
    };

    return {
      sink,
      read: () => state,
      mutateBeforeNextTransactBody: (mutate) => {
        onTransactEnter = mutate;
      },
    };
  }

  it("folds the published slice over the wide sink's current value, preserving records-only fields", () => {
    const seeded: EpicRecordsProjection = {
      ...EMPTY_RECORDS_PROJECTION,
      chatRecords: makeChatsSlice("seeded-record-only-chat"),
    };
    const { sink, read } = makeFakeRecordsSink(seeded);
    const view = projectedSlicesView(sink);

    const nextSlices: EpicProjectedSlices = {
      ...EMPTY_PROJECTED_SLICES,
      epic: { title: "Renamed", updatedAt: 42 },
    };
    view.publish(nextSlices);

    const result = read();
    expect(result.epic).toEqual({ title: "Renamed", updatedAt: 42 });
    // The records-only field the narrow slice never touched must survive
    // the fold, proving `publish` merged over the sink's current value
    // rather than overwriting it wholesale.
    expect(result.chatRecords).toEqual(
      makeChatsSlice("seeded-record-only-chat"),
    );
  });

  it("reads the sink's CURRENT value at publish time, including one mutated inside an open transact", () => {
    const { sink, read, mutateBeforeNextTransactBody } = makeFakeRecordsSink(
      EMPTY_RECORDS_PROJECTION,
    );
    const view = projectedSlicesView(sink);

    // The fake sink's `transact` mutates its own read-back value BEFORE
    // running `body`, standing in for a value "buffered inside an open
    // transaction" per the sink's contract. If `publish` folded over a
    // snapshot captured before `transact` was entered, this mutation would
    // be silently discarded.
    const mutatedChatRecords = makeChatsSlice(
      "mutated-during-open-transaction",
    );
    mutateBeforeNextTransactBody((current) => ({
      ...current,
      chatRecords: mutatedChatRecords,
    }));

    view.transact(() => {
      view.publish({
        ...EMPTY_PROJECTED_SLICES,
        epic: { title: "Inside transaction", updatedAt: 7 },
      });
    });

    const result = read();
    expect(result.epic).toEqual({ title: "Inside transaction", updatedAt: 7 });
    expect(result.chatRecords).toEqual(mutatedChatRecords);
  });

  it("read() and transact() delegate straight through to the wide sink", () => {
    let transactCalls = 0;
    const sink: ProjectionSink<EpicRecordsProjection> = {
      read(): EpicRecordsProjection {
        return EMPTY_RECORDS_PROJECTION;
      },
      publish(): void {
        // Not exercised in this test.
      },
      transact(body: () => void): void {
        transactCalls += 1;
        body();
      },
      revision(): number {
        return 3;
      },
    };
    const view = projectedSlicesView(sink);

    expect(view.read()).toBe(EMPTY_RECORDS_PROJECTION);
    expect(view.revision()).toBe(3);
    let ran = false;
    view.transact(() => {
      ran = true;
    });
    expect(ran).toBe(true);
    expect(transactCalls).toBe(1);
  });
});
