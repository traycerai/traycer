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

class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  readonly sent: string[] = [];
  closed: { readonly code: number; readonly reason: string } | null = null;
  private readonly listeners = new Map<
    string,
    Set<(event: EventLike) => void>
  >();

  constructor(_url: string) {
    FakeWebSocket.instances.push(this);
  }

  addEventListener(type: string, handler: (event: EventLike) => void): void {
    const set = this.listeners.get(type) ?? new Set();
    set.add(handler);
    this.listeners.set(type, set);
  }

  removeEventListener(
    type: string,
    handler: (event: EventLike) => void,
  ): void {
    this.listeners.get(type)?.delete(handler);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(code: number, reason: string): void {
    if (this.closed !== null) {
      return;
    }
    this.closed = { code, reason };
    this.emit("close", {
      code,
      reason,
      wasClean: true,
    });
  }

  emit(type: string, event: EventLike): void {
    for (const handler of this.listeners.get(type) ?? []) {
      handler(event);
    }
  }
}

function nextTurn(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}

async function until(ready: () => boolean, label: string): Promise<void> {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    if (ready()) {
      return;
    }
    await nextTurn();
  }
  throw new Error(`timed out waiting for ${label}`);
}

function parsedSent(socket: FakeWebSocket): Array<Record<string, unknown>> {
  return socket.sent.map((raw) => JSON.parse(raw) as Record<string, unknown>);
}

describe("runtime host messenger release during dial", () => {
  afterEach(() => {
    for (const socket of FakeWebSocket.instances) {
      if (socket.closed === null) {
        socket.emit("error", {});
        socket.close(1000, "test-cleanup");
      }
    }
    FakeWebSocket.instances = [];
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
      resolveTarget: (hostId) => (hostId === localEntry.hostId ? localEntry : null),
      auth: null,
      authnBaseUrl: "https://authn.invalid",
      requestId: () => {
        issued += 1;
        return `req-${issued}`;
      },
      onRemoteAvailabilityRecovered: () => undefined,
      onRemoteSessionTerminal: () => undefined,
    });
    const options = {
      replayMustBeKeyed: false,
      requiredHostMethodVersion: null,
      idempotencyKey: null,
      authority: {
        endpoint: {
          hostId: localEntry.hostId,
          websocketUrl: localEntry.websocketUrl ?? "",
        },
        bearer,
        abortSignal: new AbortController().signal,
      },
    };
    const pending = binding.messenger.request("host.echo", { message: "one" }, options);
    if (release === "dispose") {
      binding.dispose();
    } else {
      binding.reset();
    }
    await until(
      () => FakeWebSocket.instances.length === 1,
      "the dialed socket",
    );
    const socket = FakeWebSocket.instances[0];
    if (socket === undefined) {
      throw new Error("expected the dialed socket");
    }
    socket.emit("open", { type: "open" });
    await until(() => parsedSent(socket).some((frame) => frame.kind === "open"), "the open frame");
    const open = parsedSent(socket).find((frame) => frame.kind === "open");
    if (open === undefined) {
      throw new Error("expected the open frame");
    }
    socket.emit("message", {
      data: JSON.stringify({
        kind: "openAck",
        manifest: open.manifest,
        ...(open.optionalManifest === undefined
          ? {}
          : { optionalManifest: open.optionalManifest }),
        capabilities: [UNARY_CAPABILITY_PERSISTENT_SESSION],
      }),
    });
    await until(
      () => parsedSent(socket).some((frame) => frame.kind === "request"),
      "the request frame",
    );
    await nextTurn();
    const request = parsedSent(socket).find((frame) => frame.kind === "request");
    if (request === undefined) {
      throw new Error("expected the request frame");
    }
    expect(socket.closed).toBeNull();
    socket.emit("message", {
      data: JSON.stringify({
        kind: "response",
        requestId: request.requestId,
        method: request.method,
        schemaVersion: request.schemaVersion,
        result: { echoed: "one" },
        error: null,
      }),
    });
    await expect(pending).resolves.toEqual({ echoed: "one" });
    expect(socket.closed).toEqual({ code: 1000, reason: "session-closed" });
    return { socket, binding };
  }

  it("closes the socket after dispose during the dial once the call settles", async () => {
    const { binding } = await drive("dispose");
    await expect(
      binding.messenger.request("host.echo", { message: "later" }, {
        replayMustBeKeyed: false,
        requiredHostMethodVersion: null,
        idempotencyKey: null,
        authority: {
          endpoint: {
            hostId: localEntry.hostId,
            websocketUrl: localEntry.websocketUrl ?? "",
          },
          bearer,
          abortSignal: new AbortController().signal,
        },
      }),
    ).rejects.toThrow("Host messenger has been disposed");
    expect(FakeWebSocket.instances).toHaveLength(1);
  });

  it("closes the socket after reset during the dial and keeps a later call's socket", async () => {
    const { binding } = await drive("reset");
    const started = FakeWebSocket.instances.length;
    const pending = binding.messenger.request(
      "host.echo",
      { message: "later" },
      {
        replayMustBeKeyed: false,
        requiredHostMethodVersion: null,
        idempotencyKey: null,
        authority: {
          endpoint: {
            hostId: localEntry.hostId,
            websocketUrl: localEntry.websocketUrl ?? "",
          },
          bearer,
          abortSignal: new AbortController().signal,
        },
      },
    );
    await until(
      () => FakeWebSocket.instances.length === started + 1,
      "the later socket",
    );
    const socket = FakeWebSocket.instances[started];
    if (socket === undefined) {
      throw new Error("expected the later socket");
    }
    socket.emit("open", { type: "open" });
    await until(
      () => parsedSent(socket).some((frame) => frame.kind === "open"),
      "the later open frame",
    );
    const open = parsedSent(socket).find((frame) => frame.kind === "open");
    if (open === undefined) {
      throw new Error("expected the later open frame");
    }
    socket.emit("message", {
      data: JSON.stringify({
        kind: "openAck",
        manifest: open.manifest,
        ...(open.optionalManifest === undefined
          ? {}
          : { optionalManifest: open.optionalManifest }),
        capabilities: [UNARY_CAPABILITY_PERSISTENT_SESSION],
      }),
    });
    await until(
      () => parsedSent(socket).some((frame) => frame.kind === "request"),
      "the later request",
    );
    const request = parsedSent(socket).find((frame) => frame.kind === "request");
    if (request === undefined) {
      throw new Error("expected the later request");
    }
    socket.emit("message", {
      data: JSON.stringify({
        kind: "response",
        requestId: request.requestId,
        method: request.method,
        schemaVersion: request.schemaVersion,
        result: { echoed: "later" },
        error: null,
      }),
    });
    await expect(pending).resolves.toEqual({ echoed: "later" });
    expect(socket.closed).toBeNull();
  });
});
