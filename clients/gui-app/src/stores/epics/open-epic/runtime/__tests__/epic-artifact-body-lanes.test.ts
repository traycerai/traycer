/**
 * `createEpicArtifactBodyLanes` - the demand tracker that turns "which bodies
 * is someone looking at" into `artifact.subscribe@1.0` adapters, matched to
 * the epoch the records lane is currently serving.
 *
 * Every test here drives the real function through a COUNTING artifact stream
 * factory - copied from `open-epic/__tests__/lane-adapter-probe.test.ts` - that
 * records what each constructed client was built with and captures its
 * `ArtifactStreamCallbacks` so a test can deliver real `doc` / `unavailable`
 * frames, built through the wire's own zod schema rather than hand-rolled.
 * Nothing here mocks `createArtifactLaneAdapter` itself: the adapter, the
 * `lane-body-translation` seam, and the body-lanes module all run for real, so
 * what is pinned is the composed behaviour, not a stubbed contract.
 *
 * The eight pins below are, in order: demand held before an epoch exists
 * (the cold-open shape); idempotence under one epoch; an epoch change
 * rebuilding rather than reusing an adapter; the `release`-forgets /
 * `detachAll`-remembers asymmetry; `sendUpdate` queuing (never dropping) a
 * user's edit before the body is seeded; `sendUpdate` stamping the guid
 * learned from the seed; `sendAwareness` dropping (never queuing) presence
 * with nowhere to go; and a `stale-authority-epoch` frame requesting a replica
 * replacement rather than reading as an availability change.
 */
import { describe, expect, it } from "vitest";
import type {
  ArtifactLaneStreamClient,
  ArtifactStreamClientFactory,
} from "@traycer-clients/shared/epic-lanes";
import type {
  ArtifactDocFrame,
  ArtifactStreamCallbacks,
  ArtifactUnavailableFrame,
} from "@traycer-clients/shared/host-transport/artifact-stream-client";
import type { ReplicaReplacementReason } from "@traycer-clients/shared/replica-runtime";
import {
  artifactSubscribeServerFrameSchemaV10,
  type ArtifactSubscribeUnavailableCode,
} from "@traycer/protocol/host/epic/artifact-subscribe";
import {
  createEpicArtifactBodyLanes,
  type EpicArtifactBodyLanes,
} from "../epic-artifact-body-lanes";
import type { EpicRoomEvent } from "../epic-runtime-events";
import { createRendererRuntimeEnvironment } from "../runtime-environment";

// ── Narrowing helper - throw rather than a non-null assertion, so a wrong
//    count reports WHERE it went wrong instead of a bare "possibly undefined"
//    type error. Same shape as the probe test's `requireSupport`. ──────────

function requireAt<T>(items: readonly T[], index: number): T {
  const item = items[index];
  if (item === undefined) {
    throw new Error(
      `expected an item at index ${index}, but only ${items.length} were recorded`,
    );
  }
  return item;
}

// ── Real wire frames, built through the schema's own `.parse` and narrowed -
//    never hand-rolled, per the module's own "epoch changes meaning" and
//    "delta vs full seed" warnings about drifting from the contract. ───────

function buildDocFrame(fields: {
  readonly authorityEpoch: string;
  readonly artifactId: string;
  readonly docGuid: string;
}): ArtifactDocFrame {
  const parsed = artifactSubscribeServerFrameSchemaV10.parse({
    kind: "doc",
    authorityEpoch: fields.authorityEpoch,
    artifactId: fields.artifactId,
    docGuid: fields.docGuid,
    stateVectorBase64: "AA==",
    hasBinaryPayload: true,
  });
  if (parsed.kind !== "doc") {
    throw new Error(`expected a doc frame, got ${parsed.kind}`);
  }
  return parsed;
}

