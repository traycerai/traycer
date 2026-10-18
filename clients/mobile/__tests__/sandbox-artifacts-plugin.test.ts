/**
 * `MobileSandboxArtifacts` properties, with the native `SandboxArtifactsPlugin`
 * faked at the package boundary (constructed directly, never through
 * `registerPlugin`) - the same style as `push-registration.test.ts`.
 *
 * The claims under test: `register`/`unregister` await and tear down the
 * native listener pair correctly and reject an invalid mount id outright; an
 * incoming request for an unmounted (or unsubscribed) mount is auto-answered
 * 404/"unmounted" without ever reaching a handler; `unregister` answers only
 * ITS mount's own pending requests the same way; `respond` base64-encodes a
 * bytes reply (round-tripping bytes outside the ASCII range) and refuses one
 * over the 4 MiB native span bound with a 503 instead of sending it; and a
 * cancelled or already-answered request's late `respond()` is a silent
 * no-op that never reaches the native plugin at all.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PluginListenerHandle } from "@capacitor/core";
import type {
  SandboxArtifactCancel,
  SandboxArtifactRequest,
} from "@traycer-clients/shared/platform/sandbox-artifacts";
import {
  MobileSandboxArtifacts,
  type NativeArtifactReply,
  type SandboxArtifactsPlugin,
} from "../src/sandbox-artifacts-plugin";

type ListenerEvent = "request" | "cancel";

class Deferred<T> {
  readonly promise: Promise<T>;
  resolve: (value: T) => void = () => undefined;
  reject: (reason: Error) => void = () => undefined;
  constructor() {
    this.promise = new Promise<T>((resolve, reject) => {
      this.resolve = resolve;
      this.reject = reject;
    });
  }
}

/**
 * A class rather than an object literal: `addListener`'s single broad-param
 * implementation satisfies the slice's overloads only under method-position
 * bivariance, which strictFunctionTypes reserves for method declarations
 * (same reasoning as `FakePlugin` in `push-registration.test.ts`).
 */
class FakeNativePlugin implements SandboxArtifactsPlugin {
  /**
   * Captured the moment `addListener` is called - mirrors Capacitor's own
   * promise, which acknowledges a callback id, not that native has actually
   * installed anything yet. Never read by `emit*`.
   */
  private stagedRequestHandler:
    | ((request: SandboxArtifactRequest) => void)
    | null = null;
  private stagedCancelHandler:
    | ((cancel: SandboxArtifactCancel) => void)
    | null = null;
  /**
   * What `emit*` actually calls. Stays `null` - dropping every event, same
   * as a native side that has not registered yet - until `ready()` itself
   * resolves, which is the only thing that promotes the staged pair live.
   */
  private activeRequestHandler:
    | ((request: SandboxArtifactRequest) => void)
    | null = null;
  private activeCancelHandler:
    | ((cancel: SandboxArtifactCancel) => void)
    | null = null;
  readonly respond = vi.fn(
    async (_reply: NativeArtifactReply): Promise<void> => undefined,
  );
  readonly removeRequestListener = vi.fn(async (): Promise<void> => undefined);
  readonly removeCancelListener = vi.fn(async (): Promise<void> => undefined);

  requestAttachCount = 0;
  cancelAttachCount = 0;
  readyCallCount = 0;
  /** Set to hold the next addListener("request"/"cancel") call open. */
  pendingRequestAttach: Deferred<PluginListenerHandle> | null = null;
  pendingCancelAttach: Deferred<PluginListenerHandle> | null = null;
  /**
   * Set to hold the next `ready()` call open: the native side can resolve
   * `addListener` right away while its own listener installs are still in
   * flight, so a register() caller must not treat an attached promise as a
   * live, event-delivering subscription until this separate ack lands.
   */
  pendingReady: Deferred<void> | null = null;
  /** Set to make the NEXT addListener("request"/"cancel")/ready() call reject once. */
  rejectNextRequestAttach: Error | null = null;
  rejectNextCancelAttach: Error | null = null;
  rejectNextReady: Error | null = null;

