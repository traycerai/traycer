import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Guards the CDP client inside `scripts/customize-overlay-browser.mjs`: a
 * dead socket, a silent Chrome or a throwing `send` must fail the run at once
 * instead of leaving a scenario awaiting a reply that will never come (which
 * hangs CI until its job timeout).
 *
 * The runner is a script that runs on import, so it cannot be imported. This
 * loads the REAL `connectCdp` source out of the file (from `function
 * connectCdp` up to `async function evaluate`) and evaluates it in a `vm`
 * context whose `WebSocket` and timers are fakes this test controls. The
 * source is not copied here; if the runner drops or renames either boundary
 * this test fails loudly rather than testing a stale copy.
 *
 * Limits: the fake socket only models `addEventListener` / `send` / `close`
 * and the four events the client listens to; a real Chrome's frame ordering is
 * not simulated. The log-collection branches (Runtime / Log events) are not
 * asserted here.
 */
const RUNNER = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "scripts",
  "customize-overlay-browser.mjs",
);
const REQUEST_TIMEOUT_MS = 15_000;

interface CdpClient {
  readonly logs: string[];
  send(method: string, params: unknown): Promise<unknown>;
  close(): void;
}

class FakeSocket {
  static last: FakeSocket | null = null;
  sendError: Error | null = null;
  readonly sent: string[] = [];
  closed = false;
  private readonly listeners = new Map<
    string,
    Array<(event: unknown) => void>
  >();
  constructor(readonly url: string) {
    FakeSocket.last = this;
  }
  addEventListener(type: string, listener: (event: unknown) => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }
  send(data: string): void {
    if (this.sendError !== null) throw this.sendError;
    this.sent.push(data);
  }
  close(): void {
    this.closed = true;
  }
  emit(type: string, event: unknown): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

function loadConnectCdp(): (url: string) => Promise<CdpClient> {
  const source = readFileSync(RUNNER, "utf8");
  const start = source.indexOf("function connectCdp");
  const end = source.indexOf("async function evaluate");
  if (start < 0 || end < start) {
    throw new Error(
      "customize-overlay-browser.mjs no longer has `function connectCdp` before `async function evaluate`",
    );
  }
  const context = vm.createContext({
    WebSocket: FakeSocket,
    // Read at call time so vitest's fake timers, installed per test, apply.
    setTimeout: (callback: () => void, ms: number) =>
      globalThis.setTimeout(callback, ms),
    clearTimeout: (id: number | NodeJS.Timeout | undefined) => {
      globalThis.clearTimeout(id);
    },
    // Host builtins, so errors and promises share this realm's identity.
    Error,
    Promise,
    Map,
    JSON,
    String,
  });
  const connect: unknown = vm.runInContext(
    `${source.slice(start, end)}\nconnectCdp`,
    context,
  );
  if (typeof connect !== "function") throw new Error("connectCdp not loaded");
  return async (url) => {
    const client: unknown = await Reflect.apply(connect, undefined, [url]);
    if (!isClient(client)) throw new Error("Invalid CDP client");
    return client;
  };
}

function isClient(value: unknown): value is CdpClient {
  return (
    typeof value === "object" &&
    value !== null &&
    "send" in value &&
    typeof value.send === "function" &&
    "close" in value &&
    typeof value.close === "function" &&
    "logs" in value &&
    Array.isArray(value.logs) &&
    value.logs.every((line) => typeof line === "string")
  );
}

async function openClient(): Promise<{
  client: CdpClient;
  socket: FakeSocket;
}> {
  const pending = loadConnectCdp()("ws://chrome.invalid/devtools");
  const socket = FakeSocket.last;
  if (socket === null) throw new Error("connectCdp did not open a WebSocket");
  socket.emit("open", {});
  return { client: await pending, socket };
}

beforeEach(() => {
  FakeSocket.last = null;
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("customize browser driver CDP client", () => {
  it.each(["close", "error"])(
    "rejects an in-flight request when the socket emits %s",
    async (event) => {
      const { client, socket } = await openClient();
      const request = expect(
        client.send("Runtime.evaluate", {}),
      ).rejects.toThrow(
        event === "close" ? "CDP socket closed" : "CDP socket failed",
      );
      socket.emit(event, {});
      await request;
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it("rejects connect, and closes the socket, when it never opens", async () => {
    const pending = loadConnectCdp()("ws://chrome.invalid/devtools");
    const rejection = expect(pending).rejects.toThrow("CDP connect timed out");
    await vi.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS);
    await rejection;
    expect(FakeSocket.last?.closed).toBe(true);
  });

  it("rejects connect when the socket errors before it opens", async () => {
    const pending = loadConnectCdp()("ws://chrome.invalid/devtools");
    const rejection = expect(pending).rejects.toThrow("CDP socket failed");
    FakeSocket.last?.emit("error", {});
    await rejection;
    expect(vi.getTimerCount()).toBe(0);
  });

  it("times a silent request out, then ignores its late reply", async () => {
    const { client, socket } = await openClient();
    const request = expect(client.send("Page.navigate", {})).rejects.toThrow(
      "Timed out sending CDP command Page.navigate",
    );
    await vi.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS);
    await request;
    const id = 1;
    expect(JSON.parse(socket.sent[0])).toMatchObject({ id });
    expect(() =>
      socket.emit("message", { data: JSON.stringify({ id, result: {} }) }),
    ).not.toThrow();
  });

  it("clears the request timer when send throws synchronously", async () => {
    const { client, socket } = await openClient();
    socket.sendError = new Error("socket is not open");
    await expect(client.send("Runtime.enable", {})).rejects.toThrow(
      "socket is not open",
    );
    expect(vi.getTimerCount()).toBe(0);
  });

  it("resolves a reply and clears its timer", async () => {
    const { client, socket } = await openClient();
    const request = client.send("Runtime.evaluate", {});
    expect(vi.getTimerCount()).toBe(1);
    const id = 1;
    expect(JSON.parse(socket.sent[0])).toMatchObject({ id });
    socket.emit("message", {
      data: JSON.stringify({ id, result: { value: 1 } }),
    });
    await expect(request).resolves.toEqual({ value: 1 });
    expect(vi.getTimerCount()).toBe(0);
  });
});