function buildUnavailableFrame(fields: {
  readonly authorityEpoch: string;
  readonly artifactId: string;
  readonly code: ArtifactSubscribeUnavailableCode;
  readonly terminal: boolean;
}): ArtifactUnavailableFrame {
  const parsed = artifactSubscribeServerFrameSchemaV10.parse({
    kind: "unavailable",
    authorityEpoch: fields.authorityEpoch,
    artifactId: fields.artifactId,
    code: fields.code,
    reason: "test reason",
    terminal: fields.terminal,
    hasBinaryPayload: false,
  });
  if (parsed.kind !== "unavailable") {
    throw new Error(`expected an unavailable frame, got ${parsed.kind}`);
  }
  return parsed;
}

// ── The counting artifact factory - the harness style
//    `lane-adapter-probe.test.ts` uses, extended to capture each client's
//    callbacks (so a test can deliver frames) and its outbound calls (so a
//    test can assert on what the adapter sent down the wire). ─────────────

interface ApplyUpdateCall {
  readonly docGuid: string;
  readonly update: Uint8Array;
}

interface ConstructedArtifactClient {
  readonly artifactId: string;
  readonly authorityEpoch: string;
  readonly callbacks: ArtifactStreamCallbacks;
  readonly applyUpdateCalls: readonly ApplyUpdateCall[];
  readonly awarenessCalls: readonly Uint8Array[];
  closeCount(): number;
}

interface CountingArtifactFactory {
  readonly factory: ArtifactStreamClientFactory;
  readonly clients: readonly ConstructedArtifactClient[];
}

function createCountingArtifactFactory(): CountingArtifactFactory {
  const clients: ConstructedArtifactClient[] = [];
  const factory: ArtifactStreamClientFactory = (
    _epicId,
    artifactId,
    authorityEpoch,
    callbacks,
    _seedOfferProvider,
  ): ArtifactLaneStreamClient => {
    const applyUpdateCalls: ApplyUpdateCall[] = [];
    const awarenessCalls: Uint8Array[] = [];
    let closes = 0;
    clients.push({
      artifactId,
      authorityEpoch,
      callbacks,
      applyUpdateCalls,
      awarenessCalls,
      closeCount: () => closes,
    });
    return {
      applyUpdate: (docGuid, update) => {
        applyUpdateCalls.push({ docGuid, update });
      },
      awareness: (frame) => {
        awarenessCalls.push(frame);
      },
      close: () => {
        closes += 1;
      },
    };
  };
  return { factory, clients };
}

// ── Runtime construction - a real `createEpicArtifactBodyLanes` wired to the
//    counting factory, with a controllable authority-epoch source. Every
//    other source is a plain recording fake: this module's only real
//    collaborators are the epoch reader and the factory it is asked to
//    open lanes through. ─────────────────────────────────────────────────

interface LanesRig {
  readonly lanes: EpicArtifactBodyLanes;
  readonly artifacts: CountingArtifactFactory;
  readonly roomEvents: readonly EpicRoomEvent[];
  readonly replacementReasons: readonly ReplicaReplacementReason[];
  /**
   * How many times this module reported the host refusing
   * `artifact.subscribe`. Exposed so a pin can assert the count rather than
   * merely that it happened - the arm above coalesces across tiles, and a
   * per-tile fan-out is only visible as a number.
   */
  laneUnsupportedCount(): number;
  setAuthorityEpoch(epoch: string | null): void;
}

/**
 * `initialAuthorityEpoch` is required, not optional, so every call site
 * states up front whether it is exercising the cold-open (`null`) shape or
 * the already-known-epoch shape.
 */