  ready(): Promise<void> {
    this.readyCallCount += 1;
    if (this.pendingReady !== null) {
      // Activate only once the held ack actually resolves, never earlier -
      // and never on a rejection, which `.then` here forwards untouched.
      return this.pendingReady.promise.then(() => this.activate());
    }
    if (this.rejectNextReady !== null) {
      const error = this.rejectNextReady;
      this.rejectNextReady = null;
      return Promise.reject(error);
    }
    this.activate();
    return Promise.resolve();
  }

  /** Promotes the staged pair to live: native has now actually registered. */
  private activate(): void {
    this.activeRequestHandler = this.stagedRequestHandler;
    this.activeCancelHandler = this.stagedCancelHandler;
  }

  addListener(
    event: "request",
    handler: (request: SandboxArtifactRequest) => void,
  ): Promise<PluginListenerHandle>;
  addListener(
    event: "cancel",
    handler: (cancel: SandboxArtifactCancel) => void,
  ): Promise<PluginListenerHandle>;
  addListener(
    event: ListenerEvent,
    handler:
      | ((request: SandboxArtifactRequest) => void)
      | ((cancel: SandboxArtifactCancel) => void),
  ): Promise<PluginListenerHandle> {
    if (event === "request") {
      this.requestAttachCount += 1;
      this.stagedRequestHandler = handler as (
        request: SandboxArtifactRequest,
      ) => void;
      if (this.pendingRequestAttach !== null) return this.pendingRequestAttach.promise;
      if (this.rejectNextRequestAttach !== null) {
        const error = this.rejectNextRequestAttach;
        this.rejectNextRequestAttach = null;
        return Promise.reject(error);
      }
      return Promise.resolve({ remove: this.removeRequestListener });
    }
    this.cancelAttachCount += 1;
    this.stagedCancelHandler = handler as (cancel: SandboxArtifactCancel) => void;
    if (this.pendingCancelAttach !== null) return this.pendingCancelAttach.promise;
    if (this.rejectNextCancelAttach !== null) {
      const error = this.rejectNextCancelAttach;
      this.rejectNextCancelAttach = null;
      return Promise.reject(error);
    }
    return Promise.resolve({ remove: this.removeCancelListener });
  }

  /**
   * Plays the native side of an incoming artifact span request. Throws, same
   * as a request that never arrives at all, when native has not actually
   * activated the listener yet - a staged-but-inactive handler drops the
   * event exactly as a not-yet-registered native listener would.
   */
  emitRequest(request: SandboxArtifactRequest): void {
    if (this.activeRequestHandler === null) {
      throw new Error("native request listener is not active yet");
    }
    this.activeRequestHandler(request);
  }

  /** Plays the native side of the page cancelling an in-flight request. */
  emitCancel(cancel: SandboxArtifactCancel): void {
    if (this.activeCancelHandler === null) {
      throw new Error("native cancel listener is not active yet");
    }
    this.activeCancelHandler(cancel);
  }
}

async function flush(): Promise<void> {
  for (let i = 0; i < 4; i++) {
    await Promise.resolve();
  }
}

function decodeBase64Bytes(base64: string): Uint8Array {
  return Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
}

