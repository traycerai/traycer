/**
 * The merge window, which is the only moment the runtime token earns its keep.
 *
 * Two runtimes for the same `(hostId, epicId)` are alive at once whenever a
 * session is replaced: the old handle is not disposed until the new one has
 * taken over (owed #1/#2). Every holder id and the book key itself are
 * composed from `hostId + epicId + runtimeToken`, so the token is the ONLY
 * thing distinguishing their books.
 *
 * This is what the 4e ruling nearly broke. "The worker mints its own token"
 * gives each thread an independent sequence, both mint `"1"`, both books
 * register under an identical `bookKey`, the second `attach` overwrites the
 * first, and then the OLD runtime's teardown deregisters the NEW runtime's
 * books — a live session silently unaccounted for the rest of its life.
 *
 * The pin is deliberately behavioural rather than an assertion about token
 * strings: it asserts that A's teardown leaves B's books attached, which is
 * the property, not the mechanism.
 */
import { describe, expect, it } from "vitest";
import type { RuntimeEnvironment } from "@traycer-clients/shared/replica-runtime";
import { ensureProcessMemoryRuntime } from "@/stores/replica-memory/process-memory-accountant";
import { createProcessBackedAccountingPort } from "../process-backed-accounting-port";
import type { EpicRuntimeAccountingSource } from "../epic-runtime-accounting-port";

function environmentStub(): RuntimeEnvironment {
  return {
    clock: { now: () => 0 },
    scheduler: {
      schedule() {
        return { cancel(): void {} };
      },
      scheduleMicrotask(): void {},
    },
    logger: { debug: () => {}, warn: () => {}, error: () => {} },
  };
}

function sourceWithRooms(
  roomIds: readonly string[],
): EpicRuntimeAccountingSource {
  return {
    materializedRoomIds: () => roomIds,
    demoteColdestUnpinned: () => ({
      reclaimedBytes: 0,
      deferredBytes: 0,
      protectedBytesByKind: [],
    }),
    measureRootBytes: () => 0,
    projectionCounts: () => ({
      artifacts: 0,
      chats: 0,
      tuiAgents: 0,
      deletedArtifacts: 0,
      roleClaims: 0,
      treeNodes: 0,
    }),
  };
}

describe("two ports for the same (hostId, epicId)", () => {
  it("keep separate books, so the outgoing runtime's teardown does not deregister the incoming one", () => {
    const environment = environmentStub();
    // Counted as a DELTA against whatever else this process has attached: the
    // accountant is a module-scoped singleton by design, so an absolute
    // expectation here would depend on suite order.
    const memory = ensureProcessMemoryRuntime(environment);
    const baseline = memory.hotDocs.docsResident();

    const outgoing = createProcessBackedAccountingPort({
      hostId: "host-1",
      epicId: "epic-1",
      environment,
    });
    const incoming = createProcessBackedAccountingPort({
      hostId: "host-1",
      epicId: "epic-1",
      environment,
    });

    outgoing.registerBooks(sourceWithRooms(["room-a"]));
    incoming.registerBooks(sourceWithRooms(["room-b", "room-c"]));
    expect(memory.hotDocs.docsResident()).toBe(baseline + 3);

    // The merge window closing: the OLD handle disposes after the new one is
    // already serving.
    outgoing.unregisterBooks();

    // Two, not zero. Zero is what a shared token produces, and it is invisible
    // to every behavioural test in the suite because the session keeps working
    // perfectly - it is simply no longer accounted for.
    expect(memory.hotDocs.docsResident()).toBe(baseline + 2);

    incoming.unregisterBooks();
    expect(memory.hotDocs.docsResident()).toBe(baseline);
  });
});
