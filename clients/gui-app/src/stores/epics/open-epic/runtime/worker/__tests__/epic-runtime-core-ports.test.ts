/**
 * The core ports, and one property that a defect proved is worth its own file.
 *
 * `attachments.read` must SETTLE for a hash the replica does not hold. The
 * runtime's own read waits indefinitely for a hash that has not synced and
 * resolves only when its abort signal fires; across the bridge there is no
 * signal to abort, so an unguarded read holds a call slot open for the life of
 * the worker and the caller's `attachment/read` never answers.
 *
 * That is not hypothetical. It SHIPPED in the first cut of this seam, which
 * called the runtime with a freshly constructed, never-aborted signal and
 * carried a comment explaining why the fresh signal was fine - the comment
 * reasoned about the response being dropped if the caller went away, and never
 * about the promise not settling at all. It was latent only because nothing
 * called `attachment/read` yet.
 *
 * So the pin below is written the way that defect would have failed it: a
 * runtime whose waiting read NEVER resolves, and an assertion that the port
 * answers anyway. A test that used a resolving fake would pass against the
 * defect.
 */
import { describe, expect, it, vi } from "vitest";

import type { EpicRuntimeCorePortSource } from "../epic-runtime-core-ports";
import { buildEpicRuntimeCorePorts } from "../epic-runtime-core-ports";

/** Never resolves. The whole point: a park is observable only against this. */
function neverResolves(): Promise<Uint8Array | null> {
  return new Promise<Uint8Array | null>(() => {});
}

function createSource(
  overrides: Partial<EpicRuntimeCorePortSource>,
): EpicRuntimeCorePortSource {
  return {
    hasAttachmentBytes: () => false,
    readAttachmentBytes: neverResolves,
    acquireBodyLease: () => () => {},
    bodyDocKey: () => null,
    encodeColdState: () => null,
    settleColdState: () => ({ accepted: false }),
    sendBodyUpdate: () => ({ kind: "sent" }),
    renameArtifact: () => false,
    deleteArtifact: () => false,
    reparentArtifact: () => false,
    beginRenameMutation: () => null,
    beginEpicTitleMutation: () => null,
    beginReparentMutation: () => null,
    retirePendingMutation: () => false,
    isLatestRenameStamp: () => false,
    applyChatRecords: () => {},
    applyChatRecordDelta: () => {},
    applyTuiAgentRecords: () => {},
    applyTuiAgentRecordDelta: () => {},
    markChatRecordListAuthoritative: () => {},
    markChatRecordListNotAuthoritative: () => {},
    beginPendingChatCreation: () => {},
    clearPendingChatCreation: () => {},
    republishRecordsForCurrentUser: () => {},
    reprojectForViewerChange: () => {},
    discardUnsyncedEdits: () => {},
    requestFreshSnapshot: () => {},
    retryMigration: () => {},
    retryWriteCommand: () => {},
    discardWriteCommand: () => {},
    enqueueWriteCommand: () => null,
    readWriteCommandIntent: () => null,
    encodeRootState: () => Promise.resolve(new Uint8Array()),
    applyRootUpdate: () => Promise.resolve(false),
    detachTransport: () => {},
    dispose: () => {},
    ...overrides,
  };
}

describe("attachments.read", () => {
  it("settles with null for a hash the replica does not hold", async () => {
    const source = createSource({ hasAttachmentBytes: () => false });
    const ports = buildEpicRuntimeCorePorts(source);

    // `await` is the assertion. Against the parking version this line never
    // returns and the test fails on the suite timeout rather than on a value,
    // which is the honest shape for "it did not answer".
    await expect(ports.attachments.read("missing-hash")).resolves.toBeNull();
  });

  it("does not call the waiting read at all when the hash is not held", async () => {
    // Stronger than the outcome: the guard must short-circuit BEFORE the
    // waiting read, not race it. A version that started the read and then
    // resolved null separately would leak a pending promise per miss.
    const readAttachmentBytes = vi.fn(neverResolves);
    const ports = buildEpicRuntimeCorePorts(
      createSource({ hasAttachmentBytes: () => false, readAttachmentBytes }),
    );

    await expect(ports.attachments.read("missing-hash")).resolves.toBeNull();
    expect(readAttachmentBytes).not.toHaveBeenCalled();
  });

  it("reads through for a hash the replica does hold", async () => {
    // The other direction, so the pin above cannot be satisfied by a port that
    // answers null for everything.
    const bytes = new Uint8Array([1, 2, 3]);
    const ports = buildEpicRuntimeCorePorts(
      createSource({
        hasAttachmentBytes: () => true,
        readAttachmentBytes: () => Promise.resolve(bytes),
      }),
    );

    await expect(ports.attachments.read("present-hash")).resolves.toBe(bytes);
  });
});

