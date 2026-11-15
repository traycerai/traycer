/**
 * `dispose` and `reset` release the local session while its socket is still
 * dialing. The discovering call still finishes, and that release closes the
 * socket once the call settles.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { HostDirectoryEntry } from "@traycer-clients/shared/host-client/host-directory";
import {
  defineRpcContract,
  defineVersionedRpcRegistry,
  UNARY_CAPABILITY_PERSISTENT_SESSION,
} from "@traycer/protocol/framework/index";
import {
  buildRuntimeHostMessenger,
  type RuntimeHostMessengerBinding,
} from "../host-messenger";
import { heldHostTokenSource } from "../../../../__tests__/create-fake-runner-host";

const echoV10 = defineRpcContract({
  method: "host.echo",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: z.object({ message: z.string() }),
  responseSchema: z.object({ echoed: z.string() }),
});

const registry = defineVersionedRpcRegistry({
  "host.echo": {
    1: {
      latestMinor: 0,
      versions: {
        0: { contract: echoV10, upgradeFromPreviousVersion: null },
      },
      downgradePathsFromLatest: {},
    },
  },
});

const localEntry: HostDirectoryEntry = {
  hostId: "local-host",
  label: "This machine",
  kind: "local",
  websocketUrl: "ws://127.0.0.1:9/rpc",
  version: "1.0.0",
  transportDialability: "dialable",
};

const bearer = {
  getBearerToken: () => "bearer-token",
  identity: { userId: "user-1" },
};

interface EventLike {
  readonly type?: string;
  readonly data?: string;
  readonly code?: number;
  readonly reason?: string;
  readonly wasClean?: boolean;
}

interface CloseInfo {
  readonly code: number;
  readonly reason: string;
}

class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  private static instanceWaiters: Array<(socket: FakeWebSocket) => void> = [];

  readonly sent: string[] = [];
  closed: CloseInfo | null = null;
  private readonly listeners = new Map<
    string,
    Set<(event: EventLike) => void>
  >();
  private readonly sendWaiters: Array<
    (frame: Record<string, unknown>) => void
  > = [];
  private readonly closeWaiters: Array<(closed: CloseInfo) => void> = [];

  static nextInstance(): Promise<FakeWebSocket> {
    return new Promise((resolve) => {
      FakeWebSocket.instanceWaiters.push(resolve);
    });
  }

  static reset(): void {
    FakeWebSocket.instances = [];
    FakeWebSocket.instanceWaiters = [];
  }

  constructor(_url: string) {
    FakeWebSocket.instances.push(this);
    const resolve = FakeWebSocket.instanceWaiters.shift();
    if (resolve !== undefined) {
      resolve(this);
    }
  }

  addEventListener(type: string, handler: (event: EventLike) => void): void {
    const set = this.listeners.get(type) ?? new Set();
    set.add(handler);
    this.listeners.set(type, set);
  }

  removeEventListener(type: string, handler: (event: EventLike) => void): void {
    this.listeners.get(type)?.delete(handler);
  }

  send(data: string): void {
    const frame = JSON.parse(data) as Record<string, unknown>;
    this.sent.push(data);
    const waiters = this.sendWaiters.splice(0, this.sendWaiters.length);
    for (const resolve of waiters) {
      resolve(frame);
    }
  }

  nextSend(): Promise<Record<string, unknown>> {
    return new Promise((resolve) => {
      this.sendWaiters.push(resolve);
    });
  }

  close(code: number, reason: string): void {
    if (this.closed !== null) {
      return;
    }
    const closed = { code, reason };
    this.closed = closed;
    this.emit("close", {
      code,
      reason,
      wasClean: true,
    });
    const waiters = this.closeWaiters.splice(0, this.closeWaiters.length);
    for (const resolve of waiters) {
      resolve(closed);
    }
  }

  whenClosed(): Promise<CloseInfo> {
    if (this.closed !== null) {
      return Promise.resolve(this.closed);
    }
    return new Promise((resolve) => {
      this.closeWaiters.push(resolve);
    });
  }

  emit(type: string, event: EventLike): void {
    for (const handler of this.listeners.get(type) ?? []) {
      handler(event);
    }
  }
}

function openAckFor(open: Record<string, unknown>): string {
  return JSON.stringify({
    kind: "openAck",
    manifest: open.manifest,
    ...(open.optionalManifest === undefined
      ? {}
      : { optionalManifest: open.optionalManifest }),
    capabilities: [UNARY_CAPABILITY_PERSISTENT_SESSION],
  });
}

function responseFor(request: Record<string, unknown>, echoed: string): string {
  return JSON.stringify({
    kind: "response",
    requestId: request.requestId,
    method: request.method,
    schemaVersion: request.schemaVersion,
    result: { echoed },
    error: null,
  });
}

function authority() {
  return {
    endpoint: {
      hostId: localEntry.hostId,
      websocketUrl: localEntry.websocketUrl ?? "",
    },
    bearer,
    abortSignal: new AbortController().signal,
  };
}

describe("runtime host messenger release during dial", () => {
  afterEach(() => {
    for (const socket of FakeWebSocket.instances) {
      if (socket.closed === null) {
        socket.emit("error", {});
        socket.close(1000, "test-cleanup");
      }
    }
    FakeWebSocket.reset();
    vi.unstubAllGlobals();
  });

  async function drive(release: "dispose" | "reset"): Promise<{
    readonly socket: FakeWebSocket;
    readonly binding: RuntimeHostMessengerBinding<typeof registry>;
  }> {
    vi.stubGlobal("WebSocket", FakeWebSocket);
    let issued = 0;
    const binding = buildRuntimeHostMessenger<typeof registry>({
      registry,
      resolveTarget: (hostId) =>
        hostId === localEntry.hostId ? localEntry : null,
      auth: null,
      authnBaseUrl: "https://authn.invalid",
      hostTokens: await heldHostTokenSource(
        bearer.identity.userId,
        localEntry.hostId,
      ),
      requestId: () => {
        issued += 1;
        return `req-${issued}`;
      },
      onRemoteAvailabilityRecovered: () => undefined,
      onRemoteSessionTerminal: () => undefined,
    });
    const arrived = FakeWebSocket.nextInstance();
    const pending = binding.messenger.request(
      "host.echo",
      { message: "one" },
      {
        replayMustBeKeyed: false,
        requiredHostMethodVersion: null,
        idempotencyKey: null,
        authority: authority(),
      },
    );
    if (release === "dispose") {
      binding.dispose();
    } else {
      binding.reset();
    }
    const socket = await arrived;
    const openSent = socket.nextSend();
    socket.emit("open", { type: "open" });
    const open = await openSent;
    if (open.kind !== "open") {
      throw new Error("expected the open frame");
    }
    const requestSent = socket.nextSend();
    socket.emit("message", { data: openAckFor(open) });
    const request = await requestSent;
    if (request.kind !== "request") {
      throw new Error("expected the request frame");
    }
    expect(socket.closed).toBeNull();
    const closed = socket.whenClosed();
    socket.emit("message", { data: responseFor(request, "one") });
    await expect(pending).resolves.toEqual({ echoed: "one" });
    await expect(closed).resolves.toEqual({
      code: 1000,
      reason: "session-closed",
    });
    return { socket, binding };
  }

  async function answer(socket: FakeWebSocket, echoed: string): Promise<void> {
    const openSent = socket.nextSend();
    socket.emit("open", { type: "open" });
    const open = await openSent;
    if (open.kind !== "open") {
      throw new Error("expected the open frame");
    }
    const requestSent = socket.nextSend();
    socket.emit("message", { data: openAckFor(open) });
    const request = await requestSent;
    if (request.kind !== "request") {
      throw new Error("expected the request frame");
    }
    socket.emit("message", { data: responseFor(request, echoed) });
  }

  it("closes the socket after dispose during the dial once the call settles", async () => {
    const { binding } = await drive("dispose");
    await expect(
      binding.messenger.request(
        "host.echo",
        { message: "later" },
        {
          replayMustBeKeyed: false,
          requiredHostMethodVersion: null,
          idempotencyKey: null,
          authority: authority(),
        },
      ),
    ).rejects.toThrow("Host messenger has been disposed");
    expect(FakeWebSocket.instances).toHaveLength(1);
  });

  it("closes the socket after reset during the dial and keeps a later call's socket", async () => {
    const { binding } = await drive("reset");
    const arrived = FakeWebSocket.nextInstance();
    const pending = binding.messenger.request(
      "host.echo",
      { message: "later" },
      {
        replayMustBeKeyed: false,
        requiredHostMethodVersion: null,
        idempotencyKey: null,
        authority: authority(),
      },
    );
    const socket = await arrived;
    await answer(socket, "later");
    await expect(pending).resolves.toEqual({ echoed: "later" });
    expect(socket.closed).toBeNull();
  });

  it("reset during a discovery retry closes the replacement and keeps the next socket", async () => {
    vi.stubGlobal("WebSocket", FakeWebSocket);
    let issued = 0;
    const binding = buildRuntimeHostMessenger<typeof registry>({
      registry,
      resolveTarget: (hostId) =>
        hostId === localEntry.hostId ? localEntry : null,
      auth: null,
      authnBaseUrl: "https://authn.invalid",
      hostTokens: await heldHostTokenSource(
        bearer.identity.userId,
        localEntry.hostId,
      ),
      requestId: () => {
        issued += 1;
        return `req-${issued}`;
      },
      onRemoteAvailabilityRecovered: () => undefined,
      onRemoteSessionTerminal: () => undefined,
    });
    const arrived = FakeWebSocket.nextInstance();
    const owner = binding.messenger.request(
      "host.echo",
      { message: "owner" },
      {
        replayMustBeKeyed: false,
        requiredHostMethodVersion: null,
        idempotencyKey: null,
        authority: authority(),
      },
    );
    const ownerError = owner.then(
      () => null,
      (cause: unknown) => cause,
    );
    const waiter = binding.messenger.request(
      "host.echo",
      { message: "waiter" },
      {
        replayMustBeKeyed: false,
        requiredHostMethodVersion: null,
        idempotencyKey: null,
        authority: authority(),
      },
    );
    const socket = await arrived;
    const openSent = socket.nextSend();
    socket.emit("open", { type: "open" });
    const open = await openSent;
    if (open.kind !== "open") {
      throw new Error("expected the open frame");
    }
    const replacementArrived = FakeWebSocket.nextInstance();
    socket.close(1006, "peer-dropped");
    binding.reset();
    const replacement = await replacementArrived;
    await answer(replacement, "waiter");
    await expect(waiter).resolves.toEqual({ echoed: "waiter" });
    expect(replacement.closed).toEqual({
      code: 1000,
      reason: "session-closed",
    });
    await expect(ownerError).resolves.toBeInstanceOf(Error);
    const laterArrived = FakeWebSocket.nextInstance();
    const later = binding.messenger.request(
      "host.echo",
      { message: "later" },
      {
        replayMustBeKeyed: false,
        requiredHostMethodVersion: null,
        idempotencyKey: null,
        authority: authority(),
      },
    );
    const laterSocket = await laterArrived;
    await answer(laterSocket, "later");
    await expect(later).resolves.toEqual({ echoed: "later" });
    expect(laterSocket.closed).toBeNull();
  });
});
