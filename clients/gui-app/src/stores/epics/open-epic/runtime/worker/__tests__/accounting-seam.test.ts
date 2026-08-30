/**
 * The accounting seam, end to end across the two halves.
 *
 * The worker's port pushes; main's bridge turns the pushes back into calls on
 * the real books. Driving BOTH together is the point - each half in isolation
 * can be right while the pair disagrees about which push means which call, and
 * a settle routed to the wrong member is silent: the plane still moves, just
 * by the wrong amount against the wrong holder.
 *
 * The events are passed by hand rather than over a bridge because what is under
 * test is the mapping, not the transport. `worker-boot-probe.test.ts` is what
 * proves these frames survive a real `postMessage`.
 */
import { describe, expect, it } from "vitest";

import type { EvictionOutcome } from "@traycer-clients/shared/replica-runtime/memory-accountant";
import type { WorkerToMainEvent } from "@traycer-clients/shared/replica-runtime/worker/bridge-protocol";
import { createRecordingAccountingPort } from "@/stores/epics/open-epic/test-support/accounting-port-fixture";
import type { EpicRuntimeAccountingSource } from "../../epic-runtime-accounting-port";
import { createMainAccountingBridge } from "../main-accounting-bridge";
import { createWorkerAccountingPort } from "../worker-accounting-port";

const COUNTS = {
  artifacts: 3,
  chats: 2,
  tuiAgents: 1,
  deletedArtifacts: 0,
  roleClaims: 4,
  treeNodes: 7,
};

const PINNED: EvictionOutcome = {
  reclaimedBytes: 0,
  protectedBytesByKind: [{ kind: "visible", bytes: 4096 }],
};

function createSource(
  overrides: Partial<EpicRuntimeAccountingSource>,
): EpicRuntimeAccountingSource {
  return {
    materializedRoomIds: () => ["room-a"],
    measureRootBytes: () => 1024,
    projectionCounts: () => COUNTS,
    demoteColdestUnpinned: () => PINNED,
    ...overrides,
  };
}

/** Both halves, wired to each other exactly as the bridge wires them. */
function createSeam() {
  const books = createRecordingAccountingPort();
  const demoteRequests: number[] = [];
  const main = createMainAccountingBridge({
    port: books.port,
    dispatchDemote: (overBytes) => demoteRequests.push(overBytes),
  });
  const worker = createWorkerAccountingPort((event: WorkerToMainEvent) => {
    main.handle(event);
  });
  return { books, main, worker, demoteRequests };
}