describe("the shutdown order", () => {
  it("closes the transport before the durable store", () => {
    // The core calls these in order; this pins that the ports map them onto
    // the runtime's two teardown members the same way round. Disposing before
    // detaching would let a frame arrive for a replica that is going away.
    const order: string[] = [];
    const ports = buildEpicRuntimeCorePorts(
      createSource({
        detachTransport: () => order.push("transport"),
        dispose: () => order.push("durable-store"),
      }),
    );

    ports.transport.close();
    ports.durableStore.close();

    expect(order).toEqual(["transport", "durable-store"]);
  });
});

describe("bodies.materialize", () => {
  it("answers null for an artifact with no doc key, without encoding", () => {
    const encodeColdState = vi.fn(() => null);
    const ports = buildEpicRuntimeCorePorts(
      createSource({ bodyDocKey: () => null, encodeColdState }),
    );

    return Promise.all([
      expect(ports.bodies.materialize("artifact-1")).resolves.toBeNull(),
    ]).then(() => {
      expect(encodeColdState).not.toHaveBeenCalled();
    });
  });

  it("answers null for a doc key the tier cannot encode, never empty bytes", async () => {
    // The conflation this arm exists to prevent: a zero-length update applies
    // cleanly and produces an EMPTY body, so answering `{ update: new
    // Uint8Array() }` here would replace a body with nothing.
    const ports = buildEpicRuntimeCorePorts(
      createSource({ bodyDocKey: () => "doc-1", encodeColdState: () => null }),
    );

    await expect(ports.bodies.materialize("artifact-1")).resolves.toBeNull();
  });
});

describe("bodies.settle", () => {
  it("forwards the docGuid the caller materialized at", async () => {
    // The identity check is the tier's, and it is a DIFFERENT refusal from the
    // generation check: generation is the main thread's lifetime counter, guid
    // is the doc's own identity. Dropping the guid here would let a body
    // replaced underneath a live editor accept a settle from the old one.
    const settleColdState = vi.fn(() => ({
      accepted: true as const,
      settledBytes: 42,
    }));
    const ports = buildEpicRuntimeCorePorts(createSource({ settleColdState }));

    await ports.bodies.settle({
      docKey: "doc-1",
      generation: 3,
      docGuid: "guid-1",
      update: new Uint8Array([9]),
    });

    expect(settleColdState).toHaveBeenCalledWith(
      "doc-1",
      new Uint8Array([9]),
      "guid-1",
    );
  });

  it("reports zero settled bytes on a refusal", async () => {
    const ports = buildEpicRuntimeCorePorts(
      createSource({ settleColdState: () => ({ accepted: false }) }),
    );

    await expect(
      ports.bodies.settle({
        docKey: "doc-1",
        generation: 1,
        docGuid: "guid-1",
        update: new Uint8Array(),
      }),
    ).resolves.toEqual({ accepted: false, settledBytes: 0 });
  });
});