function createLanesRig(initialAuthorityEpoch: string | null): LanesRig {
  const artifacts = createCountingArtifactFactory();
  const roomEvents: EpicRoomEvent[] = [];
  const replacementReasons: ReplicaReplacementReason[] = [];
  /**
   * How many times the host has been observed refusing `artifact.subscribe`.
   * Counted rather than flagged: the arm above coalesces across tiles, and a
   * per-tile fan-out would show up here as a number greater than one.
   */
  let laneUnsupportedCount = 0;
  let authorityEpoch = initialAuthorityEpoch;
  const lanes = createEpicArtifactBodyLanes({
    epicId: "epic-1",
    environment: createRendererRuntimeEnvironment(),
    streamClientFactory: artifacts.factory,
    readAuthorityEpoch: () => authorityEpoch,
    readDocSeed: () => null,
    isDisposed: () => false,
    onRoomEvent: (event) => {
      roomEvents.push(event);
    },
    onReplacementRequested: (reason) => {
      replacementReasons.push(reason);
    },
    onLaneUnsupported: () => {
      laneUnsupportedCount += 1;
    },
  });
  return {
    lanes,
    artifacts,
    roomEvents,
    replacementReasons,
    laneUnsupportedCount: () => laneUnsupportedCount,
    setAuthorityEpoch: (epoch) => {
      authorityEpoch = epoch;
    },
  };
}

