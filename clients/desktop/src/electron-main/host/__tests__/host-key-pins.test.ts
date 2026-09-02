import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HostListItem } from "@traycer/protocol/host/host-status";
import type { HostKeyPinMismatch } from "../../../ipc-contracts/platform-types";
import {
  applyHostKeyPins,
  clearHostKeyPinStore,
} from "@traycer-clients/shared/host-client/host-key-pin";
import {
  installDesktopHostKeyPins,
  setHostKeyPinMismatchEmitter,
} from "../host-key-pins";

const storeState = vi.hoisted(() => ({
  payload: { pins: {} as Record<string, string> },
  /**
   * R3-9: lets a test hold `load()` open so two concurrent first-sight pins
   * can both be driven before either underlying load settles.
   */
  loadGate: null as Promise<void> | null,
}));

vi.mock("electron", () => ({
  app: { getPath: (): string => "/tmp/traycer-host-key-pin-test" },
}));

vi.mock("../../app/logger", () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("../../app/json-file-store", () => ({
  createJsonFileStore: () => ({
    load: () =>
      (storeState.loadGate ?? Promise.resolve()).then(() => storeState.payload),
    save: (payload: { pins: Record<string, string> }) => {
      storeState.payload = { pins: { ...payload.pins } };
      return Promise.resolve();
    },
  }),
}));

function item(publicKey: string): HostListItem {
  return itemForHost("host-1", publicKey);
}

function itemForHost(hostId: string, publicKey: string): HostListItem {
  return {
    hostId,
    displayName: null,
    platform: "Ubuntu",
    kind: "personal",
    publicKey,
    createdAt: "2026-07-01T12:00:00.000Z",
    status: {
      connectivity: "connectable",
      viewerReachability: "unknown",
      clientCloud: "ok",
      updateState: "current",
      appVersion: "1.4.2",
      lastSeenAt: "2026-07-03T11:59:50.000Z",
    },
    updatePolicy: "manual",
  };
}

beforeEach(() => {
  storeState.payload = { pins: {} };
  storeState.loadGate = null;
  installDesktopHostKeyPins();
});

afterEach(() => {
  clearHostKeyPinStore();
  setHostKeyPinMismatchEmitter(() => undefined);
});

describe("desktop host key pins", () => {
  it("persists the first key it sees", async () => {
    await applyHostKeyPins([item("pk-1")]);
    expect(storeState.payload.pins).toEqual({ "host-1": "pk-1" });
  });

  it("fans a changed key out to the renderer surface, not just the log", async () => {
    const surfaced: HostKeyPinMismatch[] = [];
    setHostKeyPinMismatchEmitter((entry) => surfaced.push(entry));

    await applyHostKeyPins([item("pk-1")]);
    const admitted = await applyHostKeyPins([item("pk-IMPOSTER")]);

    expect(admitted).toEqual([]);
    expect(surfaced).toHaveLength(1);
    const entry = surfaced[0];
    if (entry === undefined) throw new Error("expected one mismatch");
    expect(entry.hostId).toBe("host-1");
    expect(entry.pinnedKey).toBe("pk-1");
    expect(entry.offeredKey).toBe("pk-IMPOSTER");
    // The one honest recovery there is, carried to whoever renders it.
    expect(entry.pinLocation).toContain("host-key-pins.json");
    expect(entry.remedy).toContain(entry.pinLocation);
    // Structured-clone-safe: the typed error never crosses the boundary.
    expect(JSON.parse(JSON.stringify(entry))).toEqual(entry);
    // And the pin is untouched.
    expect(storeState.payload.pins).toEqual({ "host-1": "pk-1" });
  });

  it("R3-9: two hosts' first-sight pins started before either load settles both survive", async () => {
    // RULE: the load is memoised on the PROMISE, not on its settled result -
    // two first-sight pins racing the same cold load must not let the second
    // write clobber the first. Before the fix, both saw an empty map and the
    // second save dropped the first pin.
    let releaseLoad: () => void = () => undefined;
    storeState.loadGate = new Promise<void>((resolve) => {
      releaseLoad = resolve;
    });

    const first = applyHostKeyPins([itemForHost("host-1", "pk-1")]);
    const second = applyHostKeyPins([itemForHost("host-2", "pk-2")]);
    // Both are in flight, blocked on the same unsettled load, before either
    // is allowed to proceed.
    releaseLoad();
    await Promise.all([first, second]);

    expect(storeState.payload.pins).toEqual({
      "host-1": "pk-1",
      "host-2": "pk-2",
    });
  });
});
