import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// `assertHostNotBusy` is the CLI's fail-safe gate before it reinstalls a
// running host. It must (a) return when there is no LIVE host to protect
// (no pid.json, or a stale pid.json whose process has exited), and (b) treat
// every non-`busy:false` outcome from a live host as busy (D3) so in-progress
// work is never torn down on an indeterminate answer.

const mocks = vi.hoisted(() => ({
  readHostPidMetadataMock: vi.fn(),
  isProcessAliveMock: vi.fn(),
}));

vi.mock("../pid-metadata", async () => {
  // Keep `isValidLocalHostWebsocketUrl` real; only the pid.json read is stubbed.
  const actual =
    await vi.importActual<typeof import("../pid-metadata")>("../pid-metadata");
  return {
    ...actual,
    readHostPidMetadata: mocks.readHostPidMetadataMock,
  };
});

vi.mock("../../store/cli-lock", () => ({
  isProcessAlive: mocks.isProcessAliveMock,
}));

import { assertHostNotBusy } from "../busy-check";
import { CLI_ERROR_CODES } from "../../runner/errors";

const VALID_META = {
  pid: 4242,
  hostId: "d1",
  version: "1.0.0",
  websocketUrl: "ws://127.0.0.1:54321/rpc",
  startedAt: "2026-01-01T00:00:00.000Z",
};

function stubFetch(impl: () => Promise<Response>) {
  return vi.spyOn(globalThis, "fetch").mockImplementation(impl);
}

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("assertHostNotBusy", () => {
  beforeEach(() => {
    // Default: a live host process. The no-live-host cases override this.
    mocks.isProcessAliveMock.mockReturnValue(true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetAllMocks();
  });

  it("resolves when a live host reports busy:false", async () => {
    mocks.readHostPidMetadataMock.mockResolvedValue(VALID_META);
    stubFetch(async () => jsonResponse({ busy: false }, 200));
    await expect(assertHostNotBusy("production")).resolves.toBeUndefined();
  });

  it("throws E_HOST_BUSY when a live host reports busy:true", async () => {
    mocks.readHostPidMetadataMock.mockResolvedValue(VALID_META);
    stubFetch(async () => jsonResponse({ busy: true }, 200));
    await expect(assertHostNotBusy("production")).rejects.toMatchObject({
      code: CLI_ERROR_CODES.HOST_BUSY,
    });
  });

  it("treats a 404 from a pre-/activity (but live) host as busy", async () => {
    mocks.readHostPidMetadataMock.mockResolvedValue(VALID_META);
    stubFetch(async () => new Response("Not Found", { status: 404 }));
    await expect(assertHostNotBusy("production")).rejects.toMatchObject({
      code: CLI_ERROR_CODES.HOST_BUSY,
    });
  });

  it("treats a malformed body from a live host as busy", async () => {
    mocks.readHostPidMetadataMock.mockResolvedValue(VALID_META);
    stubFetch(async () => jsonResponse({ nope: 1 }, 200));
    await expect(assertHostNotBusy("production")).rejects.toMatchObject({
      code: CLI_ERROR_CODES.HOST_BUSY,
    });
  });

  it("treats a connect/abort error against a live host as busy", async () => {
    mocks.readHostPidMetadataMock.mockResolvedValue(VALID_META);
    stubFetch(async () => {
      throw new Error("ECONNREFUSED");
    });
    await expect(assertHostNotBusy("production")).rejects.toMatchObject({
      code: CLI_ERROR_CODES.HOST_BUSY,
    });
  });

  it("resolves (no live host) when pid.json is missing - no probe attempted", async () => {
    mocks.readHostPidMetadataMock.mockResolvedValue(null);
    const fetchSpy = stubFetch(async () => jsonResponse({ busy: true }, 200));
    await expect(assertHostNotBusy("production")).resolves.toBeUndefined();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("resolves (no live host) for a stale pid.json whose process has exited", async () => {
    mocks.readHostPidMetadataMock.mockResolvedValue(VALID_META);
    mocks.isProcessAliveMock.mockReturnValue(false);
    const fetchSpy = stubFetch(async () => jsonResponse({ busy: true }, 200));
    await expect(assertHostNotBusy("production")).resolves.toBeUndefined();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
