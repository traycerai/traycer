import { describe, expect, it } from "vitest";
import {
  agentIdentityFileSubscribeServerFrameSchemaV10,
  agentIdentityFileSubscribeUnavailableCodeSchema,
  type AgentIdentityFileSeedOffer,
} from "@traycer/protocol/host/agent-identity/file-subscribe";
import type {
  AdapterHost,
  AdapterStatus,
  DocReplicaEvent,
  ResumeOutcome,
  RuntimeEnvironment,
} from "@traycer-clients/shared/replica-runtime";
import type {
  IdentityFileAwarenessFrame,
  IdentityFileDocAckFrame,
  IdentityFileDocFrame,
  IdentityFileDocUpdateFrame,
  IdentityFileStreamCallbacks,
  IdentityFileUnavailableFrame,
} from "@traycer-clients/shared/host-transport/identity-file-stream-client";
import { identityFileLaneId } from "../lane-events";
import {
  createIdentityFileLaneAdapter,
  type IdentityFileLaneAdapterSources,
  type IdentityFileLaneStreamClient,
  type IdentityFileStreamClientFactory,
  type IdentityFileStreamClientRequest,
} from "../identity-file-lane-adapter";

/**
 * `agentIdentity.file.subscribe@1.0` adapter - body-lane decode, the closed
 * refusal-code mapping, the epoch that is fixed for the adapter's life, and the
 * two ways a send is dropped.
 *
 * Every server frame is parsed through the REAL wire schema and narrowed on
 * `kind`, so a fixture that drifts from the contract fails at construction.
 */

const IDENTITY_ID = "identity_1";
const PATH = "skills/reviewer/SKILL.md";
const EPOCH = "epoch-1";

// ─── Frame builders (parsed through the real schema) ───────────────────────

function docFrame(
  docGuid: string,
  seededFromOffer: boolean,
): IdentityFileDocFrame {
  const parsed = agentIdentityFileSubscribeServerFrameSchemaV10.parse({
    kind: "doc",
    authorityEpoch: EPOCH,
    path: PATH,
    docGuid,
    stateVectorBase64: "c3Y=",
    // ABSENCE is the wire encoding of "full seed" - the schema types the key as
    // `z.literal(true).optional()` so there is no `false` to write.
    ...(seededFromOffer ? { seededFromOffer: true } : {}),
    hasBinaryPayload: true,
  });
  if (parsed.kind !== "doc") throw new Error("fixture drift: doc");
  return parsed;
}

function docUpdateFrame(docGuid: string): IdentityFileDocUpdateFrame {
  const parsed = agentIdentityFileSubscribeServerFrameSchemaV10.parse({
    kind: "docUpdate",
    authorityEpoch: EPOCH,
    path: PATH,
    docGuid,
    hasBinaryPayload: true,
  });
  if (parsed.kind !== "docUpdate") throw new Error("fixture drift: docUpdate");
  return parsed;
}

function docAckFrame(docGuid: string): IdentityFileDocAckFrame {
  const parsed = agentIdentityFileSubscribeServerFrameSchemaV10.parse({
    kind: "docAck",
    authorityEpoch: EPOCH,
    path: PATH,
    docGuid,
    coverageStateVectorBase64: "Y3Y=",
    hasBinaryPayload: false,
  });
  if (parsed.kind !== "docAck") throw new Error("fixture drift: docAck");
  return parsed;
}

function awarenessFrame(): IdentityFileAwarenessFrame {
  const parsed = agentIdentityFileSubscribeServerFrameSchemaV10.parse({
    kind: "awareness",
    authorityEpoch: EPOCH,
    path: PATH,
    hasBinaryPayload: true,
  });
  if (parsed.kind !== "awareness") throw new Error("fixture drift: awareness");
  return parsed;
}

function unavailableFrame(
  code: string,
  terminal: boolean,
): IdentityFileUnavailableFrame {
  const parsed = agentIdentityFileSubscribeServerFrameSchemaV10.parse({
    kind: "unavailable",
    authorityEpoch: EPOCH,
    path: PATH,
    code,
    reason: "host-side summary",
    terminal,
    hasBinaryPayload: false,
  });
  if (parsed.kind !== "unavailable") {
    throw new Error("fixture drift: unavailable");
  }
  return parsed;
}

