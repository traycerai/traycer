/**
 * The composition's stream factories, driven END TO END through the real proxy.
 *
 * Nothing here fakes the proxy. A wrapper built by `buildProxiedStreamFactories`
 * subscribes on the worker's `IStreamClient`, that open crosses the real
 * `createStreamProxyHost`, and the assertion is on what the RECORDING CLIENT -
 * standing in for the socket, the one thing a suite cannot have - actually saw.
 *
 * That chain is the claim worth pinning. The four wrappers all declare
 * `wsStreamClient: IStreamClient<HostStreamRpcRegistry>`, so the proxy is
 * type-substitutable for the real client; whether it is BEHAVIOURALLY
 * substitutable is what these tests answer.
 */
import { describe, expect, it } from "vitest";
import { createWorkerStreamClient } from "@traycer-clients/shared/replica-runtime/worker/worker-stream-client";
import { createStreamProxyHost } from "@traycer-clients/shared/replica-runtime/worker/stream-proxy-host";
import { createRecordingStreamClient } from "@traycer-clients/shared/replica-runtime/worker/test-support/recording-stream-client";
import type { EpicStreamCallbacks } from "@traycer-clients/shared/host-transport/epic-stream-client";
import type { EpicStateStreamCallbacks } from "@traycer-clients/shared/host-transport/epic-state-stream-client";
import type { EpicStatusStreamCallbacks } from "@traycer-clients/shared/host-transport/epic-status-stream-client";
import type { ArtifactStreamCallbacks } from "@traycer-clients/shared/host-transport/artifact-stream-client";
import { buildProxiedStreamFactories } from "../epic-runtime-composition";

/** Worker client -> real proxy host -> recording socket. No stub between. */
function proxied() {
  const recording = createRecordingStreamClient();
  const rejected: string[] = [];
  const worker = createWorkerStreamClient(
    (event) => host.handle(event),
    (reason) => rejected.push(reason),
  );
  const host = createStreamProxyHost(
    recording.client,
    (event) => {
      switch (event.kind) {
        case "stream/frame":
          worker.deliverFrame(event.frame);
          return;
        case "stream/status":
          worker.deliverStatus(
            event.status.streamId,
            event.status.status,
            event.status.reason,
          );
          return;
        default:
          return;
      }
    },
    (reason) => rejected.push(reason),
  );
  return { recording, worker, host, rejected };
}

/**
 * Per-lane callbacks, each TYPED BY its own contract.
 *
 * A single invented literal covered all four wrappers on the first pass, and
 * three of them never called it - so the fixture named methods that exist
 * nowhere (`onUpdate`, `onStatus`, `onFatal`) and only the lane that actually
 * dispatches caught it. The contracts differ; the fixtures do too.
 */
const LEGACY_CALLBACKS: EpicStreamCallbacks = {
  onSnapshot: () => {},
  onUpdate: () => {},
  onAwareness: () => {},
  onEarlyMeta: () => {},
  onEpicDeleted: () => {},
  onPermissionChanged: () => {},
};

const STATE_CALLBACKS: EpicStateStreamCallbacks = {
  onSnapshot: () => {},
  onDelta: () => {},
  onResumed: () => {},
  onTrustChanged: () => {},
  onConnectionStatus: () => {},
};

const ARTIFACT_CALLBACKS: ArtifactStreamCallbacks = {
  onDoc: () => {},
  onDocUpdate: () => {},
  onDocAck: () => {},
  onAwareness: () => {},
  onUnavailable: () => {},
  onConnectionStatus: () => {},
};

const STATUS_CALLBACKS: EpicStatusStreamCallbacks = {
  onSnapshot: () => {},
  onTransition: () => {},
  onConnectionStatus: () => {},
};

describe("buildProxiedStreamFactories", () => {
  it("opens the legacy arm's subscription on the PROXY", () => {
    const { recording, worker } = proxied();
    const factories = buildProxiedStreamFactories({
      streams: worker.client,
      support: () => "unknown",
      subscribeSupport: () => () => {},
    });

    factories.streamClientFactory("epic-1", LEGACY_CALLBACKS, () => null);

    // The wrapper reached a real session through the real proxy host. Asserting
    // on the recording client rather than on the worker's own bookkeeping is
    // what makes this end-to-end: the worker could open a stream nobody serves
    // and look identical from its own side.
    expect(recording.opened()).toHaveLength(1);
    expect(recording.opened()[0]?.method).toBe("epic.subscribe");
  });

  it("opens all three lanes on the same proxied client", () => {
    const { recording, worker } = proxied();
    const factories = buildProxiedStreamFactories({
      streams: worker.client,
      support: () => "supported",
      subscribeSupport: () => () => {},
    });
    const lanes = factories.laneSelection;
    expect(lanes).not.toBeNull();
    if (lanes === null) return;

    lanes.stateStreamClientFactory("epic-1", STATE_CALLBACKS, () => null);
    lanes.statusStreamClientFactory("epic-1", STATUS_CALLBACKS);
    lanes.artifactStreamClientFactory(
      "epic-1",
      "artifact-1",
      "epoch-1",
      ARTIFACT_CALLBACKS,
      () => null,
    );

    // One client per lane, all multiplexed over ONE proxied client - not three
    // proxy hosts and not three dials.
    expect(recording.opened().map((session) => session.method)).toEqual([
      "epic.state.subscribe",
      "epic.status.subscribe",
      "artifact.subscribe",
    ]);
  });

  it("answers support from the pushed snapshot, with no cast", () => {
    const { worker } = proxied();
    const seen: string[] = [];
    const factories = buildProxiedStreamFactories({
      streams: worker.client,
      support: (method) => {
        seen.push(method);
        return method === "epic.state.subscribe" ? "supported" : "unknown";
      },
      subscribeSupport: () => () => {},
    });

    // On main this read casts the method to the registry's key type. Here it is
    // a lookup in a replicated snapshot: an unknown method answers `"unknown"`,
    // which selection already treats as "not a selection".
    expect(factories.laneSelection?.support("epic.state.subscribe")).toBe(
      "supported",
    );
    expect(factories.laneSelection?.support("not.a.method")).toBe("unknown");
    expect(seen).toEqual(["epic.state.subscribe", "not.a.method"]);
  });

  it("routes a lane's own frames back to the wrapper that opened it", () => {
    const { recording, worker, rejected } = proxied();
    const factories = buildProxiedStreamFactories({
      streams: worker.client,
      support: () => "supported",
      subscribeSupport: () => () => {},
    });
    const statuses: string[] = [];
    factories.laneSelection?.statusStreamClientFactory("epic-1", {
      ...STATUS_CALLBACKS,
      onConnectionStatus: (status) => statuses.push(status),
    });

    recording.opened()[0]?.emitStatus("open", null);

    // Correlation the whole way back: main's session -> proxy host -> bridge
    // event -> the worker's session -> the wrapper's callback.
    expect(statuses).toContain("open");
    expect(rejected).toEqual([]);
  });
});
