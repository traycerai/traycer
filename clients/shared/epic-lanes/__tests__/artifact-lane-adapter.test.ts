import { describe, expect, it } from "vitest";
import { artifactSubscribeServerFrameSchemaV10 } from "@traycer/protocol/host/epic/artifact-subscribe";
import type {
  AdapterHost,
  AdapterStatus,
  DocReplicaEvent,
  ResumeOutcome,
  RuntimeEnvironment,
} from "@traycer-clients/shared/replica-runtime";
import type { ArtifactStreamCallbacks } from "@traycer-clients/shared/host-transport/artifact-stream-client";
import {
  ArtifactStreamClient,
  type ArtifactStreamClientOptions,
} from "@traycer-clients/shared/host-transport/artifact-stream-client";
import type {
  IStreamSession,
  ServerFrameHandler,
  StatusChangeHandler,
  StreamCloseReason,
  StreamConnectionStatus,
  StreamFrameEnvelope,
} from "@traycer-clients/shared/host-transport/i-stream-session";
import type { ArtifactSubscribeSeedOffer } from "@traycer/protocol/host/epic/artifact-subscribe";
import { artifactLaneId, type ArtifactLaneRequest } from "../lane-events";
import {
  createArtifactLaneAdapter,
  type ArtifactLaneAdapterSources,
  type ArtifactLaneStreamClient,
  type ArtifactStreamClientFactory,
} from "../artifact-lane-adapter";

/**
 * `artifact.subscribe@1.0` adapter - `@1` tri-state -> epoch-addressed doc
 * events, send routing, resume offer, and readiness transitions.
 *
 * Every server frame is built by `.parse()`-ing through the real wire schema
 * and narrowing on `kind`, never hand-typed. Frames declaring a binary
 * payload are exercised through the real `ArtifactStreamClient` against a
 * stub `IStreamSession` in its own describe block at the bottom - the fake
 * factory used elsewhere in this file cannot exercise the
 * binary-payload-missing drop, because that drop lives inside the stream
 * client, not the adapter.
 */

const ARTIFACT_ID = "artifact-1";
const AUTHORITY_EPOCH = "epoch-1";

// ─── Frame builders (parsed through the real schema) ───────────────────────

function docFrame(overrides: {
  authorityEpoch?: string;
  docGuid?: string;
  stateVectorBase64?: string;
  seededFromOffer?: true;
}) {
  const base: Record<string, unknown> = {
    kind: "doc",
    authorityEpoch: overrides.authorityEpoch ?? AUTHORITY_EPOCH,
    artifactId: ARTIFACT_ID,
    docGuid: overrides.docGuid ?? "guid-1",
    stateVectorBase64: overrides.stateVectorBase64 ?? "sv-1",
    hasBinaryPayload: true,
  };
  if (overrides.seededFromOffer === true) {
    base.seededFromOffer = true;
  }
  const parsed = artifactSubscribeServerFrameSchemaV10.parse(base);
  if (parsed.kind !== "doc") throw new Error("fixture drift: doc");
  return parsed;
}

function docUpdateFrame(docGuid: string) {
  const parsed = artifactSubscribeServerFrameSchemaV10.parse({
    kind: "docUpdate",
    authorityEpoch: AUTHORITY_EPOCH,
    artifactId: ARTIFACT_ID,
    docGuid,
    hasBinaryPayload: true,
  });
  if (parsed.kind !== "docUpdate") throw new Error("fixture drift: docUpdate");
  return parsed;
}

function docAckFrame(docGuid: string, coverageStateVectorBase64: string) {
  const parsed = artifactSubscribeServerFrameSchemaV10.parse({
    kind: "docAck",
    authorityEpoch: AUTHORITY_EPOCH,
    artifactId: ARTIFACT_ID,
    docGuid,
    coverageStateVectorBase64,
    hasBinaryPayload: false,
  });
  if (parsed.kind !== "docAck") throw new Error("fixture drift: docAck");
  return parsed;
}

function awarenessFrame() {
  const parsed = artifactSubscribeServerFrameSchemaV10.parse({
    kind: "awareness",
    authorityEpoch: AUTHORITY_EPOCH,
    artifactId: ARTIFACT_ID,
    hasBinaryPayload: true,
  });
  if (parsed.kind !== "awareness") throw new Error("fixture drift: awareness");
  return parsed;
}

