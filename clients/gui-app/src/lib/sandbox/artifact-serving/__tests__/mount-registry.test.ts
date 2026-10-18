import { describe, expect, it, vi } from "vitest";
import type { IRunnerHost } from "@traycer-clients/shared/platform/runner-host";
import type {
  SandboxArtifactBridge,
  SandboxArtifactCancel,
  SandboxArtifactReply,
  SandboxArtifactRequest,
} from "@traycer-clients/shared/platform/sandbox-artifacts";
import { MockRunnerHost } from "@traycer-clients/shared/host-client/mock/mock-runner-host";
import type { SandboxTheme } from "@/lib/sandbox/theme-map";
import {
  ArtifactServer,
  type ArtifactReadSpan,
  type ArtifactReadSpanResult,
} from "../artifact-server";
import type { ArtifactManifest } from "../artifact-manifest";
import { mountArtifact } from "../mount-registry";

const THEME: SandboxTheme = {
  appliesToRoot: true,
  colorScheme: "light",
  background: null,
  variables: {},
};

function manifestOf(path: string, byteLength: number): ArtifactManifest {
  return {
    files: {
      [path]: {
        sha256: `sha-${path}`,
        byteLength,
        mediaType: "text/plain",
        status: "published",
      },
    },
  };
}

/** A real {@link ArtifactServer} whose one file's content is `text`. */
function serverFor(path: string, text: string): ArtifactServer {
  const bytes = new TextEncoder().encode(text);
  const readSpan: ArtifactReadSpan = (_sha256, offset, length) =>
    Promise.resolve({
      bytes: bytes.slice(offset, offset + length),
      totalBytes: bytes.length,
      mediaType: "text/plain",
    });
  return new ArtifactServer({
    treePath: "",
    manifest: manifestOf(path, bytes.length),
    readSpan,
    document: {
      policySource: "traycer-sandbox:",
      csp: null,
      theme: THEME,
      nonce: "n",
      shortcuts: [],
    },
  });
}

interface FakeBridge extends SandboxArtifactBridge {
  readonly registered: string[];
  readonly unregistered: string[];
  readonly responses: SandboxArtifactReply[];
  /** How many times `onRequest` itself was called - one call per live subscription. */
  readonly onRequestCalls: number;
  /** How many of those subscriptions are still live right now. */
  readonly activeListeners: number;
  /** How many times `onCancel` itself was called - mirrors `onRequestCalls`. */
  readonly onCancelCalls: number;
  readonly activeCancelListeners: number;
  emit(request: SandboxArtifactRequest): void;
  emitCancel(cancel: SandboxArtifactCancel): void;
}

function createFakeBridge(): FakeBridge {
  const handlers = new Set<(request: SandboxArtifactRequest) => void>();
  const cancelHandlers = new Set<(cancel: SandboxArtifactCancel) => void>();
  const registered: string[] = [];
  const unregistered: string[] = [];
  const responses: SandboxArtifactReply[] = [];
  let onRequestCalls = 0;
  let onCancelCalls = 0;
  return {
    policySource: "traycer-sandbox:",
    artifactOrigin: ({ artifactId, mountId }) =>
      `traycer-sandbox://artifact-${artifactId}--${mountId}`,
    registered,
    unregistered,
    responses,
    get onRequestCalls() {
      return onRequestCalls;
    },
    get activeListeners() {
      return handlers.size;
    },
    get onCancelCalls() {
      return onCancelCalls;
    },
    get activeCancelListeners() {
      return cancelHandlers.size;
    },
    register: (mountId) => {
      registered.push(mountId);
      return Promise.resolve();
    },
    unregister: (mountId) => {
      unregistered.push(mountId);
      return Promise.resolve();
    },
    onRequest: (handler) => {
      onRequestCalls += 1;
      handlers.add(handler);
      return { dispose: () => handlers.delete(handler) };
    },
    onCancel: (handler) => {
      onCancelCalls += 1;
      cancelHandlers.add(handler);
      return { dispose: () => cancelHandlers.delete(handler) };
    },
    respond: (reply) => {
      responses.push(reply);
      return Promise.resolve();
    },
    emit: (request) => {
      for (const handler of handlers) handler(request);
    },
    emitCancel: (cancel) => {
      for (const handler of cancelHandlers) handler(cancel);
    },
  };
}