// ─── Fakes ──────────────────────────────────────────────────────────────

interface FakeStreamClient extends IdentityFileLaneStreamClient {
  readonly closeCalls: number;
  readonly updates: readonly { docGuid: string; bytes: Uint8Array }[];
  readonly awarenessFrames: readonly Uint8Array[];
}

interface FakeHandle {
  readonly request: IdentityFileStreamClientRequest;
  readonly client: FakeStreamClient;
}

function createFakeStreamClientFactory(): {
  readonly factory: IdentityFileStreamClientFactory;
  readonly handles: () => readonly FakeHandle[];
  readonly latest: () => FakeHandle;
} {
  const handles: FakeHandle[] = [];
  const factory: IdentityFileStreamClientFactory = (request) => {
    let closeCalls = 0;
    const updates: { docGuid: string; bytes: Uint8Array }[] = [];
    const awarenessFrames: Uint8Array[] = [];
    const client: FakeStreamClient = {
      get closeCalls() {
        return closeCalls;
      },
      get updates() {
        return updates;
      },
      get awarenessFrames() {
        return awarenessFrames;
      },
      applyUpdate: (docGuid, bytes) => {
        updates.push({ docGuid, bytes });
      },
      awareness: (bytes) => {
        awarenessFrames.push(bytes);
      },
      close: () => {
        closeCalls += 1;
      },
    };
    handles.push({ request, client });
    return client;
  };
  return {
    factory,
    handles: () => handles,
    latest: () => {
      const handle = handles.at(-1);
      if (handle === undefined) throw new Error("factory not invoked");
      return handle;
    },
  };
}

function createFakeRuntimeEnvironment(): RuntimeEnvironment {
  return {
    clock: { now: () => 0 },
    scheduler: {
      schedule: () => ({ cancel: () => {} }),
      scheduleMicrotask: () => {},
    },
    logger: {
      debug: () => {},
      warn: () => {},
      error: () => {},
    },
  };
}

type LogEntry =
  | { readonly channel: "emit"; readonly event: DocReplicaEvent }
  | { readonly channel: "reportResume"; readonly outcome: ResumeOutcome }
  | { readonly channel: "reportStatus"; readonly status: AdapterStatus }
  | { readonly channel: "requestReplacement"; readonly reason: string };

function createRecordingHost(): {
  readonly host: AdapterHost<DocReplicaEvent>;
  readonly log: readonly LogEntry[];
} {
  const log: LogEntry[] = [];
  const host: AdapterHost<DocReplicaEvent> = {
    environment: createFakeRuntimeEnvironment(),
    emit: (event) => log.push({ channel: "emit", event }),
    reportResume: (outcome) => log.push({ channel: "reportResume", outcome }),
    reportStatus: (status) => log.push({ channel: "reportStatus", status }),
    requestReplacement: (reason) =>
      log.push({ channel: "requestReplacement", reason }),
  };
  return { host, log };
}

function emittedEvents(log: readonly LogEntry[]): readonly DocReplicaEvent[] {
  return log
    .filter(
      (entry): entry is Extract<LogEntry, { channel: "emit" }> =>
        entry.channel === "emit",
    )
    .map((entry) => entry.event);
}

function createSources(
  factory: IdentityFileStreamClientFactory,
  readDocSeed: (() => AgentIdentityFileSeedOffer | null) | undefined,
  isDisposed: (() => boolean) | undefined,
): IdentityFileLaneAdapterSources {
  return {
    identityId: IDENTITY_ID,
    path: PATH,
    authorityEpoch: EPOCH,
    streamClientFactory: factory,
    readDocSeed: readDocSeed ?? (() => null),
    isDisposed: isDisposed ?? (() => false),
  };
}

function callbacksOf(handle: FakeHandle): IdentityFileStreamCallbacks {
  return handle.request.callbacks;
}

