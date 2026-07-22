import { afterEach, describe, expect, it, vi } from "vitest";
import { createServer, type Server } from "node:net";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

vi.mock("electron", () => ({
  app: { isPackaged: false, getAppPath: (): string => "/fake/app/path" },
}));

vi.mock("electron-log", () => ({
  default: {
    transports: { file: { level: "info" }, console: { level: "info" } },
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

import { waitForHostReady } from "../host-readiness";
import { __setAsyncProcessLivenessReaderForTest } from "../process-identity";

async function listenForWebsocket(): Promise<{ server: Server; port: number }> {
  const server = createServer((socket) => {
    socket.once("data", () => {
      socket.write(
        [
          "HTTP/1.1 101 Switching Protocols",
          "Upgrade: websocket",
          "Connection: Upgrade",
          "Sec-WebSocket-Accept: test",
          "",
          "",
        ].join("\r\n"),
      );
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("websocket listener has no port");
  }
  return { server, port: address.port };
}

afterEach(() => {
  __setAsyncProcessLivenessReaderForTest(null);
});

describe("waitForHostReady", () => {
  it("F1: rejects a handshake-reachable endpoint when pid metadata proves the publisher is dead", async () => {
    const dir = await mkdtemp(join(tmpdir(), "host-readiness-"));
    const pidPath = join(dir, "pid.json");
    const { server, port } = await listenForWebsocket();
    __setAsyncProcessLivenessReaderForTest(async () => "dead");
    try {
      await writeFile(
        pidPath,
        JSON.stringify({
          version: "1.0.0",
          pid: 999_999,
          websocketUrl: `ws://127.0.0.1:${port}/rpc`,
          startedAt: new Date().toISOString(),
        }),
        "utf8",
      );

      await expect(waitForHostReady(75, pidPath, 5, null)).resolves.toEqual({
        ready: false,
        version: null,
        pid: null,
        startedAt: null,
        reason: expect.stringContaining("published host process"),
      });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(dir, { recursive: true, force: true });
    }
  });
});