function hostWith(bridge: SandboxArtifactBridge | null): IRunnerHost {
  const host = new MockRunnerHost({
    signInUrl: "https://example.invalid/signin",
    authnBaseUrl: "https://example.invalid",
    localHost: null,
    hosts: [],
    workspaceFolderPickerPaths: undefined,
    hasLocalHost: undefined,
    traycerCli: undefined,
  });
  // MockRunnerHost always hardcodes `sandboxArtifacts` to null; these tests
  // need a runner host that actually carries a (fake) bridge.
  const proto = Object.getPrototypeOf(host) as object;
  return Object.assign(Object.create(proto) as IRunnerHost, host, {
    sandboxArtifacts: bridge,
  });
}

function requestFor(
  mountId: string,
  path: string,
  requestId: string,
): SandboxArtifactRequest {
  return { requestId, mountId, path, offset: 0, length: 5 };
}

/**
 * `ArtifactServer`'s returned bytes and this file's own `TextEncoder` output
 * are not `toEqual`-comparable here: decode instead of comparing the
 * `Uint8Array` objects directly.
 */
function decodedText(reply: SandboxArtifactReply | undefined): string {
  if (reply?.kind !== "bytes") {
    throw new Error(`expected a bytes reply, got ${JSON.stringify(reply)}`);
  }
  return new TextDecoder().decode(reply.bytes);
}