// ─── Refusal codes ─────────────────────────────────────────────────────────

describe("createIdentityFileLaneAdapter - refusal codes", () => {
  it("maps every wire code, and never collapses notAFragment into a not-found", () => {
    // Driven off the SCHEMA's own option list, so a code added by a future minor
    // fails here rather than silently rendering the wrong affordance.
    const expected: Readonly<Record<string, string>> = {
      staleAuthorityEpoch: "stale-authority-epoch",
      fileNotFound: "file-not-found",
      notAFragment: "not-a-fragment",
      bodyUnavailable: "body-unavailable",
    };
    const wireCodes = agentIdentityFileSubscribeUnavailableCodeSchema.options;
    expect([...wireCodes].sort()).toEqual(Object.keys(expected).sort());

    for (const wireCode of wireCodes) {
      const { factory, latest } = createFakeStreamClientFactory();
      const adapter = createIdentityFileLaneAdapter(
        createSources(factory, undefined, undefined),
      );
      const { host, log } = createRecordingHost();
      adapter.attach(host);
      callbacksOf(latest()).onUnavailable(unavailableFrame(wireCode, true));

      const [event] = emittedEvents(log);
      if (event.kind !== "doc-unavailable") throw new Error("no refusal");
      expect(event.code).toBe(expected[wireCode]);
      expect(event.docId).toBe(PATH);
      expect(event.terminal).toBe(true);
      expect(event.reason).toBe("host-side summary");
    }
  });

  it("asks for a replacement on a stale epoch, and on nothing else", () => {
    for (const wireCode of agentIdentityFileSubscribeUnavailableCodeSchema.options) {
      const { factory, latest } = createFakeStreamClientFactory();
      const adapter = createIdentityFileLaneAdapter(
        createSources(factory, undefined, undefined),
      );
      const { host, log } = createRecordingHost();
      adapter.attach(host);
      callbacksOf(latest()).onUnavailable(unavailableFrame(wireCode, true));

      const replacements = log.filter(
        (entry) => entry.channel === "requestReplacement",
      );
      // A stale epoch is a statement about the IDENTITY, not about this body:
      // the client's whole index view is void. Every other code is a fact about
      // one file and leaves the replica alone.
      expect(replacements).toHaveLength(
        wireCode === "staleAuthorityEpoch" ? 1 : 0,
      );
    }
  });

  it("a NON-terminal bodyUnavailable leaves the lane sendable", () => {
    const { factory, latest } = createFakeStreamClientFactory();
    const adapter = createIdentityFileLaneAdapter(
      createSources(factory, undefined, undefined),
    );
    const { host } = createRecordingHost();
    adapter.attach(host);

    callbacksOf(latest()).onUnavailable(
      unavailableFrame("bodyUnavailable", false),
    );

    // `terminal` is its own boolean precisely because `bodyUnavailable` is both
    // a shard that is retrying and one that has given up.
    expect(
      adapter.send({ kind: "awareness", frame: new Uint8Array([1]) }),
    ).toEqual({ kind: "sent" });
  });
});

// ─── Body frames ───────────────────────────────────────────────────────────

