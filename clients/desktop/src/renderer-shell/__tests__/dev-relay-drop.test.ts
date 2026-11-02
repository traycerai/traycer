// @vitest-environment node
import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { Duplex } from "node:stream";
import { fileURLToPath } from "node:url";
import { build, type Plugin } from "esbuild";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installDevRelayDropSwitch } from "../dev-relay-drop-switch";

const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const HOOK = "__traycerDevDropRelay";

interface ServerLeg {
  readonly path: string;
  /** The close code the client sent, once it has closed this leg. */
  readonly clientClosed: Promise<{ code: number; reason: string }>;
  closeFromServer(code: number): void;
}

interface TestServer {
  readonly origin: string;
  readonly legs: ServerLeg[];
  stop(): Promise<void>;
}

/**
 * A minimal RFC 6455 server over `node:http`: handshake, then close frames
 * only. The desktop has no WebSocket server dependency, and the point of the
 * suite is the client side: a real native WHATWG WebSocket dialing a socket
 * that reports the close code it received.
 */
async function startServer(): Promise<TestServer> {
  const legs: ServerLeg[] = [];
  const sockets = new Set<Duplex>();
  const server: Server = createServer();
  server.on("upgrade", (req, socket) => {
    const key = req.headers["sec-websocket-key"];
    if (typeof key !== "string") {
      socket.destroy();
      return;
    }
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    let resolveClosed: (value: { code: number; reason: string }) => void;
    const clientClosed = new Promise<{ code: number; reason: string }>(
      (resolve) => {
        resolveClosed = resolve;
      },
    );
    let received = Buffer.alloc(0);
    let answered = false;
    socket.on("data", (chunk: Buffer) => {
      if (answered) return;
      received = Buffer.concat([received, chunk]);
      if (received.length < 2) return;
      if ((received[0] & 0x0f) !== 0x8) return;
      const length = received[1] & 0x7f;
      // Header, mask and payload can arrive across several TCP reads.
      if (received.length < 6 + length) return;
      answered = true;
      const mask = received.subarray(2, 6);
      const payload = Buffer.from(received.subarray(6, 6 + length));
      for (let i = 0; i < payload.length; i += 1) payload[i] ^= mask[i % 4];
      received = received.subarray(6 + length);
      resolveClosed({
        code: payload.length >= 2 ? payload.readUInt16BE(0) : 1005,
        reason: payload.subarray(2).toString("utf8"),
      });
      // A server-initiated close has already ended this socket; the client's
      // echo then needs no reply.
      if (!socket.writableEnded) {
        socket.end(
          Buffer.concat([Buffer.from([0x88, payload.length]), payload]),
        );
      }
    });
    legs.push({
      path: req.url ?? "",
      clientClosed,
      closeFromServer(code) {
        const frame = Buffer.alloc(4);
        frame[0] = 0x88;
        frame[1] = 2;
        frame.writeUInt16BE(code, 2);
        socket.end(frame);
      },
    });
    const accept = createHash("sha1")
      .update(key + WS_GUID)
      .digest("base64");
    socket.write(
      [
        "HTTP/1.1 101 Switching Protocols",
        "Upgrade: websocket",
        "Connection: Upgrade",
        `Sec-WebSocket-Accept: ${accept}`,
        "",
        "",
      ].join("\r\n"),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    origin: `ws://127.0.0.1:${port}`,
    legs,
    stop: () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      }),
  };
}

function opened(socket: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    socket.addEventListener("open", () => resolve(), { once: true });
    socket.addEventListener("error", () => reject(new Error("socket failed")), {
      once: true,
    });
  });
}

function closed(socket: WebSocket): Promise<CloseEvent> {
  return new Promise((resolve) => {
    socket.addEventListener("close", resolve, { once: true });
  });
}

async function dial(url: string): Promise<WebSocket> {
  const socket = new WebSocket(url);
  await opened(socket);
  return socket;
}

function dropRelay(): number {
  const hook: unknown = Reflect.get(globalThis, HOOK);
  if (typeof hook !== "function") throw new Error("drop hook is not installed");
  const count: unknown = Reflect.apply(hook, globalThis, []);
  if (typeof count !== "number") throw new Error("drop hook returned no count");
  return count;
}