describe("the accounting seam", () => {
  it("routes each of the six reporting members to its own book call", () => {
    const seam = createSeam();
    seam.worker.port.registerBooks(createSource({}));

    seam.worker.port.settleRootBytes(10);
    seam.worker.port.settleColdRoomBytes("room-a", 20);
    seam.worker.port.settleCommandOverlayBytes(30);
    seam.worker.port.settleHotDocBytes("room-b", 40);
    seam.worker.port.chargeHotDocProvisional("room-c", 50);
    seam.worker.port.releaseHotDoc("room-d");

    // By name AND by argument. A mapping pin that only counted calls would
    // stay green with two arms swapped, which is the defect it exists for.
    expect(seam.books.calls).toEqual([
      { member: "registerBooks", artifactRoomId: null, bytes: null },
      { member: "settleRootBytes", artifactRoomId: null, bytes: 10 },
      { member: "settleColdRoomBytes", artifactRoomId: "room-a", bytes: 20 },
      { member: "settleCommandOverlayBytes", artifactRoomId: null, bytes: 30 },
      { member: "settleHotDocBytes", artifactRoomId: "room-b", bytes: 40 },
      {
        member: "chargeHotDocProvisional",
        artifactRoomId: "room-c",
        bytes: 50,
      },
      { member: "releaseHotDoc", artifactRoomId: "room-d", bytes: null },
    ]);
  });

  it("answers the accountant's synchronous reads from the pushed snapshot", () => {
    const seam = createSeam();
    seam.worker.port.registerBooks(createSource({}));

    const source = seam.books.source();
    expect(source).not.toBeNull();
    if (source === null) return;

    // These are the reads a reconcile makes, on main, while the runtime that
    // knows the answers is on another thread.
    expect(source.materializedRoomIds()).toEqual(["room-a"]);
    expect(source.measureRootBytes()).toBe(1024);
    expect(source.projectionCounts()).toEqual(COUNTS);
  });

  it("refreshes the cache on every settlement", () => {
    let rooms: readonly string[] = ["room-a"];
    let rootBytes = 1024;
    const seam = createSeam();
    seam.worker.port.registerBooks(
      createSource({
        materializedRoomIds: () => rooms,
        measureRootBytes: () => rootBytes,
      }),
    );
    const source = seam.books.source();
    if (source === null) throw new Error("books were not registered");

    rooms = ["room-a", "room-b"];
    rootBytes = 2048;
    // Nothing has been pushed yet, so main still holds the registration
    // snapshot. This half of the assertion is what makes the other half mean
    // something.
    expect(source.materializedRoomIds()).toEqual(["room-a"]);

    seam.worker.port.settleRootBytes(2048);

    expect(source.materializedRoomIds()).toEqual(["room-a", "room-b"]);
    expect(source.measureRootBytes()).toBe(2048);
  });

  it("has the new snapshot in place before the settle can drive a reconcile", () => {
    // The ordering claim, pinned where it is actually observable. A settle
    // reconciles its plane, and a reconcile reads the source SYNCHRONOUSLY -
    // so the read happens DURING the book call, not after it. Asserting the
    // cache after the call returns cannot tell the two orderings apart, which
    // is what an earlier version of this suite did.
    let rooms: readonly string[] = ["room-a"];
    const observed: string[][] = [];
    const books = createRecordingAccountingPort();
    const main = createMainAccountingBridge({
      port: {
        ...books.port,
        settleRootBytes(bytes): void {
          // Standing in for the reconcile the real books run here.
          const source = books.source();
          if (source !== null) observed.push([...source.materializedRoomIds()]);
          books.port.settleRootBytes(bytes);
        },
      },
      dispatchDemote: () => {},
    });
    const worker = createWorkerAccountingPort((event: WorkerToMainEvent) => {
      main.handle(event);
    });
    worker.port.registerBooks(
      createSource({ materializedRoomIds: () => rooms }),
    );

    rooms = ["room-a", "room-b"];
    worker.port.settleRootBytes(2048);

    expect(observed).toEqual([["room-a", "room-b"]]);
  });

  it("defers an eviction and reports what the tier last refused to free", () => {
    const seam = createSeam();
    const demoted: number[] = [];
    seam.worker.port.registerBooks(
      createSource({
        demoteColdestUnpinned: (overBytes): EvictionOutcome => {
          demoted.push(overBytes);
          return PINNED;
        },
      }),
    );
    const source = seam.books.source();
    if (source === null) throw new Error("books were not registered");

    // First reconcile: nothing is known about what is pinned yet, so the
    // breakdown is empty and the request is dispatched.
    const first = source.demoteColdestUnpinned(8192);
    expect(first).toEqual({ reclaimedBytes: 0, protectedBytesByKind: [] });
    expect(seam.demoteRequests).toEqual([8192]);
    // Nothing ran in the worker yet - the dispatch is one-way.
    expect(demoted).toEqual([]);

    // The worker serves it, learns the tier is entirely pinned, and the next
    // settlement carries that breakdown back.
    seam.worker.demote(8192);
    expect(demoted).toEqual([8192]);
    seam.worker.port.settleRootBytes(1024);

    // Second reconcile: still zero reclaimed HERE, but now with the reason.
    // "Everything is pinned" and "there was nothing to free" are the same
    // number and different facts, and this is the only thing that separates
    // them.
    const second = source.demoteColdestUnpinned(8192);
    expect(second).toEqual({
      reclaimedBytes: 0,
      protectedBytesByKind: [{ kind: "visible", bytes: 4096 }],
    });
  });

  it("does not serve a demote before registration or after teardown", () => {
    const seam = createSeam();
    const demoted: number[] = [];
    const source = createSource({
      demoteColdestUnpinned: (overBytes): EvictionOutcome => {
        demoted.push(overBytes);
        return PINNED;
      },
    });

    seam.worker.demote(4096);
    expect(demoted).toEqual([]);

    seam.worker.port.registerBooks(source);
    seam.worker.demote(4096);
    expect(demoted).toEqual([4096]);

    seam.worker.port.unregisterBooks();
    seam.worker.demote(4096);
    // A reconcile already in flight when the runtime tore down reaches a
    // source mid-disposal otherwise.
    expect(demoted).toEqual([4096]);
  });

  it("releases the books when the worker deregisters", () => {
    const seam = createSeam();
    seam.worker.port.registerBooks(createSource({}));
    seam.worker.port.unregisterBooks();

    expect(seam.books.calls.map((call) => call.member)).toEqual([
      "registerBooks",
      "unregisterBooks",
    ]);
    expect(seam.books.source()).toBeNull();
  });

  it("releases the books when main disposes a worker that said nothing", () => {
    // The leak this prevents: a worker that died - crashed, or was terminated
    // - never sends `accounting/books registered: false`, so without this the
    // process planes keep a dead runtime attached, answering from a frozen
    // cache and dispatching demote requests into a bridge nobody is on.
    const seam = createSeam();
    seam.worker.port.registerBooks(createSource({}));

    seam.main.dispose();

    expect(seam.books.calls.map((call) => call.member)).toEqual([
      "registerBooks",
      "unregisterBooks",
    ]);
  });

  it("does not deregister twice", () => {
    const seam = createSeam();
    seam.worker.port.registerBooks(createSource({}));

    seam.worker.port.unregisterBooks();
    seam.main.dispose();

    // `dispose()` runs on the same teardown as a fatal, and a second
    // `unregisterBooks` would `release` a book key that may already have been
    // re-registered by the incoming runtime in a merge window.
    expect(
      seam.books.calls.filter((call) => call.member === "unregisterBooks"),
    ).toHaveLength(1);
  });
});