describe("createIdentityFileLaneAdapter - body frames", () => {
  it("announces readiness once, then again only after a recovery transition", () => {
    const { factory, latest } = createFakeStreamClientFactory();
    const adapter = createIdentityFileLaneAdapter(
      createSources(factory, undefined, undefined),
    );
    const { host, log } = createRecordingHost();
    adapter.attach(host);

    callbacksOf(latest()).onDoc(docFrame("guid-1", false), new Uint8Array([1]));
    callbacksOf(latest()).onDoc(docFrame("guid-1", false), new Uint8Array([2]));
    callbacksOf(latest()).onConnectionStatus("reconnecting", null);
    callbacksOf(latest()).onDoc(docFrame("guid-1", false), new Uint8Array([3]));

    expect(
      emittedEvents(log).filter((event) => event.kind === "doc-ready").length,
    ).toBe(2);
  });

  it("carries the seed mode, and full-vs-delta is decided by presence alone", () => {
    const { factory, latest } = createFakeStreamClientFactory();
    const adapter = createIdentityFileLaneAdapter(
      createSources(factory, undefined, undefined),
    );
    const { host, log } = createRecordingHost();
    adapter.attach(host);

    callbacksOf(latest()).onDoc(docFrame("guid-1", false), new Uint8Array([1]));
    callbacksOf(latest()).onDoc(docFrame("guid-2", true), new Uint8Array([2]));

    const seeds = emittedEvents(log)
      .filter((event) => event.kind === "doc-snapshot")
      .map((event) => (event.kind === "doc-snapshot" ? event.seed : "?"));
    expect(seeds).toEqual(["full", "delta-against-offer"]);
  });

  it("relabels every frame with its own captured path", () => {
    const { factory, latest } = createFakeStreamClientFactory();
    const adapter = createIdentityFileLaneAdapter(
      createSources(factory, undefined, undefined),
    );
    const { host, log } = createRecordingHost();
    adapter.attach(host);

    const callbacks = callbacksOf(latest());
    callbacks.onDoc(docFrame("guid-1", false), new Uint8Array([1]));
    callbacks.onDocUpdate(docUpdateFrame("guid-1"), new Uint8Array([2]));
    callbacks.onDocAck(docAckFrame("guid-1"));
    callbacks.onAwareness(awarenessFrame(), new Uint8Array([3]));

    const events = emittedEvents(log);
    expect(events.map((event) => event.kind)).toEqual([
      "doc-ready",
      "doc-snapshot",
      "doc-update",
      "doc-coverage-ack",
      "doc-awareness",
    ]);
    for (const event of events) {
      expect(event.docId).toBe(PATH);
      expect(event.authorityEpoch).toBe(EPOCH);
    }
    // Awareness carries no guid: a caret is not document state, and replaying
    // one after a reseed would place a cursor from a document that is gone.
    const awareness = events.at(-1);
    expect(awareness === undefined ? [] : Object.keys(awareness)).not.toContain(
      "docGuid",
    );
  });
});

// ─── Attach shape and the fixed epoch ──────────────────────────────────────

describe("createIdentityFileLaneAdapter - attach", () => {
  it("addresses the lane by identity AND path, so two identities never share one", () => {
    const { factory } = createFakeStreamClientFactory();
    const adapter = createIdentityFileLaneAdapter(
      createSources(factory, undefined, undefined),
    );
    expect(adapter.descriptor.laneId).toBe(
      identityFileLaneId(IDENTITY_ID, PATH),
    );
    expect(identityFileLaneId("a:b", "c")).not.toBe(
      identityFileLaneId("a", "b:c"),
    );
  });

  it("re-reads the seed offer per subscribe but never the epoch", () => {
    let seed: AgentIdentityFileSeedOffer | null = null;
    const { factory, handles, latest } = createFakeStreamClientFactory();
    const adapter = createIdentityFileLaneAdapter(
      createSources(factory, () => seed, undefined),
    );
    const { host } = createRecordingHost();
    adapter.attach(host);
    expect(latest().request.seedOfferProvider()).toBeNull();
    expect(latest().request.authorityEpoch).toBe(EPOCH);

    seed = { knownDocGuid: "guid-1", stateVectorBase64: "c3Y=" };
    adapter.closeTransport();
    adapter.openTransport();

    expect(handles()).toHaveLength(2);
    expect(latest().request.seedOfferProvider()).toEqual(seed);
    // The epoch is baked into the open request and fixed for the adapter's life:
    // a reopen that picked up a newer one would convert a refusal into a
    // successful attach against a different replica.
    expect(latest().request.authorityEpoch).toBe(EPOCH);
  });

  it("offers a doc seed rather than a cursor, under the epoch it was built with", () => {
    const seed: AgentIdentityFileSeedOffer = {
      knownDocGuid: "guid-1",
      stateVectorBase64: "c3Y=",
    };
    const { factory } = createFakeStreamClientFactory();
    const adapter = createIdentityFileLaneAdapter(
      createSources(factory, () => seed, undefined),
    );
    expect(adapter.resumeOffer()).toEqual({
      kind: "doc-seed",
      authorityEpoch: EPOCH,
      knownDocGuid: "guid-1",
      stateVectorBase64: "c3Y=",
    });
  });
});

