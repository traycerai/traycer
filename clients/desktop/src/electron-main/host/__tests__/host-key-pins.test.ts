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
}));

vi.mock("electron", () => ({
  app: { getPath: (): string => "/tmp/traycer-host-key-pin-test" },
}));

vi.mock("../../app/logger", () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("../../app/json-file-store", () => ({
  createJsonFileStore: () => ({
    load: () => Promise.resolve(storeState.payload),
    save: (payload: { pins: Record<string, string> }) => {
      storeState.payload = { pins: { ...payload.pins } };
      return Promise.resolve();
    },
  }),
}));

function item(publicKey: string): HostListItem {
  return {
    hostId: "host-1",
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
});