describe("commands.apply", () => {
  it("routes every command kind to its own source member", () => {
    // By name AND by argument, over the WHOLE vocabulary. A dispatch pin that
    // spot-checked three kinds would stay green with two branches swapped,
    // and a swapped branch here is silent: the projection still moves, just
    // from the wrong input.
    const calls: string[] = [];
    const record =
      (member: string) =>
      (...args: unknown[]): void => {
        calls.push(
          `${member}(${args.map((a) => JSON.stringify(a)).join(",")})`,
        );
      };
    const ports = buildEpicRuntimeCorePorts(
      createSource({
        applyChatRecords: record("applyChatRecords"),
        applyChatRecordDelta: record("applyChatRecordDelta"),
        applyTuiAgentRecords: record("applyTuiAgentRecords"),
        applyTuiAgentRecordDelta: record("applyTuiAgentRecordDelta"),
        markChatRecordListAuthoritative: record("markAuthoritative"),
        markChatRecordListNotAuthoritative: record("markNotAuthoritative"),
        beginPendingChatCreation: record("beginPendingChatCreation"),
        clearPendingChatCreation: record("clearPendingChatCreation"),
        republishRecordsForCurrentUser: record("republish"),
        reprojectForViewerChange: record("reproject"),
        discardUnsyncedEdits: record("discardUnsyncedEdits"),
        requestFreshSnapshot: record("requestFreshSnapshot"),
        retryMigration: record("retryMigration"),
        retryWriteCommand: record("retryWriteCommand"),
        discardWriteCommand: record("discardWriteCommand"),
      }),
    );

    ports.commands.apply({
      kind: "apply-chat-records",
      payload: { records: [], issuedAtSeq: 7 },
    });
    ports.commands.apply({
      kind: "mark-chat-records-authoritative",
      payload: {},
    });
    ports.commands.apply({
      kind: "mark-chat-records-not-authoritative",
      payload: {},
    });
    ports.commands.apply({
      kind: "clear-pending-chat-creation",
      payload: { chatId: "chat-1" },
    });
    ports.commands.apply({
      kind: "republish-records-for-current-user",
      payload: {},
    });
    ports.commands.apply({ kind: "reproject-for-viewer-change", payload: {} });
    ports.commands.apply({ kind: "discard-unsynced-edits", payload: {} });
    ports.commands.apply({ kind: "request-fresh-snapshot", payload: {} });
    ports.commands.apply({ kind: "retry-migration", payload: {} });
    ports.commands.apply({
      kind: "retry-write-command",
      payload: { commandId: "cmd-1" },
    });
    ports.commands.apply({
      kind: "discard-write-command",
      payload: { commandId: "cmd-2" },
    });

    expect(calls).toEqual([
      "applyChatRecords([],7)",
      "markAuthoritative()",
      "markNotAuthoritative()",
      'clearPendingChatCreation("chat-1")',
      "republish()",
      "reproject()",
      "discardUnsyncedEdits()",
      "requestFreshSnapshot()",
      "retryMigration()",
      'retryWriteCommand("cmd-1")',
      'discardWriteCommand("cmd-2")',
    ]);
  });

  it("drops a pending-chat-creation whose payload is not one", () => {
    // A pending creation with an invented id would put a row on screen that no
    // create will ever resolve, so a foreign payload is DROPPED rather than
    // defaulted into existence.
    const begun: unknown[] = [];
    const ports = buildEpicRuntimeCorePorts(
      createSource({
        beginPendingChatCreation: (pending) => begun.push(pending),
      }),
    );

    ports.commands.apply({
      kind: "begin-pending-chat-creation",
      payload: { pending: { chatId: "chat-1" } },
    });
    ports.commands.apply({
      kind: "begin-pending-chat-creation",
      payload: { pending: null },
    });

    expect(begun).toEqual([]);
  });

  it("passes a complete pending-chat-creation through", () => {
    // The other direction, so the drop pin above cannot be satisfied by a
    // narrowing that rejects everything.
    const begun: unknown[] = [];
    const ports = buildEpicRuntimeCorePorts(
      createSource({
        beginPendingChatCreation: (pending) => begun.push(pending),
      }),
    );
    const pending = {
      chatId: "chat-1",
      hostId: "host-1",
      parentChatId: null,
      title: "",
      ownerUserId: "user-1",
    };

    ports.commands.apply({
      kind: "begin-pending-chat-creation",
      payload: { pending },
    });

    expect(begun).toEqual([pending]);
  });
});

