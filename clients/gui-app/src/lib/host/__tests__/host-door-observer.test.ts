import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  appHostDoorObserver,
  noteHostTokenRefusal,
} from "@/lib/host/host-door-observer";
import {
  clearHostDoorState,
  hostDoorStateFor,
} from "@/stores/host/host-door-state-store";

const ADMITTED_AT_MS = 2_000;

describe("a failed host-token mint against the door's last admission", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("raises no state when the mint started before the host admitted a connection", () => {
    const hostId = "door-observer-mint-before-admission";
    clearHostDoorState(hostId);
    vi.setSystemTime(ADMITTED_AT_MS);
    appHostDoorObserver(hostId).admitted();
    noteHostTokenRefusal(hostId, "token-unavailable", ADMITTED_AT_MS - 1_000);
    expect(hostDoorStateFor(hostId)).toBeNull();
  });

  it("raises the state when the mint started after the host's last admission", () => {
    const hostId = "door-observer-mint-after-admission";
    clearHostDoorState(hostId);
    vi.setSystemTime(ADMITTED_AT_MS);
    appHostDoorObserver(hostId).admitted();
    noteHostTokenRefusal(hostId, "token-unavailable", ADMITTED_AT_MS + 1_000);
    expect(hostDoorStateFor(hostId)?.kind).toBe("token-unavailable");
    clearHostDoorState(hostId);
  });
});