function lastLeg(server: TestServer): ServerLeg {
  const leg = server.legs.at(-1);
  if (leg === undefined) throw new Error("server saw no leg");
  return leg;
}

describe("dev relay drop switch", () => {
  const NativeWebSocket = globalThis.WebSocket;
  let relay: TestServer;
  let pool: TestServer;
  let relayUrl: string;
  let cleanup: (() => void) | undefined;
  const dialed: WebSocket[] = [];

  async function track(url: string): Promise<WebSocket> {
    const socket = await dial(url);
    dialed.push(socket);
    return socket;
  }

  beforeEach(async () => {
    vi.stubGlobal("window", globalThis);
    relay = await startServer();
    pool = await startServer();
    relayUrl = `${relay.origin}/relay`;
    cleanup = installDevRelayDropSwitch(window, relayUrl);
  });

  afterEach(async () => {
    cleanup?.();
    cleanup = undefined;
    for (const socket of dialed.splice(0)) socket.close();
    await Promise.all([relay.stop(), pool.stop()]);
    vi.unstubAllGlobals();
    globalThis.WebSocket = NativeWebSocket;
    Reflect.deleteProperty(globalThis, HOOK);
  });

  it("parks the relay leg with 4007 relay-relink, never 1000", async () => {
    // The real factory always dials with a query; the install used the bare base.
    const socket = await track(
      `${relayUrl}?grant=test&park=1&resume=1:AAAAAAAAAAAAAAAAAAAAAA&prev=4007:relay-relink`,
    );
    const peerClosed = closed(socket);

    expect(dropRelay()).toBe(1);

    expect(await lastLeg(relay).clientClosed).toEqual({
      code: 4007,
      reason: "relay-relink",
    });
    expect((await peerClosed).code).toBe(4007);
  });

  it("leaves local and pool sockets open", async () => {
    const relaySocket = await track(relayUrl);
    const localSocket = await track(`${relay.origin}/local`);
    const poolSocket = await track(`${pool.origin}/relay`);
    const relayClosed = closed(relaySocket);

    expect(dropRelay()).toBe(1);
    await relayClosed;

    expect(localSocket.readyState).toBe(NativeWebSocket.OPEN);
    expect(poolSocket.readyState).toBe(NativeWebSocket.OPEN);
    const [, localLeg] = relay.legs;
    expect(localLeg.path).toBe("/local");
    expect(pool.legs).toHaveLength(1);
  });

  it("drops again after the session redials", async () => {
    const first = await track(relayUrl);
    const firstClosed = closed(first);
    expect(dropRelay()).toBe(1);
    await firstClosed;

    const second = await track(relayUrl);
    const secondClosed = closed(second);
    expect(dropRelay()).toBe(1);
    await secondClosed;

    expect(relay.legs).toHaveLength(2);
    expect(await relay.legs[1].clientClosed).toEqual({
      code: 4007,
      reason: "relay-relink",
    });
    expect(dropRelay()).toBe(0);
  });

  it("forgets a leg the relay closed on its own", async () => {
    const socket = await track(relayUrl);
    const peerClosed = closed(socket);
    lastLeg(relay).closeFromServer(1000);
    await peerClosed;

    expect(await lastLeg(relay).clientClosed).toEqual({
      code: 1000,
      reason: "",
    });
    expect(dropRelay()).toBe(0);
  });

  it("does not drop a leg that is still connecting", async () => {
    const socket = new WebSocket(relayUrl);
    dialed.push(socket);

    expect(socket.readyState).toBe(NativeWebSocket.CONNECTING);
    expect(dropRelay()).toBe(0);

    await opened(socket);
    expect(socket.readyState).toBe(NativeWebSocket.OPEN);
    expect(dropRelay()).toBe(1);
  });

  it("hands callers the native constructor surface", async () => {
    expect(globalThis.WebSocket).not.toBe(NativeWebSocket);
    expect(globalThis.WebSocket.prototype).toBe(NativeWebSocket.prototype);
    expect(globalThis.WebSocket.CONNECTING).toBe(0);
    expect(globalThis.WebSocket.OPEN).toBe(1);
    expect(globalThis.WebSocket.CLOSING).toBe(2);
    expect(globalThis.WebSocket.CLOSED).toBe(3);
    const socket = await track(`${pool.origin}/relay`);
    expect(socket).toBeInstanceOf(NativeWebSocket);
    expect(socket).toBeInstanceOf(globalThis.WebSocket);
  });

  it("restores the native constructor and removes the hook on cleanup", async () => {
    cleanup?.();
    cleanup = undefined;

    expect(globalThis.WebSocket).toBe(NativeWebSocket);
    expect(Reflect.has(globalThis, HOOK)).toBe(false);
  });

  it("leaves a constructor someone else installed in place on cleanup", () => {
    const replacement = globalThis.WebSocket;
    const outer = new Proxy(replacement, {});
    globalThis.WebSocket = outer;

    cleanup?.();
    cleanup = undefined;

    expect(globalThis.WebSocket).toBe(outer);
    expect(Reflect.has(globalThis, HOOK)).toBe(false);
  });
});

