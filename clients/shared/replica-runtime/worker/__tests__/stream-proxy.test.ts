/**
 * The stream proxy, driven through BOTH real halves.
 *
 * `createWorkerStreamClient` and `createStreamProxyHost` are the production
 * objects; what is faked is the socket (`createRecordingStreamClient`) and the
 * pipe. So a test here exercises the real correlation, the real params
 * narrowing and the real close semantics against a real serialization boundary.
 */
import { stubMainCallHandlers } from "../test-support/stub-main-call-handlers";
import { describe, expect, it } from "vitest";
import { createWorkerStreamClient } from "../worker-stream-client";
import { createStreamProxyHost } from "../stream-proxy-host";
import {
  EPIC_WORKER_STREAM_METHOD_LIST,
  OPEN_PARAMS_SCHEMA_SOURCES,
  parseStreamProxyFrame,
  STREAM_PROXY_UNKNOWN_METHOD_CODE,
} from "../stream-proxy-protocol";
import { createRecordingStreamClient } from "../test-support/recording-stream-client";
import { createFakeBridgePair } from "../test-support/fake-bridge-pair";
import { stubRuntimeWorkerCallHandlers } from "../test-support/stub-runtime-worker-call-handlers";
import {
  createMainBridgeEndpoint,
  createWorkerBridgeEndpoint,
} from "../bridge-endpoint";
import { hostStreamRpcRegistry } from "@traycer/protocol/host/registry";
import {
  isWorkerToMainFrame,
  MAIN_CALL_KINDS,
  MAIN_TO_WORKER_EVENT_KINDS,
  RUNTIME_BRIDGE_PROTOCOL_VERSION,
  WORKER_TO_MAIN_EVENT_KINDS,
  type MainToWorkerEvent,
} from "../bridge-protocol";

/**
 * Wires the two halves through the REAL bridge pair.
 *
 * An earlier version of this helper handed each side's event straight to the
 * other through a callback. Every pin in this file passed against it - and one
 * of them was asserting about traffic that, in production, was posted into a
 * bridge that had already been disposed. A harness that bypasses the channel
 * cannot observe the channel; it reports on a path the code does not take. So
 * the pipe here is the production pipe, and only the thread is not.
 */
function connect() {
  const recording = createRecordingStreamClient();
  const pair = createFakeBridgePair("sync");
  const toWorker: MainToWorkerEvent[] = [];
  const rejected: string[] = [];

  const workerBridge = createWorkerBridgeEndpoint(
    pair.worker,
    stubRuntimeWorkerCallHandlers({}),
  );
  const worker = createWorkerStreamClient(
    (event, transfer) => {
      workerBridge.emit(event, transfer);
    },
    (reason) => rejected.push(reason),
  );
  const mainBridge = createMainBridgeEndpoint(
    pair.main,
    stubMainCallHandlers({}),
  );
  const host = createStreamProxyHost(
    recording.client,
    (event, transfer) => {
      toWorker.push(event);
      mainBridge.emit(event, transfer);
    },
    (reason) => rejected.push(reason),
  );

  mainBridge.onEvent((event) => {
    host.handle(event);
  });
  workerBridge.onEvent((event) => {
    switch (event.kind) {
      case "stream/frame":
        worker.deliverFrame(event.frame);
        return;
      case "stream/session-version":
        worker.deliverSessionVersion(
          event.version.streamId,
          event.version.version,
        );
        return;
      case "stream/status":
        worker.deliverStatus(
          event.status.streamId,
          event.status.status,
          event.status.reason,
        );
        return;
      case "stream/manifest":
        worker.deliverManifest(event.manifest);
        return;
      default:
        return;
    }
  });

  return { recording, worker, host, toWorker, rejected, mainBridge, pair };
}