describe("bodies.materialize — the lease it stands on", () => {
  /** A source whose cold state exists only while a lease is held. */
  function leasedSource(overrides: Partial<EpicRuntimeCorePortSource>): {
    readonly source: EpicRuntimeCorePortSource;
    readonly leases: string[];
    readonly releases: string[];
  } {
    const leases: string[] = [];
    const releases: string[] = [];
    let held = 0;
    const source = createSource({
      acquireBodyLease: (artifactId) => {
        leases.push(artifactId);
        held += 1;
        let released = false;
        return () => {
          if (released) return;
          released = true;
          releases.push(artifactId);
          held -= 1;
        };
      },
      bodyDocKey: (artifactId) => `room-${artifactId}`,
      // The tier's real precondition: `encodeColdState` reads a `replicas`
      // entry, and that entry exists only for a MATERIALIZED room. Modelling
      // it is the whole point - a fixture that always returned bytes would
      // pass against the read-only version that never leased.
      encodeColdState: (docKey) =>
        held > 0
          ? {
              update: new Uint8Array([1]),
              seedMode: "full" as const,
              hostStateVector: null,
              docGuid: `guid-${docKey}`,
            }
          : null,
      ...overrides,
    });
    return { source, leases, releases };
  }

  it("takes the runtime lease before encoding, so the body is held at all", async () => {
    const rig = leasedSource({});
    const ports = buildEpicRuntimeCorePorts(rig.source);

    const materialized = await ports.bodies.materialize("art-1");

    expect(materialized).not.toBeNull();
    expect(rig.leases).toEqual(["art-1"]);
    // Retained: the main thread now holds the doc this lease stands for.
    expect(rig.releases).toEqual([]);
  });

  it("releases immediately when there is nothing to hand over", async () => {
    // No cold state means nothing was materialized for the caller, so no
    // demote will ever come back to release this lease. Holding it would keep
    // the body subscribed for the session.
    const rig = leasedSource({ encodeColdState: () => null });
    const ports = buildEpicRuntimeCorePorts(rig.source);

    await expect(ports.bodies.materialize("art-1")).resolves.toBeNull();

    expect(rig.leases).toEqual(["art-1"]);
    expect(rig.releases).toEqual(["art-1"]);
  });

  it("does not stack leases for a docKey already held", async () => {
    // `bodies.release` decrements a ref-count, and the main side sends ONE
    // demote per doc - so a second retained release is never called and the
    // body stream stays open for the session.
    const rig = leasedSource({});
    const ports = buildEpicRuntimeCorePorts(rig.source);

    await ports.bodies.materialize("art-1");
    await ports.bodies.materialize("art-1");

    expect(rig.leases).toEqual(["art-1", "art-1"]);
    // The second lease came straight back off; the first is still held.
    expect(rig.releases).toEqual(["art-1"]);
  });

  it("releases the lease when a demote is ACCEPTED", async () => {
    const rig = leasedSource({
      settleColdState: () => ({ accepted: true as const, settledBytes: 12 }),
    });
    const ports = buildEpicRuntimeCorePorts(rig.source);
    await ports.bodies.materialize("art-1");

    await ports.bodies.settle({
      docKey: "room-art-1",
      generation: 1,
      docGuid: "guid-room-art-1",
      update: new Uint8Array([2]),
    });

    expect(rig.releases).toEqual(["art-1"]);
  });

  it("KEEPS the lease when a demote is refused", async () => {
    // The asymmetry that matters: a refusal means the main thread keeps its
    // live doc, so the demand and tier lease it stands on are still in use.
    // Releasing here unsubscribes a body the user still has open.
    const rig = leasedSource({
      settleColdState: () => ({ accepted: false as const }),
    });
    const ports = buildEpicRuntimeCorePorts(rig.source);
    await ports.bodies.materialize("art-1");

    await ports.bodies.settle({
      docKey: "room-art-1",
      generation: 1,
      docGuid: "guid-room-art-1",
      update: new Uint8Array([2]),
    });

    expect(rig.releases).toEqual([]);
  });
});