describe("createEpicArtifactBodyLanes - demand-tracked artifact body lanes", () => {
  it("(a) demand held before an epoch exists: ensureAttached opens nothing and does not throw; syncToAuthorityEpoch opens it once the epoch lands", () => {
    const rig = createLanesRig(null);

    expect(() => rig.lanes.ensureAttached("art-1")).not.toThrow();
    expect(rig.artifacts.clients).toHaveLength(0);

    rig.setAuthorityEpoch("epoch-1");
    rig.lanes.syncToAuthorityEpoch();

    expect(rig.artifacts.clients).toHaveLength(1);
    const client = requireAt(rig.artifacts.clients, 0);
    expect(client.artifactId).toBe("art-1");
    expect(client.authorityEpoch).toBe("epoch-1");
  });

  it("(b) idempotent under one epoch: three ensureAttached calls construct exactly one client", () => {
    const rig = createLanesRig("epoch-1");

    rig.lanes.ensureAttached("art-1");
    rig.lanes.ensureAttached("art-1");
    rig.lanes.ensureAttached("art-1");

    expect(rig.artifacts.clients).toHaveLength(1);
    expect(rig.lanes.attachedArtifactIds()).toEqual(["art-1"]);
  });

  it("(c) an epoch change rebuilds rather than reuses the adapter: the old client is closed and the new one is built for the new epoch", () => {
    const rig = createLanesRig("epoch-1");
    rig.lanes.ensureAttached("art-1");

    const first = requireAt(rig.artifacts.clients, 0);
    expect(first.closeCount()).toBe(0);

    rig.setAuthorityEpoch("epoch-2");
    rig.lanes.syncToAuthorityEpoch();

    expect(first.closeCount()).toBe(1);
    expect(rig.artifacts.clients).toHaveLength(2);
    const second = requireAt(rig.artifacts.clients, 1);
    expect(second.artifactId).toBe("art-1");
    // Asserted explicitly: a reused adapter would keep a subscription open
    // against a generation the host has stopped serving.
    expect(second.authorityEpoch).toBe("epoch-2");
  });

  describe("(d) release forgets demand; detachAll does not - the asymmetry that makes a transport blip recoverable without un-closing a deliberately closed tile", () => {
    it("release closes the lane, and a later syncToAuthorityEpoch does not reopen it", () => {
      const rig = createLanesRig("epoch-1");
      rig.lanes.ensureAttached("art-1");
      rig.lanes.ensureAttached("art-2");
      expect(rig.artifacts.clients).toHaveLength(2);

      rig.lanes.release("art-1", "superseded");

      const releasedClient = requireAt(rig.artifacts.clients, 0);
      expect(releasedClient.artifactId).toBe("art-1");
      expect(releasedClient.closeCount()).toBe(1);
      expect(rig.lanes.attachedArtifactIds()).toEqual(["art-2"]);

      rig.lanes.syncToAuthorityEpoch();

      // No epoch change happened, so this call has nothing to rebuild for
      // art-2 - and, because release() forgot art-1's demand, nothing to
      // reopen for it either: still one closed client, ever, for art-1.
      expect(rig.artifacts.clients).toHaveLength(2);
      expect(rig.lanes.attachedArtifactIds()).toEqual(["art-2"]);
    });

    it("detachAll closes every lane but keeps demand, so a later syncToAuthorityEpoch reopens all of them", () => {
      const rig = createLanesRig("epoch-1");
      rig.lanes.ensureAttached("art-1");
      rig.lanes.ensureAttached("art-2");
      expect(rig.artifacts.clients).toHaveLength(2);

      rig.lanes.detachAll("transport-only");

      expect(requireAt(rig.artifacts.clients, 0).closeCount()).toBe(1);
      expect(requireAt(rig.artifacts.clients, 1).closeCount()).toBe(1);
      expect(rig.lanes.attachedArtifactIds()).toEqual([]);

      rig.lanes.syncToAuthorityEpoch();

      expect(rig.artifacts.clients).toHaveLength(4);
      expect([...rig.lanes.attachedArtifactIds()].sort()).toEqual([
        "art-1",
        "art-2",
      ]);
    });
  });

  it("(e) sendUpdate before the body is seeded is queued, not dropped, and never reaches the client", () => {
    const rig = createLanesRig("epoch-1");
    rig.lanes.ensureAttached("art-1");
    const client = requireAt(rig.artifacts.clients, 0);

    const outcome = rig.lanes.sendUpdate("art-1", new Uint8Array([1, 2, 3]));

    expect(outcome.kind).toBe("queued");
    // Stated as its own assertion, per the pin: `dropped` would tell the
    // caller to discard a user's edit, which is the one outcome that must
    // never happen here.
    expect(outcome.kind).not.toBe("dropped");
    expect(client.applyUpdateCalls).toHaveLength(0);
  });

  it("(f) sendUpdate after the seed stamps the exact guid the doc-snapshot frame carried", () => {
    const rig = createLanesRig("epoch-1");
    rig.lanes.ensureAttached("art-1");
    const client = requireAt(rig.artifacts.clients, 0);

    client.callbacks.onDoc(
      buildDocFrame({
        authorityEpoch: "epoch-1",
        artifactId: "art-1",
        docGuid: "guid-xyz",
      }),
      new Uint8Array([9, 9]),
    );

    const outcome = rig.lanes.sendUpdate("art-1", new Uint8Array([1, 2, 3]));

    expect(outcome.kind).toBe("sent");
    expect(client.applyUpdateCalls).toHaveLength(1);
    expect(requireAt(client.applyUpdateCalls, 0).docGuid).toBe("guid-xyz");
  });

  it("(g) sendAwareness with no lane is dropped, not queued - the opposite of sendUpdate, because presence is fire-and-forget", () => {
    const rig = createLanesRig("epoch-1");
    // Deliberately no ensureAttached - there is no lane for "art-none".

    const outcome = rig.lanes.sendAwareness("art-none", new Uint8Array([7]));

    expect(outcome.kind).toBe("dropped");
    expect(outcome.kind).not.toBe("queued");
  });

  it("(h) a stale-authority-epoch unavailable frame requests a replacement and emits no room event; a bodyUnavailable frame does the opposite", () => {
    const rig = createLanesRig("epoch-1");
    rig.lanes.ensureAttached("art-1");
    const client = requireAt(rig.artifacts.clients, 0);

    client.callbacks.onUnavailable(
      buildUnavailableFrame({
        authorityEpoch: "epoch-1",
        artifactId: "art-1",
        code: "staleAuthorityEpoch",
        terminal: true,
      }),
    );

    // The client's whole epic view is void - not a per-body availability
    // state - so no room event may leak through for it.
    expect(rig.roomEvents).toHaveLength(0);
    expect(rig.replacementReasons.length).toBeGreaterThan(0);
    expect(
      rig.replacementReasons.every(
        (reason) => reason === "authority-epoch-changed",
      ),
    ).toBe(true);
    const replacementCountAfterStaleEpoch = rig.replacementReasons.length;

    client.callbacks.onUnavailable(
      buildUnavailableFrame({
        authorityEpoch: "epoch-1",
        artifactId: "art-1",
        code: "bodyUnavailable",
        terminal: false,
      }),
    );

    // The opposite outcome: a room-level availability event, and no
    // additional replacement request beyond what the first frame already
    // produced.
    expect(rig.roomEvents).toHaveLength(1);
    expect(requireAt(rig.roomEvents, 0)).toEqual({
      kind: "room-availability",
      artifactRoomId: "art-1",
      availability: "retrying",
    });
    expect(rig.replacementReasons).toHaveLength(
      replacementCountAfterStaleEpoch,
    );
  });

  it("(i) two demands, one release keeps the stream open; the second release closes it", () => {
    const rig = createLanesRig("epoch-1");
    rig.lanes.ensureAttached("art-1");
    rig.lanes.ensureAttached("art-1");
    expect(rig.artifacts.clients).toHaveLength(1);
    const client = requireAt(rig.artifacts.clients, 0);

    rig.lanes.release("art-1", "superseded");

    // One of two demands let go, not the last one - the client must still be
    // open. Asserted on the CLIENT'S close count, not on attachedArtifactIds()
    // alone: a demand-tracking bug that forgot to keep the lane open would
    // still report "art-1" as attached right up until the map entry it never
    // closed was deleted some other way.
    expect(client.closeCount()).toBe(0);
    expect(rig.lanes.attachedArtifactIds()).toEqual(["art-1"]);

    rig.lanes.release("art-1", "superseded");

    expect(client.closeCount()).toBe(1);
    expect(rig.lanes.attachedArtifactIds()).toEqual([]);
  });

  it("(j) a body with zero demand is not reopened by a later epoch change", () => {
    const rig = createLanesRig("epoch-1");
    rig.lanes.ensureAttached("art-1");
    expect(rig.artifacts.clients).toHaveLength(1);

    rig.lanes.release("art-1", "superseded");
    expect(requireAt(rig.artifacts.clients, 0).closeCount()).toBe(1);
    expect(rig.lanes.attachedArtifactIds()).toEqual([]);

    rig.setAuthorityEpoch("epoch-2");
    rig.lanes.syncToAuthorityEpoch();

    // This is the leak the ref-count exists to stop: before it, every tile
    // ever opened was rebuilt on every epoch change forever, including one
    // with no demand left at all. No new client for "art-1" - the demand set
    // to rebuild from no longer contains it.
    expect(rig.artifacts.clients).toHaveLength(1);
    expect(rig.lanes.attachedArtifactIds()).toEqual([]);
  });

  it("(k) a release with nothing held is a no-op: no throw, no client constructed, no close", () => {
    const rig = createLanesRig("epoch-1");

    // Never attached at all - the shape of a lease taken before an arm
    // replacement, released after every lane is already gone.
    expect(() => rig.lanes.release("art-none", "superseded")).not.toThrow();
    expect(rig.artifacts.clients).toHaveLength(0);

    rig.lanes.ensureAttached("art-1");
    rig.lanes.release("art-1", "superseded");
    const client = requireAt(rig.artifacts.clients, 0);
    expect(client.closeCount()).toBe(1);

    // Released again with nothing held this time.
    expect(() => rig.lanes.release("art-1", "superseded")).not.toThrow();
    // No new client was constructed, and the one already closed was not
    // closed a second time.
    expect(rig.artifacts.clients).toHaveLength(1);
    expect(client.closeCount()).toBe(1);
  });
});