function unavailableFrame(overrides: {
  code: "staleAuthorityEpoch" | "artifactNotFound" | "bodyUnavailable";
  terminal: boolean;
}) {
  const parsed = artifactSubscribeServerFrameSchemaV10.parse({
    kind: "unavailable",
    authorityEpoch: AUTHORITY_EPOCH,
    artifactId: ARTIFACT_ID,
    code: overrides.code,
    reason: "host said so",
    terminal: overrides.terminal,
    hasBinaryPayload: false,
  });
  if (parsed.kind !== "unavailable")
    throw new Error("fixture drift: unavailable");
  return parsed;
}

// ─── Fakes ──────────────────────────────────────────────────────────────

interface FakeStreamClient extends ArtifactLaneStreamClient {
  readonly applyUpdateCalls: readonly { docGuid: string; update: Uint8Array }[];
  readonly awarenessCalls: readonly Uint8Array[];
  readonly closeCalls: number;
}

interface FakeHandle {
  readonly callbacks: ArtifactStreamCallbacks;
  readonly seedOfferProvider: () => ArtifactSubscribeSeedOffer | null;
  readonly client: FakeStreamClient;
}

function createFakeStreamClientFactory(): {
  readonly factory: ArtifactStreamClientFactory;
  readonly handles: () => readonly FakeHandle[];
  readonly latest: () => FakeHandle;
} {
  const handles: FakeHandle[] = [];
  const factory: ArtifactStreamClientFactory = (
    _epicId,
    _artifactId,
    _authorityEpoch,
    callbacks,
    seedOfferProvider,
  ) => {
    const applyUpdateCalls: { docGuid: string; update: Uint8Array }[] = [];
    const awarenessCalls: Uint8Array[] = [];
    let closeCalls = 0;
    const client: FakeStreamClient = {
      applyUpdateCalls,
      awarenessCalls,
      get closeCalls() {
        return closeCalls;
      },
      applyUpdate: (docGuid, update) => {
        applyUpdateCalls.push({ docGuid, update });
      },
      awareness: (frame) => {
        awarenessCalls.push(frame);
      },
      close: () => {
        closeCalls += 1;
      },
    };
    handles.push({ callbacks, seedOfferProvider, client });
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

function emittedEvents(log: readonly LogEntry[]): DocReplicaEvent[] {
  return log
    .filter(
      (entry): entry is Extract<LogEntry, { channel: "emit" }> =>
        entry.channel === "emit",
    )
    .map((entry) => entry.event);
}

function replacementReasons(log: readonly LogEntry[]): string[] {
  return log
    .filter(
      (entry): entry is Extract<LogEntry, { channel: "requestReplacement" }> =>
        entry.channel === "requestReplacement",
    )
    .map((entry) => entry.reason);
}

function createSources(
  streamClientFactory: ArtifactStreamClientFactory,
  readDocSeed: () => ArtifactSubscribeSeedOffer | null = () => null,
  isDisposed: () => boolean = () => false,
): ArtifactLaneAdapterSources {
  return {
    epicId: "epic-1",
    artifactId: ARTIFACT_ID,
    authorityEpoch: AUTHORITY_EPOCH,
    streamClientFactory,
    readDocSeed,
    isDisposed,
  };
}

// ─── doc -> doc-ready / doc-snapshot ────────────────────────────────────────

describe("createArtifactLaneAdapter - doc-ready transitions", () => {
  it("the first doc frame emits doc-ready BEFORE doc-snapshot", () => {
    const { factory, latest } = createFakeStreamClientFactory();
    const adapter = createArtifactLaneAdapter(createSources(factory));
    const { host, log } = createRecordingHost();
    adapter.attach(host);

    latest().callbacks.onDoc(docFrame({}), new Uint8Array([1]));

    expect(emittedEvents(log).map((event) => event.kind)).toEqual([
      "doc-ready",
      "doc-snapshot",
    ]);
  });

  it("a second doc frame with no intervening unavailable/disconnect does NOT re-emit doc-ready", () => {
    const { factory, latest } = createFakeStreamClientFactory();
    const adapter = createArtifactLaneAdapter(createSources(factory));
    const { host, log } = createRecordingHost();
    adapter.attach(host);

    latest().callbacks.onDoc(docFrame({}), new Uint8Array([1]));
    latest().callbacks.onDoc(docFrame({}), new Uint8Array([2]));

    expect(
      emittedEvents(log).filter((event) => event.kind === "doc-ready"),
    ).toHaveLength(1);
  });

  it("a non-open connection status resets readiness, so the next doc frame re-emits doc-ready", () => {
    const { factory, latest } = createFakeStreamClientFactory();
    const adapter = createArtifactLaneAdapter(createSources(factory));
    const { host, log } = createRecordingHost();
    adapter.attach(host);

    latest().callbacks.onDoc(docFrame({}), new Uint8Array([1]));
    latest().callbacks.onConnectionStatus("reconnecting", null);
    latest().callbacks.onDoc(docFrame({}), new Uint8Array([2]));

    expect(
      emittedEvents(log).filter((event) => event.kind === "doc-ready"),
    ).toHaveLength(2);
  });
});

// ─── seed mode ──────────────────────────────────────────────────────────────

describe("createArtifactLaneAdapter - seed mode", () => {
  it("seededFromOffer:true -> seed:'delta-against-offer'", () => {
    const { factory, latest } = createFakeStreamClientFactory();
    const adapter = createArtifactLaneAdapter(createSources(factory));
    const { host, log } = createRecordingHost();
    adapter.attach(host);

    latest().callbacks.onDoc(
      docFrame({ seededFromOffer: true }),
      new Uint8Array([1]),
    );

    const snapshotEvent = emittedEvents(log).find(
      (event) => event.kind === "doc-snapshot",
    );
    if (snapshotEvent === undefined || snapshotEvent.kind !== "doc-snapshot") {
      throw new Error("expected a doc-snapshot event");
    }
    expect(snapshotEvent.seed).toBe("delta-against-offer");
  });

  it("the field ABSENT -> seed:'full'", () => {
    const { factory, latest } = createFakeStreamClientFactory();
    const adapter = createArtifactLaneAdapter(createSources(factory));
    const { host, log } = createRecordingHost();
    adapter.attach(host);

    latest().callbacks.onDoc(docFrame({}), new Uint8Array([1]));

    const snapshotEvent = emittedEvents(log).find(
      (event) => event.kind === "doc-snapshot",
    );
    if (snapshotEvent === undefined || snapshotEvent.kind !== "doc-snapshot") {
      throw new Error("expected a doc-snapshot event");
    }
    expect(snapshotEvent.seed).toBe("full");
  });
});

// ─── unavailable mapping ────────────────────────────────────────────────────

describe("createArtifactLaneAdapter - unavailable mapping", () => {
  it.each([
    { code: "staleAuthorityEpoch" as const, mapped: "stale-authority-epoch" },
    { code: "artifactNotFound" as const, mapped: "artifact-not-found" },
    { code: "bodyUnavailable" as const, mapped: "body-unavailable" },
  ])("$code -> $mapped, verbatim terminal", ({ code, mapped }) => {
    for (const terminal of [true, false]) {
      const { factory, latest } = createFakeStreamClientFactory();
      const adapter = createArtifactLaneAdapter(createSources(factory));
      const { host, log } = createRecordingHost();
      adapter.attach(host);

      latest().callbacks.onUnavailable(unavailableFrame({ code, terminal }));

      const unavailableEvent = emittedEvents(log).find(
        (event) => event.kind === "doc-unavailable",
      );
      if (
        unavailableEvent === undefined ||
        unavailableEvent.kind !== "doc-unavailable"
      ) {
        throw new Error("expected a doc-unavailable event");
      }
      expect(unavailableEvent.code).toBe(mapped);
      expect(unavailableEvent.terminal).toBe(terminal);
    }
  });

  it("bodyUnavailable covers both terminal:true and terminal:false - the @1 unavailable/retrying tri-state", () => {
    const { factory, latest } = createFakeStreamClientFactory();
    const adapter = createArtifactLaneAdapter(createSources(factory));
    const { host, log } = createRecordingHost();
    adapter.attach(host);

    latest().callbacks.onUnavailable(
      unavailableFrame({ code: "bodyUnavailable", terminal: false }),
    );
    latest().callbacks.onUnavailable(
      unavailableFrame({ code: "bodyUnavailable", terminal: true }),
    );

    const events = emittedEvents(log).filter(
      (event) => event.kind === "doc-unavailable",
    );
    expect(events).toHaveLength(2);
    if (
      events[0]?.kind !== "doc-unavailable" ||
      events[1]?.kind !== "doc-unavailable"
    ) {
      throw new Error("expected two doc-unavailable events");
    }
    expect(events[0].terminal).toBe(false);
    expect(events[1].terminal).toBe(true);
  });

  it("staleAuthorityEpoch emits doc-unavailable AND requestReplacement('authority-epoch-changed')", () => {
    const { factory, latest } = createFakeStreamClientFactory();
    const adapter = createArtifactLaneAdapter(createSources(factory));
    const { host, log } = createRecordingHost();
    adapter.attach(host);

    latest().callbacks.onUnavailable(
      unavailableFrame({ code: "staleAuthorityEpoch", terminal: true }),
    );

    expect(
      emittedEvents(log).some((event) => event.kind === "doc-unavailable"),
    ).toBe(true);
    expect(replacementReasons(log)).toEqual(["authority-epoch-changed"]);
  });

  it("artifactNotFound and bodyUnavailable emit NO requestReplacement", () => {
    for (const code of ["artifactNotFound", "bodyUnavailable"] as const) {
      const { factory, latest } = createFakeStreamClientFactory();
      const adapter = createArtifactLaneAdapter(createSources(factory));
      const { host, log } = createRecordingHost();
      adapter.attach(host);

      latest().callbacks.onUnavailable(
        unavailableFrame({ code, terminal: true }),
      );

      expect(replacementReasons(log)).toEqual([]);
    }
  });
});

// ─── send routing ───────────────────────────────────────────────────────────

describe("createArtifactLaneAdapter - send routing", () => {
  it("after a terminal unavailable, send() answers dropped/lane-terminal", () => {
    const { factory, latest } = createFakeStreamClientFactory();
    const adapter = createArtifactLaneAdapter(createSources(factory));
    const { host } = createRecordingHost();
    adapter.attach(host);

    latest().callbacks.onUnavailable(
      unavailableFrame({ code: "bodyUnavailable", terminal: true }),
    );

    const outcome = adapter.send({
      kind: "awareness",
      frame: new Uint8Array([1]),
    });
    expect(outcome).toEqual({ kind: "dropped", reason: "lane-terminal" });
  });

  it("send() before attach answers dropped/no-transport", () => {
    const { factory } = createFakeStreamClientFactory();
    const adapter = createArtifactLaneAdapter(createSources(factory));

    const outcome = adapter.send({
      kind: "awareness",
      frame: new Uint8Array([1]),
    });
    expect(outcome).toEqual({ kind: "dropped", reason: "no-transport" });
  });

  it("send() after detach() answers dropped/no-transport", () => {
    const { factory } = createFakeStreamClientFactory();
    const adapter = createArtifactLaneAdapter(createSources(factory));
    const { host } = createRecordingHost();
    adapter.attach(host);
    adapter.detach("disposed");

    const outcome = adapter.send({
      kind: "awareness",
      frame: new Uint8Array([1]),
    });
    expect(outcome).toEqual({ kind: "dropped", reason: "no-transport" });
  });

  it("while attached, send() answers sent and routes to the exact client call", () => {
    const { factory, latest } = createFakeStreamClientFactory();
    const adapter = createArtifactLaneAdapter(createSources(factory));
    const { host } = createRecordingHost();
    adapter.attach(host);

    const applyUpdate: ArtifactLaneRequest = {
      kind: "apply-update",
      docGuid: "guid-x",
      update: new Uint8Array([9, 8, 7]),
    };
    expect(adapter.send(applyUpdate)).toEqual({ kind: "sent" });
    expect(latest().client.applyUpdateCalls).toEqual([
      { docGuid: "guid-x", update: new Uint8Array([9, 8, 7]) },
    ]);

    const awareness: ArtifactLaneRequest = {
      kind: "awareness",
      frame: new Uint8Array([1, 2]),
    };
    expect(adapter.send(awareness)).toEqual({ kind: "sent" });
    expect(latest().client.awarenessCalls).toEqual([new Uint8Array([1, 2])]);
  });
});

// ─── resumeOffer ──────────────────────────────────────────────────────────────

describe("createArtifactLaneAdapter - resumeOffer", () => {
  it("is null when readDocSeed() is null", () => {
    const { factory } = createFakeStreamClientFactory();
    const adapter = createArtifactLaneAdapter(
      createSources(factory, () => null),
    );

    expect(adapter.resumeOffer()).toBeNull();
  });

  it("is a doc-seed offer carrying the adapter's OWN construction-time authorityEpoch, never a live read", () => {
    const seed: ArtifactSubscribeSeedOffer = {
      knownDocGuid: "guid-held",
      stateVectorBase64: "sv-held",
    };
    const { factory } = createFakeStreamClientFactory();
    const adapter = createArtifactLaneAdapter(
      createSources(factory, () => seed),
    );

    expect(adapter.resumeOffer()).toEqual({
      kind: "doc-seed",
      authorityEpoch: AUTHORITY_EPOCH,
      knownDocGuid: "guid-held",
      stateVectorBase64: "sv-held",
    });
  });
});

// ─── docAck / awareness decode ────────────────────────────────────────────────

describe("createArtifactLaneAdapter - docAck and awareness decode", () => {
  it("docAck -> doc-coverage-ack with the guid and coverage vector verbatim", () => {
    const { factory, latest } = createFakeStreamClientFactory();
    const adapter = createArtifactLaneAdapter(createSources(factory));
    const { host, log } = createRecordingHost();
    adapter.attach(host);

    latest().callbacks.onDocAck(docAckFrame("guid-1", "sv-coverage"));

    expect(emittedEvents(log)).toEqual([
      {
        kind: "doc-coverage-ack",
        authorityEpoch: AUTHORITY_EPOCH,
        docId: ARTIFACT_ID,
        docGuid: "guid-1",
        coverageStateVectorBase64: "sv-coverage",
      },
    ]);
  });

  it("awareness -> doc-awareness carrying the epoch and NO guid", () => {
    const { factory, latest } = createFakeStreamClientFactory();
    const adapter = createArtifactLaneAdapter(createSources(factory));
    const { host, log } = createRecordingHost();
    adapter.attach(host);

    const bytes = new Uint8Array([5, 6]);
    latest().callbacks.onAwareness(awarenessFrame(), bytes);

    const events = emittedEvents(log);
    expect(events).toEqual([
      {
        kind: "doc-awareness",
        authorityEpoch: AUTHORITY_EPOCH,
        docId: ARTIFACT_ID,
        frame: bytes,
      },
    ]);
    if (events[0] === undefined) throw new Error("expected an event");
    expect("docGuid" in events[0]).toBe(false);
  });

  it("docUpdate decodes to doc-update with the exact guid and bytes", () => {
    const { factory, latest } = createFakeStreamClientFactory();
    const adapter = createArtifactLaneAdapter(createSources(factory));
    const { host, log } = createRecordingHost();
    adapter.attach(host);

    const bytes = new Uint8Array([3, 4]);
    latest().callbacks.onDocUpdate(docUpdateFrame("guid-2"), bytes);

    expect(emittedEvents(log)).toEqual([
      {
        kind: "doc-update",
        authorityEpoch: AUTHORITY_EPOCH,
        docId: ARTIFACT_ID,
        docGuid: "guid-2",
        update: bytes,
      },
    ]);
  });
});

// ─── generation guard ───────────────────────────────────────────────────────

describe("createArtifactLaneAdapter - generation guard", () => {
  it("a frame from a generation retired by detach() is dropped", () => {
    const { factory, latest } = createFakeStreamClientFactory();
    const adapter = createArtifactLaneAdapter(createSources(factory));
    const { host, log } = createRecordingHost();
    adapter.attach(host);

    const stale = latest().callbacks;
    adapter.detach("disposed");
    stale.onDoc(docFrame({}), new Uint8Array([1]));

    expect(log).toEqual([]);
  });

  it("descriptor.laneId is per-artifact", () => {
    const { factory } = createFakeStreamClientFactory();
    const adapter = createArtifactLaneAdapter(createSources(factory));
    expect(adapter.descriptor.laneId).toBe(artifactLaneId(ARTIFACT_ID));
  });
});

// ─── Binary-payload-missing drop, through the REAL ArtifactStreamClient ────

describe("ArtifactStreamClient (real, over a stub IStreamSession) - binary-payload-missing drop", () => {
  class StubStreamSession implements IStreamSession {
    private frameHandler: ServerFrameHandler | null = null;
    private statusHandler: StatusChangeHandler | null = null;
    readonly sentFrames: {
      envelope: StreamFrameEnvelope;
      binary: Uint8Array | null;
    }[] = [];
    closed = false;

    sendClientFrame(
      envelope: StreamFrameEnvelope,
      binaryPayload: Uint8Array | null,
    ): void {
      this.sentFrames.push({ envelope, binary: binaryPayload });
    }
    onServerFrame(handler: ServerFrameHandler): void {
      this.frameHandler = handler;
    }
    onStatusChange(handler: StatusChangeHandler): void {
      this.statusHandler = handler;
    }
    requestReconnect(): void {}
    getNegotiatedSchemaVersion() {
      return null;
    }
    close(): void {
      this.closed = true;
    }
    fireServerFrame(
      envelope: StreamFrameEnvelope,
      binary: Uint8Array | null,
    ): void {
      this.frameHandler?.(envelope, binary);
    }
    fireStatus(
      status: StreamConnectionStatus,
      reason: StreamCloseReason | null,
    ): void {
      this.statusHandler?.(status, reason);
    }
  }

  function createCallbackRecorder(): {
    readonly callbacks: ArtifactStreamCallbacks;
    readonly docCalls: number;
    readonly docUpdateCalls: number;
    readonly awarenessCalls: number;
  } {
    let docCalls = 0;
    let docUpdateCalls = 0;
    let awarenessCalls = 0;
    const callbacks: ArtifactStreamCallbacks = {
      onDoc: () => {
        docCalls += 1;
      },
      onDocUpdate: () => {
        docUpdateCalls += 1;
      },
      onDocAck: () => {},
      onAwareness: () => {
        awarenessCalls += 1;
      },
      onUnavailable: () => {},
      onConnectionStatus: () => {},
    };
    return {
      callbacks,
      get docCalls() {
        return docCalls;
      },
      get docUpdateCalls() {
        return docUpdateCalls;
      },
      get awarenessCalls() {
        return awarenessCalls;
      },
    };
  }

  function createClient(
    session: StubStreamSession,
    callbacks: ArtifactStreamCallbacks,
  ): ArtifactStreamClient {
    const options: ArtifactStreamClientOptions = {
      wsStreamClient: {
        subscribe: () => session,
        subscribeWithParamsProvider: () => session,
        getMethodSchemaVersion: () => null,
      },
      epicId: "epic-1",
      artifactId: ARTIFACT_ID,
      authorityEpoch: AUTHORITY_EPOCH,
      seedOfferProvider: () => null,
      callbacks,
    };
    return new ArtifactStreamClient(options);
  }

  it("a doc frame with a missing binary payload emits nothing", () => {
    const session = new StubStreamSession();
    const recorder = createCallbackRecorder();
    createClient(session, recorder.callbacks);

    session.fireServerFrame(
      {
        kind: "doc",
        authorityEpoch: AUTHORITY_EPOCH,
        artifactId: ARTIFACT_ID,
        docGuid: "guid-1",
        stateVectorBase64: "sv-1",
        hasBinaryPayload: true,
      },
      null,
    );

    expect(recorder.docCalls).toBe(0);
  });

  it("a docUpdate frame with a missing binary payload emits nothing", () => {
    const session = new StubStreamSession();
    const recorder = createCallbackRecorder();
    createClient(session, recorder.callbacks);

    session.fireServerFrame(
      {
        kind: "docUpdate",
        authorityEpoch: AUTHORITY_EPOCH,
        artifactId: ARTIFACT_ID,
        docGuid: "guid-1",
        hasBinaryPayload: true,
      },
      null,
    );

    expect(recorder.docUpdateCalls).toBe(0);
  });

  it("an awareness frame with a missing binary payload emits nothing", () => {
    const session = new StubStreamSession();
    const recorder = createCallbackRecorder();
    createClient(session, recorder.callbacks);

    session.fireServerFrame(
      {
        kind: "awareness",
        authorityEpoch: AUTHORITY_EPOCH,
        artifactId: ARTIFACT_ID,
        hasBinaryPayload: true,
      },
      null,
    );

    expect(recorder.awarenessCalls).toBe(0);
  });
});