describe("the closed method union", () => {
  it("names exactly the four methods the epic's wrappers subscribe", () => {
    // BY NAME, not counted: `toHaveLength(4)` would survive a member being
    // swapped for a different method, and which four is the whole ruling.
    expect([...EPIC_WORKER_STREAM_METHOD_LIST].sort()).toEqual([
      "artifact.subscribe",
      "epic.state.subscribe",
      "epic.status.subscribe",
      "epic.subscribe",
    ]);
  });

  it("parses each method's params with the registry's HIGHEST installed line", () => {
    // The drift this guards is silent by construction. `OPEN_PARAMS_PARSERS`
    // names each contract BY HAND (there is no latest-line accessor for a
    // stream registry). When a method grows a new line, the worker - built from
    // the registry - emits latest-line params while main still parses with the
    // old schema: a strict schema rejects the open, a loose one strips the new
    // field, and NEITHER is a compile error, because `ParamsOf`'s union still
    // contains the old output. `epic.subscribe` is already at @1.3.
    //
    // Identity (`toBe`), not shape: two schemas for adjacent minors can have
    // identical shapes, which is exactly when the drift is most invisible.
    for (const method of EPIC_WORKER_STREAM_METHOD_LIST) {
      const methodRegistry: unknown = hostStreamRpcRegistry[method];
      expect(isRecord(methodRegistry)).toBe(true);
      if (!isRecord(methodRegistry)) continue;

      const highestMajor = highestNumericKey(methodRegistry);
      const line: unknown = methodRegistry[String(highestMajor)];
      expect(isRecord(line)).toBe(true);
      if (!isRecord(line)) continue;

      const versions: unknown = line.versions;
      expect(isRecord(versions)).toBe(true);
      if (!isRecord(versions)) continue;

      const highestMinor = highestNumericKey(versions);
      const entry: unknown = versions[String(highestMinor)];
      expect(isRecord(entry)).toBe(true);
      if (!isRecord(entry)) continue;

      const contract: unknown = entry.contract;
      expect(isRecord(contract)).toBe(true);
      if (!isRecord(contract)) continue;

      expect(OPEN_PARAMS_SCHEMA_SOURCES[method].openRequestSchema).toBe(
        contract.openRequestSchema,
      );
    }
  });
});

describe("the bridge vocabulary and its version", () => {
  it("names every event kind in both directions, beside the version", () => {
    // This pin exists because the version constant FAILED to move when 2c
    // replaced the vocabulary, and no pin could see it: the skew test compares
    // `VERSION - 1` against `VERSION`, so it stays green at any value. A
    // relative pin proves the refusal MECHANISM, never the NUMBER.
    //
    // Nothing can prove a number should have changed. What this does is couple
    // the two: editing either union reddens this test, and the comment the
    // reader lands on is the one telling them to bump. That is a prompt, not a
    // proof, and it is named as such rather than dressed up as coverage.
    expect(RUNTIME_BRIDGE_PROTOCOL_VERSION).toBe(5);
    expect(MAIN_TO_WORKER_EVENT_KINDS).toEqual([
      "bootstrap",
      "current-user",
      "stream/frame",
      "stream/session-version",
      "stream/status",
      "stream/manifest",
      "accounting/demote",
      "shutdown",
    ]);
    expect(WORKER_TO_MAIN_EVENT_KINDS).toEqual([
      "ready",
      "log",
      "projection",
      "stream/open",
      "stream/params",
      "stream/send",
      "stream/reconnect",
      "stream/close",
      "fatal",
      "accounting/books",
      "accounting/settle",
    ]);
  });
});