describe("mountArtifact", () => {
  it("throws when the runner host has no artifact bridge", () => {
    expect(() =>
      mountArtifact(hostWith(null), serverFor("a.txt", "AAAAA")),
    ).toThrow();
  });

  it("registers the mount through the bridge right away", () => {
    const bridge = createFakeBridge();
    const mount = mountArtifact(hostWith(bridge), serverFor("a.txt", "AAAAA"));
    expect(bridge.registered).toEqual([mount.mountId]);
  });

  it("dispatches each request to the server registered under its own mount", async () => {
    const bridge = createFakeBridge();
    const host = hostWith(bridge);
    const mountA = mountArtifact(host, serverFor("a.txt", "AAAAA"));
    const mountB = mountArtifact(host, serverFor("b.txt", "BBBBB"));
    await mountA.ready;
    await mountB.ready;
    expect(mountA.mountId).not.toBe(mountB.mountId);

    bridge.emit(requestFor(mountA.mountId, "a.txt", "req-a"));
    bridge.emit(requestFor(mountB.mountId, "b.txt", "req-b"));
    await vi.waitFor(() => expect(bridge.responses).toHaveLength(2));

    const byId = new Map(
      bridge.responses.map((reply) => [reply.requestId, reply]),
    );
    expect(byId.get("req-a")).toMatchObject({ kind: "bytes" });
    expect(decodedText(byId.get("req-a"))).toBe("AAAAA");
    expect(byId.get("req-b")).toMatchObject({ kind: "bytes" });
    expect(decodedText(byId.get("req-b"))).toBe("BBBBB");
  });

  it("never lets a second mount's request reach the first mount's server", async () => {
    // Same path and manifest shape in both mounts; only the server differs,
    // so a dispatch bug that fell back to "the first registered server"
    // would still answer with plausible-looking bytes instead of failing.
    const bridge = createFakeBridge();
    const host = hostWith(bridge);
    const first = mountArtifact(host, serverFor("a.txt", "AAAAA"));
    const second = mountArtifact(host, serverFor("a.txt", "ZZZZZ"));
    await first.ready;
    await second.ready;

    bridge.emit(requestFor(second.mountId, "a.txt", "req-second"));
    await vi.waitFor(() => expect(bridge.responses).toHaveLength(1));
    expect(bridge.responses[0]).toMatchObject({
      requestId: "req-second",
      kind: "bytes",
    });
    expect(decodedText(bridge.responses[0])).toBe("ZZZZZ");
  });

  it("answers a request for an unknown or already-disposed mount as unavailable, while another mount keeps the dispatcher alive", async () => {
    // Disposing the ONLY mount drops the dispatcher's subscription entirely
    // (see "one dispatcher per underlying bridge" below), so nothing would be
    // listening to answer these at all. A second, still-live mount is what
    // makes "unavailable" rather than "no listener" the right expectation.
    const bridge = createFakeBridge();
    const host = hostWith(bridge);
    const mount = mountArtifact(host, serverFor("a.txt", "AAAAA"));
    const keepAlive = mountArtifact(host, serverFor("keep.txt", "KEEPK"));
    await mount.ready;
    await keepAlive.ready;
    mount.dispose();

    bridge.emit(requestFor(mount.mountId, "a.txt", "req-gone"));
    bridge.emit(requestFor("never-mounted", "a.txt", "req-unknown"));
    await vi.waitFor(() => expect(bridge.responses).toHaveLength(2));
    for (const reply of bridge.responses) {
      expect(reply).toMatchObject({
        kind: "unavailable",
        reason: "unmounted",
        status: 404,
      });
    }
  });

  it("unregisters through the bridge once dispose runs after registration", async () => {
    const bridge = createFakeBridge();
    const host = hostWith(bridge);
    const mount = mountArtifact(host, serverFor("a.txt", "AAAAA"));
    await mount.ready;
    mount.dispose();
    await vi.waitFor(() =>
      expect(bridge.unregistered).toEqual([mount.mountId]),
    );
  });

  it("still unregisters the native lease when dispose runs before registration settles", async () => {
    let resolveRegister: () => void = () => undefined;
    const registered: string[] = [];
    const unregistered: string[] = [];
    const bridge: SandboxArtifactBridge = {
      policySource: "traycer-sandbox:",
      artifactOrigin: ({ artifactId, mountId }) =>
        `traycer-sandbox://artifact-${artifactId}--${mountId}`,
      register: (mountId) =>
        new Promise((resolve) => {
          registered.push(mountId);
          resolveRegister = resolve;
        }),
      unregister: (mountId) => {
        unregistered.push(mountId);
        return Promise.resolve();
      },
      onRequest: () => ({ dispose: () => undefined }),
      // Mechanical stub: this test is about the register/unregister race, not
      // cancellation, but a bridge value must still satisfy the interface.
      onCancel: () => ({ dispose: () => undefined }),
      respond: () => Promise.resolve(),
    };
    const mount = mountArtifact(hostWith(bridge), serverFor("a.txt", "AAAAA"));
    mount.dispose();
    expect(unregistered).toEqual([]);
    resolveRegister();
    await vi.waitFor(() => expect(unregistered).toEqual([mount.mountId]));
    expect(registered).toEqual([mount.mountId]);
  });

  it("aborts the in-flight request's own signal on dispose and never delivers its (now stale) response", async () => {
    // `ArtifactServer` coalesces reads behind its own internal signal, which
    // intentionally stays alive for any other caller sharing the same block
    // - so the signal to assert on is the one `serve()` was actually called
    // with (the dispatcher's own per-request controller), not whatever
    // signal `readSpan` itself happens to receive.
    let settle: (result: ArtifactReadSpanResult) => void = () => undefined;
    const readSpan: ArtifactReadSpan = () =>
      new Promise((resolve) => {
        settle = resolve;
      });
    const server = new ArtifactServer({
      treePath: "",
      manifest: manifestOf("a.txt", 5),
      readSpan,
      document: {
        policySource: "traycer-sandbox:",
        csp: null,
        theme: THEME,
        nonce: "n",
        shortcuts: [],
      },
    });
    const serveSpy = vi.spyOn(server, "serve");
    const bridge = createFakeBridge();
    const mount = mountArtifact(hostWith(bridge), server);
    await mount.ready;

    bridge.emit(requestFor(mount.mountId, "a.txt", "req-1"));
    await vi.waitFor(() => expect(serveSpy).toHaveBeenCalledTimes(1));
    const requestSignal = serveSpy.mock.calls[0][0].signal;
    expect(requestSignal.aborted).toBe(false);

    mount.dispose();
    expect(requestSignal.aborted).toBe(true);

    // The underlying (shared) read settles only after dispose: a stale
    // answer must still never reach the bridge, because the frame it was
    // for may already be gone.
    settle({
      bytes: new TextEncoder().encode("AAAAA"),
      totalBytes: 5,
      mediaType: "text/plain",
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(bridge.responses).toEqual([]);
  });

  it("aborts every mount's in-flight requests independently: disposing one leaves the other's alone", async () => {
    const settles: ((result: ArtifactReadSpanResult) => void)[] = [];
    function slowServer(path: string): ArtifactServer {
      const readSpan: ArtifactReadSpan = () =>
        new Promise((resolve) => {
          settles.push(resolve);
        });
      return new ArtifactServer({
        treePath: "",
        manifest: manifestOf(path, 5),
        readSpan,
        document: {
          policySource: "traycer-sandbox:",
          csp: null,
          theme: THEME,
          nonce: "n",
          shortcuts: [],
        },
      });
    }
    const bridge = createFakeBridge();
    const host = hostWith(bridge);
    const firstServer = slowServer("a.txt");
    const secondServer = slowServer("a.txt");
    const firstServeSpy = vi.spyOn(firstServer, "serve");
    const secondServeSpy = vi.spyOn(secondServer, "serve");
    const first = mountArtifact(host, firstServer);
    const second = mountArtifact(host, secondServer);
    await first.ready;
    await second.ready;

    bridge.emit(requestFor(first.mountId, "a.txt", "req-first"));
    bridge.emit(requestFor(second.mountId, "a.txt", "req-second"));
    await vi.waitFor(() => {
      expect(firstServeSpy).toHaveBeenCalledTimes(1);
      expect(secondServeSpy).toHaveBeenCalledTimes(1);
    });
    const firstSignal = firstServeSpy.mock.calls[0][0].signal;
    const secondSignal = secondServeSpy.mock.calls[0][0].signal;

    first.dispose();
    expect(firstSignal.aborted).toBe(true);
    expect(secondSignal.aborted).toBe(false);

    settles[1]?.({
      bytes: new TextEncoder().encode("AAAAA"),
      totalBytes: 5,
      mediaType: "text/plain",
    });
    await vi.waitFor(() => expect(bridge.responses).toHaveLength(1));
    expect(bridge.responses[0]).toMatchObject({
      requestId: "req-second",
      kind: "bytes",
    });
    expect(decodedText(bridge.responses[0])).toBe("AAAAA");
  });
});

describe("one dispatcher per underlying bridge, across runner-host wrapper identities", () => {
  it("shares one subscription for simultaneous mounts, even through different runner-host wrapper objects", async () => {
    const bridge = createFakeBridge();
    // Two distinct IRunnerHost objects wrapping the SAME native bridge, the
    // way a reconnect or a re-provided binding hands the app a fresh facade
    // around a live underlying connection.
    const hostA = hostWith(bridge);
    const hostB = hostWith(bridge);
    expect(hostA).not.toBe(hostB);

    const mountA = mountArtifact(hostA, serverFor("a.txt", "AAAAA"));
    const mountB = mountArtifact(hostB, serverFor("b.txt", "BBBBB"));
    await mountA.ready;
    await mountB.ready;
    expect(bridge.onRequestCalls).toBe(1);
    expect(bridge.activeListeners).toBe(1);

    bridge.emit(requestFor(mountA.mountId, "a.txt", "req-a"));
    bridge.emit(requestFor(mountB.mountId, "b.txt", "req-b"));
    await vi.waitFor(() => expect(bridge.responses).toHaveLength(2));
    // Exactly one response per request: a dispatcher keyed by host identity
    // instead of by bridge would double-subscribe here and double-answer
    // each one (the second, stale dispatcher sees neither mount and would
    // chime in with a spurious "unmounted").
    expect(
      bridge.responses.filter((reply) => reply.requestId === "req-a"),
    ).toHaveLength(1);
    expect(
      bridge.responses.filter((reply) => reply.requestId === "req-b"),
    ).toHaveLength(1);
    const byId = new Map(
      bridge.responses.map((reply) => [reply.requestId, reply]),
    );
    expect(byId.get("req-a")).toMatchObject({ kind: "bytes" });
    expect(decodedText(byId.get("req-a"))).toBe("AAAAA");
    expect(byId.get("req-b")).toMatchObject({ kind: "bytes" });
    expect(decodedText(byId.get("req-b"))).toBe("BBBBB");

    mountA.dispose();
    mountB.dispose();
    await vi.waitFor(() => expect(bridge.activeListeners).toBe(0));
  });

  it("drops the listener once the last mount disposes, and subscribes fresh for the next mount", async () => {
    const bridge = createFakeBridge();
    const host = hostWith(bridge);
    const first = mountArtifact(host, serverFor("a.txt", "AAAAA"));
    await first.ready;
    expect(bridge.onRequestCalls).toBe(1);
    expect(bridge.activeListeners).toBe(1);

    first.dispose();
    await vi.waitFor(() => expect(bridge.activeListeners).toBe(0));

    // A replacement runner-host wrapper around the same bridge, mounting
    // only after the dispatcher had gone fully idle.
    const replacementHost = hostWith(bridge);
    const second = mountArtifact(replacementHost, serverFor("b.txt", "BBBBB"));
    await second.ready;
    expect(bridge.onRequestCalls).toBe(2);
    expect(bridge.activeListeners).toBe(1);

    bridge.emit(requestFor(second.mountId, "b.txt", "req-b"));
    await vi.waitFor(() => expect(bridge.responses).toHaveLength(1));
    expect(bridge.responses[0]).toMatchObject({
      requestId: "req-b",
      kind: "bytes",
    });
    expect(decodedText(bridge.responses[0])).toBe("BBBBB");

    second.dispose();
    await vi.waitFor(() => expect(bridge.activeListeners).toBe(0));
  });

  it("keeps the one subscription alive across a partial disposal, dropping it only once every mount is gone", async () => {
    const bridge = createFakeBridge();
    const host = hostWith(bridge);
    const first = mountArtifact(host, serverFor("a.txt", "AAAAA"));
    const second = mountArtifact(hostWith(bridge), serverFor("b.txt", "BBBBB"));
    await first.ready;
    await second.ready;
    expect(bridge.onRequestCalls).toBe(1);

    first.dispose();
    expect(bridge.activeListeners).toBe(1);
    expect(bridge.onRequestCalls).toBe(1);

    second.dispose();
    await vi.waitFor(() => expect(bridge.activeListeners).toBe(0));
  });
});

describe("request cancellation (onCancel)", () => {
  it("aborts the in-flight request's own signal when the frame cancels it, and never delivers the (now stale) response", async () => {
    // Same reasoning as the dispose-time abort tests above: assert on the
    // signal `serve()` was actually called with, not on whatever signal
    // `readSpan` receives (now always the server's own, permanently-live
    // coalescing signal).
    let settle: (result: ArtifactReadSpanResult) => void = () => undefined;
    const readSpan: ArtifactReadSpan = () =>
      new Promise((resolve) => {
        settle = resolve;
      });
    const server = new ArtifactServer({
      treePath: "",
      manifest: manifestOf("a.txt", 5),
      readSpan,
      document: {
        policySource: "traycer-sandbox:",
        csp: null,
        theme: THEME,
        nonce: "n",
        shortcuts: [],
      },
    });
    const serveSpy = vi.spyOn(server, "serve");
    const bridge = createFakeBridge();
    const mount = mountArtifact(hostWith(bridge), server);
    await mount.ready;

    bridge.emit(requestFor(mount.mountId, "a.txt", "req-cancel-me"));
    await vi.waitFor(() => expect(serveSpy).toHaveBeenCalledTimes(1));
    const requestSignal = serveSpy.mock.calls[0][0].signal;
    expect(requestSignal.aborted).toBe(false);

    bridge.emitCancel({ requestId: "req-cancel-me" });
    expect(requestSignal.aborted).toBe(true);

    // The underlying (shared) read settles only after the cancel: a stale
    // answer must still never reach the bridge.
    settle({
      bytes: new TextEncoder().encode("AAAAA"),
      totalBytes: 5,
      mediaType: "text/plain",
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(bridge.responses).toEqual([]);
  });

  it("ignores a cancel that arrives after the reply has already gone out, because tracking was removed before the reply was sent", async () => {
    const server = serverFor("a.txt", "AAAAA");
    const serveSpy = vi.spyOn(server, "serve");
    const bridge = createFakeBridge();
    const mount = mountArtifact(hostWith(bridge), server);
    await mount.ready;

    bridge.emit(requestFor(mount.mountId, "a.txt", "req-done"));
    await vi.waitFor(() => expect(bridge.responses).toHaveLength(1));
    const requestSignal = serveSpy.mock.calls[0][0].signal;

    // Completion removes the requestId from tracking before the reply is
    // sent, so a cancel that lands after that point has nothing to abort.
    expect(() => bridge.emitCancel({ requestId: "req-done" })).not.toThrow();
    // This is the proof tracking was actually removed, not merely that
    // nothing happens to read it: if the requestId were still tracked, this
    // cancel would have aborted the very controller `serve()` ran with -
    // response count alone can't distinguish "removed" from "harmlessly
    // ignored while still tracked".
    expect(requestSignal.aborted).toBe(false);
    await Promise.resolve();
    expect(bridge.responses).toHaveLength(1);
    expect(bridge.responses[0]).toMatchObject({
      requestId: "req-done",
      kind: "bytes",
    });
    expect(decodedText(bridge.responses[0])).toBe("AAAAA");
  });

  it("ignores a cancel for a requestId that was never issued", async () => {
    const bridge = createFakeBridge();
    const mount = mountArtifact(hostWith(bridge), serverFor("a.txt", "AAAAA"));
    await mount.ready;

    expect(() =>
      bridge.emitCancel({ requestId: "never-requested" }),
    ).not.toThrow();

    // The dispatcher is still perfectly usable afterward.
    bridge.emit(requestFor(mount.mountId, "a.txt", "req-after"));
    await vi.waitFor(() => expect(bridge.responses).toHaveLength(1));
    expect(bridge.responses[0]).toMatchObject({
      requestId: "req-after",
      kind: "bytes",
    });
  });

  it("subscribes and unsubscribes onCancel in lockstep with onRequest, across the dispatcher's lifetime", async () => {
    const bridge = createFakeBridge();
    const first = mountArtifact(hostWith(bridge), serverFor("a.txt", "AAAAA"));
    const second = mountArtifact(hostWith(bridge), serverFor("b.txt", "BBBBB"));
    await first.ready;
    await second.ready;
    expect(bridge.onRequestCalls).toBe(1);
    expect(bridge.onCancelCalls).toBe(1);
    expect(bridge.activeListeners).toBe(1);
    expect(bridge.activeCancelListeners).toBe(1);

    first.dispose();
    expect(bridge.activeListeners).toBe(1);
    expect(bridge.activeCancelListeners).toBe(1);

    second.dispose();
    await vi.waitFor(() => expect(bridge.activeListeners).toBe(0));
    expect(bridge.activeCancelListeners).toBe(0);

    // A replacement runner-host wrapper, same bridge, mounting only after
    // the dispatcher had gone fully idle: both subscriptions come back.
    const third = mountArtifact(hostWith(bridge), serverFor("c.txt", "CCCCC"));
    await third.ready;
    expect(bridge.onRequestCalls).toBe(2);
    expect(bridge.onCancelCalls).toBe(2);
    expect(bridge.activeListeners).toBe(1);
    expect(bridge.activeCancelListeners).toBe(1);

    third.dispose();
    await vi.waitFor(() => expect(bridge.activeListeners).toBe(0));
    expect(bridge.activeCancelListeners).toBe(0);
  });
});
