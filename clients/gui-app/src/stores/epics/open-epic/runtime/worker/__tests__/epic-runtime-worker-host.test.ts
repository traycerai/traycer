import { describe, expect, it, vi } from "vitest";
import {
  createMainBridgeEndpoint,
  type MainBridgeEndpoint,
} from "@traycer-clients/shared/replica-runtime/worker/bridge-endpoint";
import {
  createFakeBridgePair,
  type FakeBridgePair,
} from "@traycer-clients/shared/replica-runtime/worker/test-support/fake-bridge-pair";
import {
  isWorkerToMainFrame,
  RUNTIME_BRIDGE_PROTOCOL_VERSION,
  type WorkerToMainEvent,
} from "@traycer-clients/shared/replica-runtime/worker/bridge-protocol";
import {
  startEpicRuntimeWorkerHost,
  type EpicRuntimeWorkerHost,
  type EpicRuntimeWorkerCore,
} from "../epic-runtime-worker-host";

interface HostFixture {
  readonly pair: FakeBridgePair;
  readonly main: MainBridgeEndpoint;
  readonly host: EpicRuntimeWorkerHost;
}

function createFixture(): HostFixture {
  const pair = createFakeBridgePair("sync");
  const host = startEpicRuntimeWorkerHost(pair.worker);
  const main = createMainBridgeEndpoint(pair.main);
  return { pair, main, host };
}

function workerEvents(pair: FakeBridgePair): WorkerToMainEvent[] {
  return pair.fromWorker.flatMap((post) => {
    if (!isWorkerToMainFrame(post.delivered)) return [];
    return post.delivered.frame === "event" ? [post.delivered.event] : [];
  });
}

function bootstrap(protocolVersion: number): {
  readonly kind: "bootstrap";
  readonly bootstrap: {
    readonly protocolVersion: number;
    readonly windowLabel: string;
  };
} {
  return {
    kind: "bootstrap",
    bootstrap: { protocolVersion, windowLabel: "test-window" },
  };
}

/**
 * A core with the fail-closed no-core answers, overridable per test.
 *
 * One helper rather than a literal per test, and that is the point:
 * `EpicRuntimeWorkerCore` MIRRORS the protocol's call kinds, so it grows every
 * time a call is added — and five separate literals meant five separate
 * compile errors the moment `body/*` landed. A single construction site turns
 * the next such addition into one failure in one place.
 */
function stubCore(
  overrides: Partial<EpicRuntimeWorkerCore>,
): EpicRuntimeWorkerCore {
  const base: EpicRuntimeWorkerCore = {
    readAttachmentBytes: () => Promise.resolve(null),
    materializeBody: () => Promise.resolve(null),
    // Refused, never accepted: an unowned `true` tells the main thread to drop
    // a document whose bytes nothing stored.
    demoteBody: () => Promise.resolve({ accepted: false, settledBytes: 0 }),
    dispose: () => {},
  };
  return { ...base, ...overrides };
}