// ─── Sends ─────────────────────────────────────────────────────────────────

describe("createIdentityFileLaneAdapter - send", () => {
  it("forwards both request arms to the stream client", () => {
    const { factory, latest } = createFakeStreamClientFactory();
    const adapter = createIdentityFileLaneAdapter(
      createSources(factory, undefined, undefined),
    );
    const { host } = createRecordingHost();
    adapter.attach(host);

    expect(
      adapter.send({
        kind: "apply-update",
        docGuid: "guid-1",
        update: new Uint8Array([7]),
      }),
    ).toEqual({ kind: "sent" });
    expect(
      adapter.send({ kind: "awareness", frame: new Uint8Array([8]) }),
    ).toEqual({ kind: "sent" });

    expect(latest().client.updates).toEqual([
      { docGuid: "guid-1", bytes: new Uint8Array([7]) },
    ]);
    expect(latest().client.awarenessFrames).toEqual([new Uint8Array([8])]);
  });

  it("drops with no-transport before attach and after closeTransport", () => {
    const { factory } = createFakeStreamClientFactory();
    const adapter = createIdentityFileLaneAdapter(
      createSources(factory, undefined, undefined),
    );
    const { host } = createRecordingHost();

    expect(
      adapter.send({ kind: "awareness", frame: new Uint8Array([1]) }),
    ).toEqual({ kind: "dropped", reason: "no-transport" });

    adapter.attach(host);
    adapter.closeTransport();
    expect(
      adapter.send({ kind: "awareness", frame: new Uint8Array([1]) }),
    ).toEqual({ kind: "dropped", reason: "no-transport" });
  });

  it("drops with lane-terminal once a terminal refusal has arrived", () => {
    const { factory, latest } = createFakeStreamClientFactory();
    const adapter = createIdentityFileLaneAdapter(
      createSources(factory, undefined, undefined),
    );
    const { host } = createRecordingHost();
    adapter.attach(host);

    callbacksOf(latest()).onUnavailable(unavailableFrame("fileNotFound", true));

    expect(
      adapter.send({
        kind: "apply-update",
        docGuid: "guid-1",
        update: new Uint8Array([1]),
      }),
    ).toEqual({ kind: "dropped", reason: "lane-terminal" });
  });
});

// ─── Generation guard ──────────────────────────────────────────────────────

describe("createIdentityFileLaneAdapter - generation guard", () => {
  it("drops every frame from a socket the adapter has superseded", () => {
    const { factory, latest } = createFakeStreamClientFactory();
    const adapter = createIdentityFileLaneAdapter(
      createSources(factory, undefined, undefined),
    );
    const { host, log } = createRecordingHost();
    adapter.attach(host);
    const stale = latest();

    adapter.closeTransport();
    adapter.openTransport();
    expect(stale.client.closeCalls).toBe(1);

    callbacksOf(stale).onDoc(docFrame("guid-1", false), new Uint8Array([1]));
    callbacksOf(stale).onUnavailable(
      unavailableFrame("staleAuthorityEpoch", true),
    );
    callbacksOf(stale).onConnectionStatus("closed", { kind: "caller" });

    expect(log).toHaveLength(0);
  });

  it("drops frames once the consumer reports itself disposed", () => {
    let disposed = false;
    const { factory, latest } = createFakeStreamClientFactory();
    const adapter = createIdentityFileLaneAdapter(
      createSources(factory, undefined, () => disposed),
    );
    const { host, log } = createRecordingHost();
    adapter.attach(host);

    disposed = true;
    callbacksOf(latest()).onDoc(docFrame("guid-1", false), new Uint8Array([1]));

    expect(log).toHaveLength(0);
  });
});