describe("dev relay drop entry gate", () => {
  const natives = globalThis.WebSocket;
  let server: TestServer;

  beforeEach(async () => {
    vi.resetModules();
    vi.stubGlobal("window", globalThis);
    server = await startServer();
    Object.defineProperty(globalThis, "runnerHost", {
      configurable: true,
      value: { relayBaseUrl: `${server.origin}/relay` },
    });
  });

  afterEach(async () => {
    await server.stop();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.doUnmock("../../config");
    globalThis.WebSocket = natives;
    Reflect.deleteProperty(globalThis, HOOK);
    Reflect.deleteProperty(globalThis, "runnerHost");
  });

  async function loadEntry(dev: boolean, isDevBuild: boolean): Promise<void> {
    vi.stubEnv("DEV", dev);
    vi.doMock("../../config", () => ({ isDevBuild }));
    await import("../dev-relay-drop");
  }

  it("installs the working hook in a dev build of the dev slot", async () => {
    await loadEntry(true, true);

    const socket = await dial(`${server.origin}/relay`);
    const peerClosed = closed(socket);
    expect(dropRelay()).toBe(1);
    expect(await lastLeg(server).clientClosed).toEqual({
      code: 4007,
      reason: "relay-relink",
    });
    await peerClosed;
  });

  it.each([
    { name: "a release bundle", dev: false, isDevBuild: true },
    {
      name: "a staging or production source run",
      dev: true,
      isDevBuild: false,
    },
  ])("installs nothing in $name", async ({ dev, isDevBuild }) => {
    await loadEntry(dev, isDevBuild);

    expect(Reflect.has(globalThis, HOOK)).toBe(false);
    expect(globalThis.WebSocket).toBe(natives);
  });
});

describe("dev relay drop in a release bundle", () => {
  const entry = fileURLToPath(new URL("../dev-relay-drop.ts", import.meta.url));

  // The config and protocol modules are stubbed so the bundle is only the
  // entry and the switch: what is under test is what the bundler keeps.
  const stubs: Plugin = {
    name: "stub-imports",
    setup(esbuild) {
      esbuild.onResolve({ filter: /(^|\/)config$/ }, () => ({
        path: "config",
        namespace: "stub",
      }));
      esbuild.onResolve({ filter: /relay-socket$/ }, () => ({
        path: "relay-socket",
        namespace: "stub",
      }));
      esbuild.onLoad({ filter: /^config$/, namespace: "stub" }, () => ({
        contents: "export const isDevBuild = true;",
      }));
      esbuild.onLoad({ filter: /^relay-socket$/, namespace: "stub" }, () => ({
        contents:
          'export const RELAY_RELINK_CLOSE_CODE = 4007; export const RELAY_RELINK_CLOSE_REASON = "relay-relink";',
      }));
    },
  };

  async function bundle(dev: boolean): Promise<string> {
    const result = await build({
      entryPoints: [entry],
      bundle: true,
      write: false,
      format: "esm",
      platform: "browser",
      logLevel: "silent",
      define: { "import.meta.env.DEV": String(dev) },
      plugins: [stubs],
    });
    return result.outputFiles.map((file) => file.text).join("\n");
  }

  it("keeps the hook in a dev bundle and drops it from a release bundle", async () => {
    expect(await bundle(true)).toContain(HOOK);
    expect(await bundle(false)).not.toContain(HOOK);
  });
});