describe("startEpicRuntimeWorkerHost", () => {
  it("answers one ready event for a matching bootstrap", () => {
    const { pair, main, host } = createFixture();

    main.emit(bootstrap(RUNTIME_BRIDGE_PROTOCOL_VERSION), []);

    const events = workerEvents(pair);
    expect(events.filter((event) => event.kind === "ready")).toHaveLength(1);
    expect(events.filter((event) => event.kind === "fatal")).toHaveLength(0);
    host.shutdown();
    main.dispose();
  });

  it("emits fatal and no ready event for a mismatched bootstrap", () => {
    const { pair, main, host } = createFixture();

    main.emit(bootstrap(RUNTIME_BRIDGE_PROTOCOL_VERSION + 1), []);

    const events = workerEvents(pair);
    expect(events.filter((event) => event.kind === "fatal")).toHaveLength(1);
    expect(events.filter((event) => event.kind === "ready")).toHaveLength(0);
    host.shutdown();
    main.dispose();
  });

  it("holds a bearer push received before bootstrap and clears it on absent", async () => {
    const { main, host } = createFixture();

    main.emit(
      {
        kind: "bearer",
        bearer: { state: "present", token: "token", userId: "user-1" },
      },
      [],
    );
    await expect(main.call("bearer/probe", {}, [])).resolves.toEqual({
      state: "present",
      userId: "user-1",
    });

    // The handshake arriving afterwards must not disturb what is held. The
    // spawner sends bootstrap first in production, so a holder that reset on
    // bootstrap would look fine there and lose the credential only in the
    // ordering nobody exercises.
    main.emit(
      {
        kind: "bootstrap",
        bootstrap: {
          protocolVersion: RUNTIME_BRIDGE_PROTOCOL_VERSION,
          windowLabel: "window-1",
        },
      },
      [],
    );
    await expect(main.call("bearer/probe", {}, [])).resolves.toEqual({
      state: "present",
      userId: "user-1",
    });

    main.emit({ kind: "bearer", bearer: { state: "absent" } }, []);
    await expect(main.call("bearer/probe", {}, [])).resolves.toEqual({
      state: "absent",
    });
    host.shutdown();
    main.dispose();
  });

  it("answers attachment reads with null before a core is installed", async () => {
    const { main, host } = createFixture();

    await expect(
      main.call("attachment/read", { hash: "missing" }, []),
    ).resolves.toEqual({ bytes: null });
    host.shutdown();
    main.dispose();
  });

  it("copies a partial attachment view before transferring it", async () => {
    const { pair, main, host } = createFixture();
    const buffer = new ArrayBuffer(8);
    const fullView = new Uint8Array(buffer);
    fullView.set([0, 1, 2, 3, 4, 5, 6, 7]);
    const partialView = new Uint8Array(buffer, 2, 3);

    host.installCore(
      stubCore({ readAttachmentBytes: async () => partialView }),
    );

    // Asserted on what the CALLER receives, not on the frame in transit. The
    // frame is the same evidence either way, but a caller that gets a
    // rejection where it should get bytes is the failure a frame-level
    // assertion cannot see - and this test was briefly written that way,
    // because the response parser used `instanceof Uint8Array` and jsdom
    // hands the clone back from Node's realm.
    const answer = await main.call("attachment/read", { hash: "hash" }, []);
    expect(answer.bytes).not.toBeNull();
    expect(answer.bytes === null ? [] : [...answer.bytes]).toEqual([2, 3, 4]);

    const post = pair.fromWorker.at(-1);
    expect(post?.transferCount).toBe(1);
    // Three bytes handed over, not the eight-byte buffer they are a window on.
    expect(post?.transferredByteLengths).toEqual([3]);
    // And the core's own view over that buffer still reads - transferring the
    // whole buffer would have detached it to zero on this side.
    expect(fullView.byteLength).toBe(8);
    expect([...fullView]).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    host.shutdown();
    main.dispose();
  });

  it("disposes the previous core when installing a replacement", () => {
    const { main, host } = createFixture();
    const firstDispose = vi.fn();
    const secondDispose = vi.fn();
    const core = stubCore({ dispose: firstDispose });
    const replacement = stubCore({ dispose: secondDispose });

    host.installCore(core);
    host.installCore(replacement);

    expect(firstDispose).toHaveBeenCalledTimes(1);
    expect(secondDispose).not.toHaveBeenCalled();
    host.shutdown();
    main.dispose();
  });

  it("shuts down idempotently, disposes the core, and ignores later events", () => {
    const { pair, main, host } = createFixture();
    const dispose = vi.fn();
    host.installCore(stubCore({ dispose }));

    host.shutdown();
    host.shutdown();
    expect(dispose).toHaveBeenCalledTimes(1);
    const workerPosts = pair.fromWorker.length;
    main.emit(bootstrap(RUNTIME_BRIDGE_PROTOCOL_VERSION), []);
    expect(pair.fromWorker).toHaveLength(workerPosts);
    main.dispose();
  });

  it("shuts down when a shutdown event arrives from the main side", () => {
    const { pair, main, host } = createFixture();
    const dispose = vi.fn();
    host.installCore(stubCore({ dispose }));

    main.emit({ kind: "shutdown" }, []);
    expect(dispose).toHaveBeenCalledTimes(1);
    const workerPosts = pair.fromWorker.length;
    main.emit(bootstrap(RUNTIME_BRIDGE_PROTOCOL_VERSION), []);
    expect(pair.fromWorker).toHaveLength(workerPosts);
    host.shutdown();
    main.dispose();
  });
});