/** Registers one mount with no held promises, for tests not about registration itself. */
async function registeredBridge(
  mountId: string,
  platform: "ios" | "android",
): Promise<{ plugin: FakeNativePlugin; bridge: MobileSandboxArtifacts }> {
  const plugin = new FakeNativePlugin();
  const bridge = new MobileSandboxArtifacts(plugin, platform);
  await bridge.register(mountId);
  return { plugin, bridge };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("MobileSandboxArtifacts, policySource and artifactOrigin by platform", () => {
  it("names iOS's own custom scheme as the policy source, and builds a matching traycer-artifact:// origin", () => {
    const bridge = new MobileSandboxArtifacts(new FakeNativePlugin(), "ios");
    expect(bridge.policySource).toBe("traycer-artifact:");
    expect(bridge.artifactOrigin({ artifactId: "myart", mountId: "m1" })).toBe(
      "traycer-artifact://artifact-myart--m1",
    );
  });

  it("needs no extra CSP source on Android, and builds the reserved https origin instead", () => {
    const bridge = new MobileSandboxArtifacts(
      new FakeNativePlugin(),
      "android",
    );
    expect(bridge.policySource).toBeNull();
    expect(bridge.artifactOrigin({ artifactId: "myart", mountId: "m1" })).toBe(
      "https://artifact-myart--m1.traycer-artifact.invalid",
    );
  });
});

describe("MobileSandboxArtifacts.register", () => {
  it("rejects a mount id outside [a-z0-9]+ without ever touching the plugin", async () => {
    const plugin = new FakeNativePlugin();
    const bridge = new MobileSandboxArtifacts(plugin, "ios");

    await expect(bridge.register("Mount-1")).rejects.toThrow(
      "Invalid artifact mount id",
    );
    await expect(bridge.register("")).rejects.toThrow(
      "Invalid artifact mount id",
    );
    expect(plugin.requestAttachCount).toBe(0);
    expect(plugin.cancelAttachCount).toBe(0);
  });

  it("does not resolve until both the request AND the cancel listener have attached", async () => {
    const plugin = new FakeNativePlugin();
    const cancelAttach = new Deferred<PluginListenerHandle>();
    plugin.pendingCancelAttach = cancelAttach;
    const bridge = new MobileSandboxArtifacts(plugin, "ios");

    let resolved = false;
    const pending = bridge.register("mount1").then(() => {
      resolved = true;
    });

    await flush();
    expect(plugin.requestAttachCount).toBe(1);
    expect(plugin.cancelAttachCount).toBe(1);
    expect(resolved).toBe(false);

    cancelAttach.resolve({ remove: plugin.removeCancelListener });
    await pending;
    expect(resolved).toBe(true);
  });

  it("does not resolve until the native readiness ack, even once both listeners have already attached", async () => {
    const plugin = new FakeNativePlugin();
    const readyAck = new Deferred<void>();
    plugin.pendingReady = readyAck;
    const bridge = new MobileSandboxArtifacts(plugin, "ios");
    const received: SandboxArtifactRequest[] = [];
    bridge.onRequest((request) => received.push(request));

    let resolved = false;
    const pending = bridge.register("mount1").then(() => {
      resolved = true;
    });

    // Capacitor's addListener promise acknowledges a callback id, not native
    // registration: both settle right away while the readiness ack is held,
    // and register() must not treat that as "live" yet.
    await flush();
    expect(plugin.requestAttachCount).toBe(1);
    expect(plugin.cancelAttachCount).toBe(1);
    expect(plugin.readyCallCount).toBe(1);
    expect(resolved).toBe(false);

    // Native genuinely has not registered anything yet: an event this early
    // must drop (never silently queue for later), exactly as the real OS
    // could not have delivered one either.
    expect(() =>
      plugin.emitRequest({
        requestId: "too-early",
        mountId: "mount1",
        path: "a.txt",
        offset: 0,
        length: 1,
      }),
    ).toThrow("native request listener is not active yet");

    readyAck.resolve();
    await pending;
    expect(resolved).toBe(true);

    // No gap between register() resolving and the native side being able to
    // deliver: the very first event after resolution must land, with no loss.
    plugin.emitRequest({
      requestId: "req-1",
      mountId: "mount1",
      path: "a.txt",
      offset: 0,
      length: 1,
    });
    expect(received).toHaveLength(1);
  });

  it("shares one listener pair across several mounts, attaching only once", async () => {
    const plugin = new FakeNativePlugin();
    const bridge = new MobileSandboxArtifacts(plugin, "ios");

    await bridge.register("mounta");
    await bridge.register("mountb");

    expect(plugin.requestAttachCount).toBe(1);
    expect(plugin.cancelAttachCount).toBe(1);
  });

  it("tears down the request listener and retries on the next register() when the cancel listener fails to attach", async () => {
    const plugin = new FakeNativePlugin();
    plugin.rejectNextCancelAttach = new Error("no cancel support");
    const bridge = new MobileSandboxArtifacts(plugin, "ios");

    await expect(bridge.register("mount1")).rejects.toThrow(
      "no cancel support",
    );
    expect(plugin.removeRequestListener).toHaveBeenCalledTimes(1);

    // A later attempt, now that native can attach the cancel listener, must
    // retry rather than being stuck on the first failure forever.
    await expect(bridge.register("mount1")).resolves.toBeUndefined();
    expect(plugin.requestAttachCount).toBe(2);
    expect(plugin.cancelAttachCount).toBe(2);
  });

  it("tears down BOTH listeners and retries when the native readiness ack fails, now that both had already attached", async () => {
    const plugin = new FakeNativePlugin();
    plugin.rejectNextReady = new Error("native side never signaled ready");
    const bridge = new MobileSandboxArtifacts(plugin, "ios");

    await expect(bridge.register("mount1")).rejects.toThrow(
      "native side never signaled ready",
    );
    expect(plugin.removeRequestListener).toHaveBeenCalledTimes(1);
    expect(plugin.removeCancelListener).toHaveBeenCalledTimes(1);

    // A later attempt, now that native acks readiness, must retry cleanly.
    await expect(bridge.register("mount1")).resolves.toBeUndefined();
    expect(plugin.requestAttachCount).toBe(2);
    expect(plugin.cancelAttachCount).toBe(2);
    expect(plugin.readyCallCount).toBe(2);
  });

  it("removes the failed mount id, so a request for it is never dispatched even after a later successful register", async () => {
    const plugin = new FakeNativePlugin();
    plugin.rejectNextRequestAttach = new Error("no plugin bridge");
    const bridge = new MobileSandboxArtifacts(plugin, "ios");

    await expect(bridge.register("mount1")).rejects.toThrow(
      "no plugin bridge",
    );

    // Retry succeeds and re-mounts "mount1" for real this time.
    await bridge.register("mount1");
    bridge.onRequest(() => undefined);
    plugin.emitRequest({
      requestId: "req-1",
      mountId: "mount1",
      path: "a.txt",
      offset: 0,
      length: 1,
    });
    // Reaches the (now live) handler, not an auto-404 - proof the earlier
    // failed attempt left no stale "mounted" state behind either way.
    expect(plugin.respond).not.toHaveBeenCalled();
  });
});

describe("MobileSandboxArtifacts, incoming requests", () => {
  it("auto-answers 404/unmounted for a request whose mount id was never registered", async () => {
    const { plugin, bridge } = await registeredBridge("mount1", "ios");
    bridge.onRequest(() => undefined);

    plugin.emitRequest({
      requestId: "req-1",
      mountId: "never-mounted",
      path: "a.txt",
      offset: 0,
      length: 5,
    });

    expect(plugin.respond).toHaveBeenCalledWith({
      requestId: "req-1",
      kind: "unavailable",
      status: 404,
      reason: "unmounted",
    });
  });

  it("auto-answers 404/unmounted when the mount is live but nothing has subscribed to onRequest yet", async () => {
    const { plugin } = await registeredBridge("mount1", "ios");
    // Deliberately no `bridge.onRequest(...)` call at all.

    plugin.emitRequest({
      requestId: "req-1",
      mountId: "mount1",
      path: "a.txt",
      offset: 0,
      length: 5,
    });

    expect(plugin.respond).toHaveBeenCalledWith({
      requestId: "req-1",
      kind: "unavailable",
      status: 404,
      reason: "unmounted",
    });
  });

  it("dispatches a request for a mounted, subscribed mount to every onRequest handler, unanswered", async () => {
    const { plugin, bridge } = await registeredBridge("mount1", "ios");
    const receivedA: SandboxArtifactRequest[] = [];
    const receivedB: SandboxArtifactRequest[] = [];
    bridge.onRequest((request) => receivedA.push(request));
    bridge.onRequest((request) => receivedB.push(request));

    const request: SandboxArtifactRequest = {
      requestId: "req-1",
      mountId: "mount1",
      path: "a.txt",
      offset: 0,
      length: 5,
    };
    plugin.emitRequest(request);

    expect(receivedA).toEqual([request]);
    expect(receivedB).toEqual([request]);
    expect(plugin.respond).not.toHaveBeenCalled();
  });

  it("stops notifying a disposed onRequest subscription, falling back to auto-404 once no handler is left", async () => {
    const { plugin, bridge } = await registeredBridge("mount1", "ios");
    const received: SandboxArtifactRequest[] = [];
    const subscription = bridge.onRequest((request) => received.push(request));

    plugin.emitRequest({
      requestId: "req-1",
      mountId: "mount1",
      path: "a.txt",
      offset: 0,
      length: 1,
    });
    subscription.dispose();
    plugin.emitRequest({
      requestId: "req-2",
      mountId: "mount1",
      path: "a.txt",
      offset: 0,
      length: 1,
    });

    expect(received).toHaveLength(1);
    expect(plugin.respond).toHaveBeenCalledWith({
      requestId: "req-2",
      kind: "unavailable",
      status: 404,
      reason: "unmounted",
    });
  });
});

describe("MobileSandboxArtifacts.unregister", () => {
  it("answers only the unregistered mount's own pending requests, leaving another live mount's alone", async () => {
    const plugin = new FakeNativePlugin();
    const bridge = new MobileSandboxArtifacts(plugin, "ios");
    await bridge.register("mounta");
    await bridge.register("mountb");
    bridge.onRequest(() => undefined);
    plugin.emitRequest({
      requestId: "req-a",
      mountId: "mounta",
      path: "a.txt",
      offset: 0,
      length: 1,
    });
    plugin.emitRequest({
      requestId: "req-b",
      mountId: "mountb",
      path: "b.txt",
      offset: 0,
      length: 1,
    });
    plugin.respond.mockClear();

    await bridge.unregister("mounta");

    expect(plugin.respond).toHaveBeenCalledTimes(1);
    expect(plugin.respond).toHaveBeenCalledWith({
      requestId: "req-a",
      kind: "unavailable",
      status: 404,
      reason: "unmounted",
    });

    // mountb's pending request is untouched: it can still be answered normally.
    plugin.respond.mockClear();
    await bridge.respond({
      requestId: "req-b",
      kind: "bytes",
      bytes: new TextEncoder().encode("B"),
      offset: 0,
      totalBytes: 1,
      mediaType: "text/plain",
    });
    expect(plugin.respond).toHaveBeenCalledWith(
      expect.objectContaining({ requestId: "req-b", kind: "bytes" }),
    );
  });

  it("removes the mount itself, so a later request for it is auto-answered as unmounted again", async () => {
    const { plugin, bridge } = await registeredBridge("mount1", "ios");
    bridge.onRequest(() => undefined);
    await bridge.unregister("mount1");
    plugin.respond.mockClear();

    plugin.emitRequest({
      requestId: "req-1",
      mountId: "mount1",
      path: "a.txt",
      offset: 0,
      length: 1,
    });

    expect(plugin.respond).toHaveBeenCalledWith({
      requestId: "req-1",
      kind: "unavailable",
      status: 404,
      reason: "unmounted",
    });
  });
});

describe("MobileSandboxArtifacts.respond", () => {
  it("base64-encodes a bytes reply, keeping requestId/offset/totalBytes/mediaType and dropping the raw bytes field", async () => {
    const { plugin, bridge } = await registeredBridge("mount1", "ios");
    bridge.onRequest(() => undefined);
    plugin.emitRequest({
      requestId: "req-1",
      mountId: "mount1",
      path: "a.txt",
      offset: 0,
      length: 5,
    });

    await bridge.respond({
      requestId: "req-1",
      kind: "bytes",
      bytes: new TextEncoder().encode("hello"),
      offset: 0,
      totalBytes: 5,
      mediaType: "text/plain",
    });

    expect(plugin.respond).toHaveBeenCalledTimes(1);
    const [sent] = plugin.respond.mock.calls[0];
    expect(sent).not.toHaveProperty("bytes");
    expect(sent).toMatchObject({
      requestId: "req-1",
      kind: "bytes",
      offset: 0,
      totalBytes: 5,
      mediaType: "text/plain",
    });
    if (sent.kind !== "bytes") throw new Error("expected a bytes reply");
    expect(new TextDecoder().decode(decodeBase64Bytes(sent.base64))).toBe(
      "hello",
    );
  });

  it("round-trips bytes outside the ASCII range, and a length that straddles the chunking window", async () => {
    const { plugin, bridge } = await registeredBridge("mount1", "ios");
    bridge.onRequest(() => undefined);
    plugin.emitRequest({
      requestId: "req-1",
      mountId: "mount1",
      path: "a.bin",
      offset: 0,
      length: 8193,
    });

    // 8193 straddles the implementation's 8192-byte chunking window by one.
    const bytes = new Uint8Array(8193);
    for (let i = 0; i < bytes.length; i++) bytes[i] = i % 256;
    await bridge.respond({
      requestId: "req-1",
      kind: "bytes",
      bytes,
      offset: 0,
      totalBytes: bytes.byteLength,
      mediaType: "application/octet-stream",
    });

    const [sent] = plugin.respond.mock.calls[0];
    if (sent.kind !== "bytes") throw new Error("expected a bytes reply");
    expect(decodeBase64Bytes(sent.base64)).toEqual(bytes);
  });

  it("passes an unavailable reply straight through, with no base64 step", async () => {
    const { plugin, bridge } = await registeredBridge("mount1", "ios");
    bridge.onRequest(() => undefined);
    plugin.emitRequest({
      requestId: "req-1",
      mountId: "mount1",
      path: "missing.txt",
      offset: 0,
      length: 1,
    });

    await bridge.respond({
      requestId: "req-1",
      kind: "unavailable",
      status: 404,
      reason: "missing",
    });

    expect(plugin.respond).toHaveBeenCalledWith({
      requestId: "req-1",
      kind: "unavailable",
      status: 404,
      reason: "missing",
    });
  });

  it("refuses a bytes reply over the 4 MiB native span bound with a 503, instead of sending it", async () => {
    const { plugin, bridge } = await registeredBridge("mount1", "ios");
    bridge.onRequest(() => undefined);
    plugin.emitRequest({
      requestId: "req-1",
      mountId: "mount1",
      path: "big.bin",
      offset: 0,
      length: 1,
    });

    const bytes = new Uint8Array(4 * 1024 * 1024 + 1);
    await bridge.respond({
      requestId: "req-1",
      kind: "bytes",
      bytes,
      offset: 0,
      totalBytes: bytes.byteLength,
      mediaType: "application/octet-stream",
    });

    expect(plugin.respond).toHaveBeenCalledWith({
      requestId: "req-1",
      kind: "unavailable",
      status: 503,
      reason: "Invalid artifact span",
    });
  });

  it("allows a bytes reply exactly at the 4 MiB boundary", async () => {
    const { plugin, bridge } = await registeredBridge("mount1", "ios");
    bridge.onRequest(() => undefined);
    plugin.emitRequest({
      requestId: "req-1",
      mountId: "mount1",
      path: "big.bin",
      offset: 0,
      length: 1,
    });

    const bytes = new Uint8Array(4 * 1024 * 1024);
    await bridge.respond({
      requestId: "req-1",
      kind: "bytes",
      bytes,
      offset: 0,
      totalBytes: bytes.byteLength,
      mediaType: "application/octet-stream",
    });

    expect(plugin.respond).toHaveBeenCalledTimes(1);
    const [sent] = plugin.respond.mock.calls[0];
    expect(sent).toMatchObject({ requestId: "req-1", kind: "bytes" });
  });
});

describe("MobileSandboxArtifacts, late and cancelled responses", () => {
  it("drops a respond() for a request that was already cancelled, never reaching the native plugin", async () => {
    const { plugin, bridge } = await registeredBridge("mount1", "ios");
    const cancelled: SandboxArtifactCancel[] = [];
    bridge.onRequest(() => undefined);
    bridge.onCancel((cancel) => cancelled.push(cancel));
    plugin.emitRequest({
      requestId: "req-1",
      mountId: "mount1",
      path: "a.txt",
      offset: 0,
      length: 1,
    });

    plugin.emitCancel({ requestId: "req-1" });
    expect(cancelled).toEqual([{ requestId: "req-1" }]);

    plugin.respond.mockClear();
    await bridge.respond({
      requestId: "req-1",
      kind: "bytes",
      bytes: new Uint8Array([1]),
      offset: 0,
      totalBytes: 1,
      mediaType: "text/plain",
    });

    expect(plugin.respond).not.toHaveBeenCalled();
  });

  it("drops a second, duplicate respond() for a request the first call already answered", async () => {
    const { plugin, bridge } = await registeredBridge("mount1", "ios");
    bridge.onRequest(() => undefined);
    plugin.emitRequest({
      requestId: "req-1",
      mountId: "mount1",
      path: "a.txt",
      offset: 0,
      length: 1,
    });

    await bridge.respond({
      requestId: "req-1",
      kind: "bytes",
      bytes: new Uint8Array([1]),
      offset: 0,
      totalBytes: 1,
      mediaType: "text/plain",
    });
    plugin.respond.mockClear();

    await bridge.respond({
      requestId: "req-1",
      kind: "bytes",
      bytes: new Uint8Array([2]),
      offset: 0,
      totalBytes: 1,
      mediaType: "text/plain",
    });
    expect(plugin.respond).not.toHaveBeenCalled();
  });

  it("ignores a cancel for a requestId that was never issued, and keeps the dispatcher usable afterward", async () => {
    const { plugin, bridge } = await registeredBridge("mount1", "ios");
    const cancelled: SandboxArtifactCancel[] = [];
    bridge.onCancel((cancel) => cancelled.push(cancel));

    expect(() => plugin.emitCancel({ requestId: "never-requested" })).not.toThrow();
    expect(cancelled).toEqual([]);

    bridge.onRequest(() => undefined);
    plugin.emitRequest({
      requestId: "req-after",
      mountId: "mount1",
      path: "a.txt",
      offset: 0,
      length: 1,
    });
    await bridge.respond({
      requestId: "req-after",
      kind: "bytes",
      bytes: new Uint8Array([1]),
      offset: 0,
      totalBytes: 1,
      mediaType: "text/plain",
    });
    expect(plugin.respond).toHaveBeenCalledWith(
      expect.objectContaining({ requestId: "req-after", kind: "bytes" }),
    );
  });

  it("ignores a cancel that arrives after the reply already went out, since tracking was removed before the reply was sent", async () => {
    const { plugin, bridge } = await registeredBridge("mount1", "ios");
    bridge.onRequest(() => undefined);
    plugin.emitRequest({
      requestId: "req-done",
      mountId: "mount1",
      path: "a.txt",
      offset: 0,
      length: 1,
    });
    await bridge.respond({
      requestId: "req-done",
      kind: "bytes",
      bytes: new Uint8Array([1]),
      offset: 0,
      totalBytes: 1,
      mediaType: "text/plain",
    });

    expect(() => plugin.emitCancel({ requestId: "req-done" })).not.toThrow();
  });
});