describe("the one worker->main call", () => {
  it("names exactly one member", () => {
    // BY NAME, not counted. This map went 0 -> 2 -> 0 -> 1 across four
    // rulings; the count alone would have read the same at two of those points
    // while naming entirely different calls.
    expect([...MAIN_CALL_KINDS]).toEqual(["main/write-command"]);
  });

  it("round-trips a classified failure without an Error crossing", async () => {
    const pair = createFakeBridgePair("queued");
    // Main CLASSIFIES; the wire carries the verdict. An `Error` does not
    // survive structured clone, so a handler that threw would reach the worker
    // as a `BridgeCallError` with the classification lost.
    createMainBridgeEndpoint(
      pair.main,
      stubMainCallHandlers({
        "main/write-command": () =>
          Promise.resolve({
            ok: false,
            failure: {
              kind: "unknown-outcome",
              reason: "keyed attempt went ambiguous",
            },
          }),
      }),
    );
    const worker = createWorkerBridgeEndpoint(
      pair.worker,
      stubRuntimeWorkerCallHandlers({}),
    );

    const answered = worker.call("main/write-command", {
      commandId: "cmd-1",
      intent: { kind: "noop" },
    });
    await pair.flush();

    // `unknown-outcome` specifically: a response typed `queued | dropped` would
    // have flattened it, and it is the arm that exists so an ambiguous keyed
    // attempt is NOT retried blindly.
    await expect(answered).resolves.toEqual({
      ok: false,
      failure: {
        kind: "unknown-outcome",
        reason: "keyed attempt went ambiguous",
      },
    });
    worker.dispose();
  });

  it("refuses a queued verdict that lost its retry policy", async () => {
    const pair = createFakeBridgePair("queued");
    const listeners = new Set<(message: unknown) => void>();
    const responder = {
      post(message: unknown): void {
        if (!isWorkerToMainFrame(message) || message.frame !== "main-call") {
          return;
        }
        for (const listener of [...listeners]) {
          listener({
            frame: "main-result",
            callId: message.callId,
            // `boundedRetry` missing. It decides whether a queued command may
            // wait offline without a deadline, so a defaulted one is a command
            // with no retry policy at all.
            result: {
              outcome: "ok",
              value: { ok: false, failure: { kind: "queued", reason: "x" } },
            },
          });
        }
      },
      subscribe(listener: (message: unknown) => void): () => void {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    };
    const worker = createWorkerBridgeEndpoint(
      responder,
      stubRuntimeWorkerCallHandlers({}),
    );

    const pending = worker.call("main/write-command", {
      commandId: "cmd-1",
      intent: null,
    });

    await expect(pending).rejects.toThrow("The main thread answered");
    worker.dispose();
    void pair;
  });
});

describe("stream proxy — opening", () => {
  it("opens a real session per subscribe and narrows its params", () => {
    const { recording, worker } = connect();

    worker.client.subscribe("epic.status.subscribe", { epicId: "epic-1" });

    expect(recording.opened()).toHaveLength(1);
    expect(recording.opened()[0]?.method).toBe("epic.status.subscribe");
    // Narrowed by the contract's own schema on the way through, not passed
    // along as whatever arrived.
    expect(recording.opened()[0]?.initialParams).toEqual({ epicId: "epic-1" });
  });

  it("returns a session SYNCHRONOUSLY, before any reply could arrive", () => {
    const { worker } = connect();
    // The whole reason the worker assigns the `streamId`: `IStreamClient`
    // promises a session now, and there is no `await` at that call site.
    const session = worker.client.subscribe("epic.status.subscribe", {
      epicId: "epic-1",
    });
    expect(typeof session.sendClientFrame).toBe("function");
    expect(session.getNegotiatedSchemaVersion()).toBeNull();
  });

  it("re-reads a params provider on every wire subscribe", () => {
    const { recording, worker } = connect();
    // `resume` is a lane cursor or null, per the contract - the parser rejected
    // a string here, which is the narrowing doing its job on a real schema.
    let resume: null | {
      readonly authorityEpoch: string;
      readonly position: number;
    } = null;

    worker.client.subscribeWithParamsProvider("epic.state.subscribe", () => ({
      epicId: "epic-1",
      resume,
    }));
    const opened = recording.opened()[0];
    expect(opened?.paramsProvider).not.toBeNull();

    // A reconnect re-declare reads the provider again. Main answers from the
    // last value the worker pushed - the provider itself cannot cross, because
    // `WsStreamClient` invokes it synchronously.
    resume = { authorityEpoch: "epoch-1", position: 7 };
    opened?.emitStatus("reconnecting", null);
    expect(opened?.readParams()).toEqual({
      epicId: "epic-1",
      resume: { authorityEpoch: "epoch-1", position: 7 },
    });
  });

  it("refuses a method outside the union with its OWN fatal code", () => {
    const { recording, worker, toWorker } = connect();
    worker.client.subscribe("chat.subscribe", { chatId: "chat-1" });

    // No throw: this runs in a message listener, where a throw is an unhandled
    // error with no route back. And no real session was opened.
    expect(recording.opened()).toHaveLength(0);
    const refusal = toWorker.find((event) => event.kind === "stream/status");
    expect(refusal).toBeDefined();
    if (refusal?.kind === "stream/status") {
      expect(refusal.status.status).toBe("closed");
      expect(
        refusal.status.reason?.kind === "fatalError"
          ? refusal.status.reason.details.code
          : null,
      ).toBe(STREAM_PROXY_UNKNOWN_METHOD_CODE);
      // NOT `INCOMPATIBLE`: that is read by `isMethodIncompatibleClose` as a
      // verdict about the HOST's capability, and would pin a permanent "too
      // old" on a host that serves the method perfectly well.
      expect(
        refusal.status.reason?.kind === "fatalError"
          ? refusal.status.reason.details.code
          : null,
      ).not.toBe("INCOMPATIBLE");
    }
  });
});

describe("stream proxy — versions", () => {
  it("pushes the negotiated version BEFORE the status it belongs to", () => {
    const { recording, worker, toWorker } = connect();
    const session = worker.client.subscribe("epic.status.subscribe", {
      epicId: "epic-1",
    });
    const opened = recording.opened()[0];

    let versionAtOpen: string | null = null;
    session.onStatusChange((status) => {
      if (status === "open") {
        const version = session.getNegotiatedSchemaVersion();
        versionAtOpen =
          version === null ? null : `${version.major}.${version.minor}`;
      }
    });

    opened?.setNegotiatedVersion({ major: 1, minor: 2 });
    opened?.emitStatus("open", null);

    // The ordering is the point: a worker reacting to `open` must already read
    // the version negotiated FOR that open, not the previous one or null.
    expect(versionAtOpen).toBe("1.2");
    const kinds = toWorker.map((event) => event.kind);
    expect(kinds.indexOf("stream/session-version")).toBeLessThan(
      kinds.indexOf("stream/status"),
    );
  });

  it("re-pushes the client-wide manifest and answers the new version", () => {
    const { worker } = connect();
    const heard: number[] = [];
    worker.subscribeManifest(() => heard.push(1));

    worker.deliverManifest({
      methodVersions: [
        { method: "epic.subscribe", version: { major: 1, minor: 1 } },
      ],
      methodSupport: [{ method: "epic.subscribe", support: "supported" }],
      docArm: null,
    });
    expect(worker.client.getMethodSchemaVersion("epic.subscribe")).toEqual({
      major: 1,
      minor: 1,
    });

    // A host restart heals through `reconcileMethodSchemaVersion`, so the
    // manifest is re-pushed. A worker holding the previous incarnation's
    // version would gate an additive minor-line feature on the wrong answer.
    worker.deliverManifest({
      methodVersions: [
        { method: "epic.subscribe", version: { major: 1, minor: 3 } },
      ],
      methodSupport: [{ method: "epic.subscribe", support: "supported" }],
      docArm: null,
    });
    expect(worker.client.getMethodSchemaVersion("epic.subscribe")).toEqual({
      major: 1,
      minor: 3,
    });
    expect(heard).toHaveLength(2);
  });
});

describe("stream proxy — messages for something that is gone", () => {
  it("drops a frame and a status for a stream the worker has closed", () => {
    const { recording, worker } = connect();
    const session = worker.client.subscribe("epic.status.subscribe", {
      epicId: "epic-1",
    });
    const frames: unknown[] = [];
    session.onServerFrame((envelope) => frames.push(envelope));
    const opened = recording.opened()[0];

    session.close();

    // A frame can be in flight when a session closes. Silence, not a throw:
    // this runs in a `message` listener.
    expect(() => {
      opened?.emitFrame({ kind: "update", hasBinaryPayload: false }, null);
      opened?.emitStatus("closed", { kind: "caller" });
    }).not.toThrow();
    expect(frames).toHaveLength(0);
  });

  it("drops a send and a close for a stream main no longer holds", () => {
    const { recording, host } = connect();

    // Never opened on this host - an older worker generation still draining.
    expect(
      host.handle({
        kind: "stream/send",
        frame: {
          streamId: 99,
          envelope: { kind: "update", hasBinaryPayload: false },
          binaryPayload: null,
        },
      }),
    ).toBe(false);
    expect(
      host.handle({ kind: "stream/close", stream: { streamId: 99 } }),
    ).toBe(false);
    expect(recording.opened()).toHaveLength(0);
  });
});

describe("stream proxy — payload validation on receive", () => {
  it("accepts bytes that crossed a realm, and an explicit null", () => {
    // `instanceof Uint8Array` would REJECT the first of these under jsdom, where
    // the clone arrives from Node's realm while the module's binding is jsdom's.
    // The check reads an internal slot and the type's own tag instead.
    for (const payload of [Uint8Array.from([1, 2, 3]), null]) {
      const parsed = parseStreamProxyFrame({
        streamId: 1,
        envelope: { kind: "update", hasBinaryPayload: payload !== null },
        binaryPayload: payload,
      });
      expect(parsed.ok).toBe(true);
    }
  });

  it.each([
    ["DataView", new DataView(new ArrayBuffer(4))],
    ["Int16Array", Int16Array.from([1, 2])],
  ])("rejects a %s with a named reason", (_label, payload) => {
    // Both pass `ArrayBuffer.isView`; only the tag separates them. Handed to a
    // consumer expecting Yjs bytes, either produces a decode failure far from
    // this boundary.
    const parsed = parseStreamProxyFrame({
      streamId: 1,
      envelope: { kind: "update", hasBinaryPayload: true },
      binaryPayload: payload,
    });
    expect(parsed.ok).toBe(false);
    expect(parsed.ok ? "" : parsed.reason).toContain("binaryPayload");
  });

  it("drops a bad payload on BOTH receive paths, naming the reason", () => {
    const { pair, rejected } = connect();
    // Entered through the pair's UNTYPED inlet - `post(message: unknown, …)` -
    // which is the same `unknown` a real `message` listener sees.
    //
    // Handing this to `host.handle(...)` or `worker.deliverFrame(...)` does not
    // compile, and that is the contract working rather than an obstacle: those
    // parameters are `StreamProxyFrame`, so a frame with a `DataView` payload
    // cannot be constructed as one. A negative test has to be BORN `unknown`;
    // casting it into shape would assert the very thing under test.
    const bad = {
      streamId: 1,
      envelope: { kind: "update", hasBinaryPayload: true },
      binaryPayload: new DataView(new ArrayBuffer(4)),
    };

    // main receive path: the worker sends
    pair.worker.post(
      { frame: "event", event: { kind: "stream/send", frame: bad } },
      [],
    );
    // worker receive path: main delivers
    pair.main.post(
      { frame: "event", event: { kind: "stream/frame", frame: bad } },
      [],
    );

    expect(rejected).toHaveLength(2);
    expect(rejected[0]).toContain("stream/send rejected");
    expect(rejected[1]).toContain("stream/frame rejected");
  });
});

describe("stream proxy — disposal", () => {
  it("closes every real session, once each, and ignores later traffic", () => {
    const { recording, worker, host, toWorker } = connect();
    worker.client.subscribe("epic.status.subscribe", { epicId: "epic-1" });
    worker.client.subscribe("epic.status.subscribe", { epicId: "epic-2" });
    worker.client.subscribe("epic.status.subscribe", { epicId: "epic-3" });
    expect(host.openCount()).toBe(3);

    host.dispose();
    host.dispose();

    // N opened, N closed, ONCE each: a total alone cannot tell three sessions
    // closed once from one session closed three times.
    expect(recording.closedCount()).toBe(3);
    for (const session of recording.opened()) {
      expect(session.closeCount()).toBe(1);
    }
    expect(host.openCount()).toBe(0);
    // Each session was TOLD, not merely closed. On the detach-keep-replica
    // path the worker survives its transport, and a stream that just goes
    // quiet is indistinguishable from a slow host.
    const closes = toWorker.filter(
      (event) =>
        event.kind === "stream/status" && event.status.status === "closed",
    );
    expect(closes).toHaveLength(3);
    // A frame arriving after disposal hits the same drop rule.
    expect(
      host.handle({
        kind: "stream/send",
        frame: {
          streamId: 1,
          envelope: { kind: "update", hasBinaryPayload: false },
          binaryPayload: null,
        },
      }),
    ).toBe(false);
  });

  it("closes the worker's own sessions and tells main about each", () => {
    const { recording, worker } = connect();
    worker.client.subscribe("epic.status.subscribe", { epicId: "epic-1" });
    worker.client.subscribe("epic.status.subscribe", { epicId: "epic-2" });

    worker.disposeAll();

    expect(recording.closedCount()).toBe(2);
  });
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * The highest numeric key of a registry level.
 *
 * Walked rather than read off a field, because the point of this pin is to
 * agree with the registry as it IS - a helper that trusted `latestMinor` would
 * be trusting the same declaration the drift can move.
 */
function highestNumericKey(record: Record<string, unknown>): number {
  return Object.keys(record)
    .map((key) => Number(key))
    .filter((key) => Number.isInteger(key))
    .reduce((highest, key) => (key > highest ? key : highest), -1);
}
