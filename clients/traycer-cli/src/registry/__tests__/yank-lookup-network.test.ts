import { afterEach, describe, expect, it, vi } from "vitest";
import { createServer } from "node:http";
import type { Socket } from "node:net";
import { createRegistryYankLookup } from "../client";

interface BlackholeServer {
  readonly url: string;
  readonly requestReceived: Promise<void>;
  close(): Promise<void>;
}

async function startBlackholeServer(): Promise<BlackholeServer> {
  const sockets = new Set<Socket>();
  let signalRequest: (() => void) | null = null;
  const requestReceived = new Promise<void>((resolve) => {
    signalRequest = resolve;
  });
  const server = createServer((_request, _response) => {
    signalRequest?.();
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });

  return new Promise<BlackholeServer>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        reject(new Error("blackhole server did not bind to a TCP port"));
        return;
      }
      resolve({
        url: `http://127.0.0.1:${address.port}/versions.json`,
        requestReceived,
        close: () =>
          new Promise<void>((closeResolve, closeReject) => {
            sockets.forEach((socket) => socket.destroy());
            server.close((err) => {
              if (err !== undefined) {
                closeReject(err);
                return;
              }
              closeResolve();
            });
          }),
      });
    });
  });
}

afterEach(() => {
  vi.useRealTimers();
});

describe("createRegistryYankLookup real fetch watchdog", () => {
  it("aborts a real blackholed fetch and fails open", async () => {
    const blackhole = await startBlackholeServer();
    const lookup = createRegistryYankLookup("production");
    const realFetch = globalThis.fetch;
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation((input, init) =>
        realFetch(blackhole.url, { ...init, method: "GET" }),
      );
    const realSetTimeout = setTimeout;

    try {
      vi.useFakeTimers();
      const result = lookup.isVersionYanked("2.0.0");
      await blackhole.requestReceived;

      await vi.advanceTimersByTimeAsync(10_000);

      await expect(
        Promise.race([
          result.then(() => true),
          new Promise<boolean>((resolve) => {
            realSetTimeout(() => resolve(false), 25);
          }),
        ]),
      ).resolves.toBe(true);
      await expect(result).resolves.toBe(false);
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      expect(fetchSpy).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      );
    } finally {
      fetchSpy.mockRestore();
      vi.useRealTimers();
      await blackhole.close();
    }
  });
});
