import { afterEach, describe, expect, it, vi } from "vitest";

// `findLiveIncumbentHost` decides whether the supervisor defers to a host
// that is already serving this data dir. Both directions are load-bearing
// and they are NOT symmetric:
//
//   - a false "present" makes the supervisor decline and leaves the machine
//     with NO host, which is far worse than
//   - a false "absent", which merely stacks a duplicate.
//
// So endpoint reachability is the positive signal and process identity only
// ever REMOVES an incumbent that is positively proven to be an impostor.

const mocks = vi.hoisted(() => ({
  readHostPidMetadataMock: vi.fn(),
  identityVerdictMock: vi.fn(),
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

vi.mock("../../store/process-identity", () => ({
  getPublishedProcessIdentityVerdict: mocks.identityVerdictMock,
}));

import { findLiveIncumbentHost } from "../incumbent-check";

const VALID_META = {
  pid: 4242,
  hostId: "d1",
  version: "1.1.8",
  websocketUrl: "ws://127.0.0.1:58036/rpc",
  startedAt: "2026-01-01T00:00:00.000Z",
};

// `probeHostReachable` is a plain loopback GET, so driving global fetch keeps
// the real probe logic under test instead of stubbing the module out.
function stubReachable(reachable: boolean): void {
  vi.spyOn(globalThis, "fetch").mockImplementation(() =>
    reachable
      ? Promise.resolve(new Response("{}", { status: 200 }))
      : Promise.reject(new Error("ECONNREFUSED")),
  );
}

afterEach(() => {
  vi.restoreAllMocks();
  mocks.readHostPidMetadataMock.mockReset();
  mocks.identityVerdictMock.mockReset();
});

describe("findLiveIncumbentHost", () => {
  it("returns null when there is no pid.json", async () => {
    mocks.readHostPidMetadataMock.mockResolvedValue(null);
    await expect(findLiveIncumbentHost("production")).resolves.toBeNull();
  });

  it("returns null for a non-loopback websocket url", async () => {
    mocks.readHostPidMetadataMock.mockResolvedValue({
      ...VALID_META,
      websocketUrl: "ws://10.0.0.5:58036/rpc",
    });
    await expect(findLiveIncumbentHost("production")).resolves.toBeNull();
  });

  it("returns null when nothing answers the recorded endpoint", async () => {
    mocks.readHostPidMetadataMock.mockResolvedValue(VALID_META);
    stubReachable(false);

    await expect(findLiveIncumbentHost("production")).resolves.toBeNull();
    // Reachability is the positive signal; a dead endpoint short-circuits
    // before the identity probe is worth paying for.
    expect(mocks.identityVerdictMock).not.toHaveBeenCalled();
  });

  it("reports the incumbent when the endpoint answers and identity is current", async () => {
    mocks.readHostPidMetadataMock.mockResolvedValue(VALID_META);
    mocks.identityVerdictMock.mockResolvedValue("current");
    stubReachable(true);

    await expect(findLiveIncumbentHost("production")).resolves.toEqual({
      pid: 4242,
      version: "1.1.8",
      websocketUrl: "ws://127.0.0.1:58036/rpc",
    });
    expect(mocks.identityVerdictMock).toHaveBeenCalledWith(
      4242,
      "2026-01-01T00:00:00.000Z",
    );
  });

  // The bias that matters. `isProcessAlive` would have reported `true` here
  // too, but for the wrong reason - it collapses "indeterminate" into alive.
  // The point is that an UNREADABLE os probe must not be read as evidence
  // that a healthy, answering endpoint is down.
  it("keeps the incumbent when process identity is indeterminate", async () => {
    mocks.readHostPidMetadataMock.mockResolvedValue(VALID_META);
    mocks.identityVerdictMock.mockResolvedValue("indeterminate");
    stubReachable(true);

    await expect(findLiveIncumbentHost("production")).resolves.not.toBeNull();
  });

  // The case bare `isProcessAlive` could not see: the pid outlived its host
  // and was recycled onto an unrelated process, so whatever answered that
  // port is not this record's host.
  it("returns null when the recorded pid was recycled onto another process", async () => {
    mocks.readHostPidMetadataMock.mockResolvedValue(VALID_META);
    mocks.identityVerdictMock.mockResolvedValue("mismatch");
    stubReachable(true);

    await expect(findLiveIncumbentHost("production")).resolves.toBeNull();
  });

  it("returns null when the recorded process is gone", async () => {
    mocks.readHostPidMetadataMock.mockResolvedValue(VALID_META);
    mocks.identityVerdictMock.mockResolvedValue("dead");
    stubReachable(true);

    await expect(findLiveIncumbentHost("production")).resolves.toBeNull();
  });

  it("never treats our own supervisor pid as the incumbent", async () => {
    mocks.readHostPidMetadataMock.mockResolvedValue({
      ...VALID_META,
      pid: process.pid,
    });
    stubReachable(true);

    await expect(findLiveIncumbentHost("production")).resolves.toBeNull();
  });
});
