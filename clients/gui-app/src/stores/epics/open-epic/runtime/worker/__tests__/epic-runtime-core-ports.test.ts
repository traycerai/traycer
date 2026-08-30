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
import type { EpicRuntimeCorePorts } from "../epic-runtime-core";

/**
 * Ports with a no-op return leg.
 *
 * The leg carries a resident body's traffic back to main; nothing in this
 * file asserts on it, and threading two empty callbacks through eighteen call
 * sites would bury the argument that each test is actually about. A suite
 * that DOES care about the leg passes its own.
 */
function buildPorts(source: EpicRuntimeCorePortSource): EpicRuntimeCorePorts {
  return buildEpicRuntimeCorePorts(source, {
    onDocUpdate: () => {},
    onAwareness: () => {},
  });
}

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
    encodeForwardOnly: () => null,
    observeBodyDoc: () => () => {},
    applyBodyAwareness: () => {},
    observeBodyAwareness: () => () => {},
    isBodyPinned: () => false,
    encodeBodyPeerAwareness: () => [],
    settleColdState: () => ({ accepted: false, reason: "not-held" as const }),
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
    const ports = buildPorts(source);

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
    const ports = buildPorts(
      createSource({ hasAttachmentBytes: () => false, readAttachmentBytes }),
    );

    await expect(ports.attachments.read("missing-hash")).resolves.toBeNull();
    expect(readAttachmentBytes).not.toHaveBeenCalled();
  });

  it("reads through for a hash the replica does hold", async () => {
    // The other direction, so the pin above cannot be satisfied by a port that
    // answers null for everything.
    const bytes = new Uint8Array([1, 2, 3]);
    const ports = buildPorts(
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
    const ports = buildPorts(
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
    const ports = buildPorts(
      createSource({ bodyDocKey: () => null, encodeColdState }),
    );

    return Promise.all([
      expect(ports.bodies.materialize("artifact-1")).resolves.toBeNull(),
    ]).then(() => {
      expect(encodeColdState).not.toHaveBeenCalled();
    });
  });

  it("answers AWAITING for a doc key the tier cannot encode yet, never empty bytes", async () => {
    // The conflation this arm exists to prevent: a zero-length update applies
    // cleanly and produces an EMPTY body, so answering `{ update: new
    // Uint8Array() }` here would replace a body with nothing. That property is
    // unchanged - the answer states NO bytes.
    //
    // What changed is which no-bytes answer it is. A doc key EXISTS for this
    // artifact and the tier simply has nothing for it yet, which on the lane
    // arm is every cold open: the lease taken above is the `artifact.subscribe`
    // open, so the bytes are on their way precisely because the demand is held.
    // Answering `null` here (which this did) made main read `unavailable`, drop
    // its release, and close the subscription that was about to deliver them.
    const ports = buildPorts(
      createSource({ bodyDocKey: () => "doc-1", encodeColdState: () => null }),
    );

    await expect(ports.bodies.materialize("artifact-1")).resolves.toMatchObject(
      { docKey: "doc-1", update: null },
    );
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
    const ports = buildPorts(createSource({ settleColdState }));

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

  it("reports settledBytes from what the TIER stored, not from the input", async () => {
    // RE-HOMED from `in-process-runtime-port.test.ts`, which is retired: that
    // suite pinned this on a port with no production caller, and the property
    // belongs to whichever port actually serves a demote. The distinction is
    // not cosmetic - the accountant's `settleCold` figure comes from this
    // number, so reporting the input's length would charge the books for bytes
    // the tier may have merged rather than stored.
    const ports = buildPorts(
      createSource({
        settleColdState: () => ({ accepted: true as const, settledBytes: 512 }),
      }),
    );

    await expect(
      ports.bodies.settle({
        docKey: "doc-1",
        generation: 1,
        docGuid: "guid-1",
        // Deliberately a DIFFERENT length from the answer above, so a port
        // reporting `update.byteLength` fails rather than coincides.
        update: new Uint8Array([1, 2, 3]),
      }),
    ).resolves.toEqual({ accepted: true, settledBytes: 512, reason: null });
  });

  it("reports zero settled bytes on a refusal", async () => {
    const ports = buildPorts(
      createSource({
        settleColdState: () => ({
          accepted: false,
          reason: "not-held" as const,
        }),
      }),
    );

    await expect(
      ports.bodies.settle({
        docKey: "doc-1",
        generation: 1,
        docGuid: "guid-1",
        update: new Uint8Array(),
      }),
    ).resolves.toEqual({
      accepted: false,
      settledBytes: 0,
      reason: "not-held",
    });
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
    const ports = buildPorts(
      createSource({
        applyChatRecords: record("applyChatRecords"),
        detachTransport: record("detachTransport"),
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
    ports.commands.apply({ kind: "detach-transport", payload: {} });

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
      "detachTransport()",
    ]);
  });

  it("drops a pending-chat-creation whose payload is not one", () => {
    // A pending creation with an invented id would put a row on screen that no
    // create will ever resolve, so a foreign payload is DROPPED rather than
    // defaulted into existence.
    const begun: unknown[] = [];
    const ports = buildPorts(
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
    const ports = buildPorts(
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
    const ports = buildPorts(rig.source);

    const materialized = await ports.bodies.materialize("art-1");

    expect(materialized).not.toBeNull();
    expect(rig.leases).toEqual(["art-1"]);
    // Retained: the main thread now holds the doc this lease stands for.
    expect(rig.releases).toEqual([]);
    // RE-HOMED from `in-process-runtime-port.test.ts`, which is retired: the
    // granted answer carries the tier's OWN seed mode and watermark rather
    // than defaults minted here. `seedMode` decides merge-vs-replace on main
    // and `hostStateVector` is what a later reattach offers, so a port that
    // substituted its own values for either would be silently lossy on the
    // resume path.
    expect(materialized?.seedMode).toBe("full");
    expect(materialized?.hostStateVector).toBeNull();
    expect(materialized?.docGuid).toBe("guid-room-art-1");
  });

  it("RETAINS the demand when there is nothing to hand over yet", async () => {
    // This pin used to assert the opposite, with the reasoning "no demote will
    // ever come back to release this lease, and holding it would keep the body
    // subscribed for the session". Both halves were right about `@1`, where a
    // room arrives whether or not anything is looking, and exactly backwards
    // about the lane arm - where the lease IS the subscribe, so releasing here
    // closes the subscription that would have produced the bytes, and nothing
    // ever asks again because the tile's effect keys on a docKey that does not
    // move. Every artifact body on that arm was unreachable.
    //
    // The demand is held instead, and main is told so (`update: null` with a
    // stated `docKey`), so it keeps a release to post and re-materializes when
    // the projection says the room is ready.
    const rig = leasedSource({ encodeColdState: () => null });
    const ports = buildPorts(rig.source);

    await expect(ports.bodies.materialize("art-1")).resolves.toMatchObject({
      // `leasedSource` keys bodies by ROOM, so this also pins that the awaiting
      // answer names the doc key rather than echoing the artifact id.
      docKey: "room-art-1",
      update: null,
    });

    expect(rig.leases).toEqual(["art-1"]);
    expect(rig.releases).toEqual([]);
  });

  it("does not stack demand when an awaiting body is materialized again", async () => {
    // The retry calls `body/materialize` a second time while the first demand
    // is still retained. `bodies.release` decrements a REF-COUNT, so a second
    // retained release would raise it with nothing left to lower it - the
    // subscription would outlive every holder.
    const rig = leasedSource({ encodeColdState: () => null });
    const ports = buildPorts(rig.source);

    await ports.bodies.materialize("art-1");
    await ports.bodies.materialize("art-1");

    expect(rig.leases).toEqual(["art-1", "art-1"]);
    // The second came straight back off; the first is still held.
    expect(rig.releases).toEqual(["art-1"]);
  });

  it("releases retained demand when the awaiting holder unmounts", async () => {
    // A tile that goes away while still waiting sends `body/release` like any
    // other. The retained demand is the only thing holding that subscription
    // open, so it comes off here or it never does.
    const rig = leasedSource({ encodeColdState: () => null });
    const ports = buildPorts(rig.source);
    await ports.bodies.materialize("art-1");
    expect(rig.releases).toEqual([]);

    ports.bodies.release("room-art-1");

    expect(rig.releases).toEqual(["art-1"]);
  });

  it("releases retained demand at teardown, which no observer walk would reach", async () => {
    // An awaiting body deliberately has NO observer - there is no materialized
    // doc to watch - so a teardown that only detached observers would skip
    // exactly these entries. That is why the corner is named for the HOLDS.
    const rig = leasedSource({ encodeColdState: () => null });
    const ports = buildPorts(rig.source);
    await ports.bodies.materialize("art-1");

    ports.releaseAllBodyHolds();

    expect(rig.releases).toEqual(["art-1"]);
  });

  it("promotes the RETAINED demand when the seed finally arrives", async () => {
    // The awaiting -> resident transition. The retained release has held the
    // subscription open continuously since the awaiting answer, so it becomes
    // the resident hold and the retry's own lease is what comes off - demand
    // goes two to one with no instant at zero.
    let seeded = false;
    const rig = leasedSource({
      encodeColdState: (docKey) =>
        seeded
          ? {
              update: new Uint8Array([4, 5]),
              seedMode: "full" as const,
              hostStateVector: null,
              docGuid: `guid-${docKey}`,
            }
          : null,
    });
    const ports = buildPorts(rig.source);

    await expect(ports.bodies.materialize("art-1")).resolves.toMatchObject({
      update: null,
    });
    // The host's `doc` frame lands, which is what the retry is waiting for.
    seeded = true;
    const granted = await ports.bodies.materialize("art-1");

    expect(granted?.update).toEqual(new Uint8Array([4, 5]));
    expect(rig.leases).toEqual(["art-1", "art-1"]);
    // Exactly ONE came off, and the doc is resident on one held demand.
    expect(rig.releases).toEqual(["art-1"]);
    expect(ports.bodies.heldDocKeys()).toEqual(["room-art-1"]);
  });

  it("does not stack leases for a docKey already held", async () => {
    // `bodies.release` decrements a ref-count, and the main side sends ONE
    // demote per doc - so a second retained release is never called and the
    // body stream stays open for the session.
    const rig = leasedSource({});
    const ports = buildPorts(rig.source);

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
    const ports = buildPorts(rig.source);
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
      settleColdState: () => ({
        accepted: false as const,
        reason: "not-held" as const,
      }),
    });
    const ports = buildPorts(rig.source);
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

describe("bodies.materialize — forward-only vs not-held", () => {
  /**
   * The discrimination that matters, both directions.
   *
   * `encodeColdState` refuses for two reasons and only one of them may become
   * a forward-only install. Giving an identity-STATED room the forward-only
   * treatment would retire its settle path silently - the demote invariant
   * dying for that room with nothing to say so.
   */
  function coldRefusingSource(
    forwardOnly: Uint8Array | null,
  ): EpicRuntimeCorePortSource {
    return createSource({
      acquireBodyLease: () => () => {},
      bodyDocKey: (artifactId) => `room-${artifactId}`,
      encodeColdState: () => null,
      encodeForwardOnly: () => forwardOnly,
    });
  }

  it("serves an identity-ABSENT room forward-only, with a null guid", async () => {
    // The `@1` arm: its adapter states no identity by design, so cold state
    // refuses and the live bytes are the only way across. Refusing here takes
    // the whole arm dark.
    const ports = buildPorts(coldRefusingSource(new Uint8Array([7])));

    const materialized = await ports.bodies.materialize("art-1");

    expect(materialized).not.toBeNull();
    expect(materialized?.docGuid).toBeNull();
    expect(materialized?.update).toEqual(new Uint8Array([7]));
  });

  it("answers AWAITING when the source offers no forward-only bytes either", async () => {
    // PLUMBING ONLY, and named that way deliberately. This drives
    // `encodeForwardOnly` at the SOURCE, so it pins the ports' both-directions
    // wiring and NOT the discrimination that decides which rooms get here.
    //
    // That discrimination - identity-absent serves forward-only, identity-
    // STATED answers not-held - lives in `encodeArtifactBodyForwardOnly`
    // (`epic-replica-runtime.ts`), which reads `tier.statedDocGuid`. Ablating
    // that check leaves THIS suite green, which is how the gap was found. Its
    // pin is owed at the runtime level, against a real tier.
    //
    // NEITHER path has bytes, and that is AWAITING rather than not-held: the
    // artifact HAS a doc key, so this is a body whose seed has not arrived, not
    // a body that does not exist. Only a `null` doc key is not-held now, and
    // the pin above (`bodyDocKey: () => null`) is the one that covers it.
    const ports = buildPorts(coldRefusingSource(null));

    await expect(ports.bodies.materialize("art-1")).resolves.toMatchObject({
      docKey: "room-art-1",
      update: null,
    });
  });
});

/**
 * The return leg does not hand on the array it was GIVEN.
 *
 * Yjs delivers ONE freshly-encoded array to every `update` listener. On the
 * `@1` arm two listen: the tier's outbound observer, which turns it into an
 * `artifactRoomApplyUpdate` frame, and the body return leg. The return leg's
 * bytes are eventually handed to `takeBytesForTransfer`, which transfers a
 * full-span standalone buffer IN PLACE - so passing the shared array straight
 * through detaches the one the tier's frame is still holding, and that frame
 * decodes as `Unexpected end of array` wherever it is finally read.
 *
 * Pinned as IDENTITY rather than as a decode failure downstream: the property
 * is "we are not the owner, so we copy", and identity is what states it. A
 * behavioural pin would depend on which of the two observers happens to run
 * first, and would go quiet the day they are reordered.
 */
describe("the body return leg's ownership of its bytes", () => {
  it("copies the update rather than forwarding the array it was handed", async () => {
    // A HOLDER, not a `let`. TypeScript narrows a `let` to its initializer
    // and cannot see an assignment that happens inside a callback, so every
    // later read is `null` and the call below is rejected. A property write
    // has effects TS does not try to order, so the declared type survives.
    const observer: { emit: ((update: Uint8Array) => void) | null } = {
      emit: null,
    };
    const forwarded: Uint8Array[] = [];
    const ports = buildEpicRuntimeCorePorts(
      createSource({
        bodyDocKey: () => "doc-1",
        encodeColdState: () => ({
          update: Uint8Array.from([1, 2, 3]),
          docGuid: "guid-1",
          seedMode: "full",
          hostStateVector: null,
        }),
        observeBodyDoc: (_docKey, onUpdate) => {
          observer.emit = onUpdate;
          return () => {};
        },
      }),
      {
        onDocUpdate: (_docKey, update) => {
          forwarded.push(update);
        },
        onAwareness: () => {},
      },
    );

    await ports.bodies.materialize("artifact-1");
    // Captured into a const: TypeScript will not narrow a `let` that a closure
    // assigns, so calling `emit` directly reads as possibly-null.
    const emitUpdate = observer.emit;
    if (emitUpdate === null) throw new Error("observer never attached");

    // The array Yjs would hand to BOTH listeners.
    const shared = Uint8Array.from([9, 8, 7]);
    emitUpdate(shared);

    expect(forwarded).toHaveLength(1);
    // Equal bytes...
    expect(Array.from(forwarded[0] ?? [])).toEqual([9, 8, 7]);
    // ...and NOT the same object, which is the whole claim.
    expect(forwarded[0]).not.toBe(shared);
  });
});
