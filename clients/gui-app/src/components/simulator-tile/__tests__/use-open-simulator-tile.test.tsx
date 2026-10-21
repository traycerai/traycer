import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, renderHook } from "@testing-library/react";
import type { SimulatorSummary } from "@traycer/protocol/host/simulator/schemas";

/**
 * The open path every simulator surface takes hands over a tile ref at once:
 * nothing waits on `simulator.open`, whose boot can outlast the RPC frame
 * timeout. An unreachable host is refused with a toast and places nothing.
 */

const HOST = "host-1";

const fakes = vi.hoisted(() => ({
  reachability: "reachable",
  supported: true,
  toastError: vi.fn(),
}));

vi.mock("@/hooks/agent/use-host-reachability", () => ({
  useHostReachability: () => ({
    status: fakes.reachability,
    hostLabel: "Studio Mac",
  }),
}));
vi.mock("@/hooks/host/use-host-supports-method", () => ({
  useHostSupportsMethod: () => fakes.supported,
}));
vi.mock("sonner", () => ({
  toast: { error: fakes.toastError },
}));

import { useOpenSimulatorTile } from "@/components/simulator-tile/use-open-simulator-tile";
import {
  pendingSimulatorConnectRequest,
  resetSimulatorConnectRequestsForTests,
} from "@/lib/simulator-view/simulator-connect-requests";

const COLD: SimulatorSummary = {
  simulatorId: "udid-cold",
  platform: "ios",
  name: "iPhone 15",
  version: "17.5",
  booted: false,
  physical: false,
};

beforeEach(() => {
  fakes.reachability = "reachable";
  fakes.supported = true;
});

afterEach(() => {
  cleanup();
  resetSimulatorConnectRequestsForTests();
  vi.clearAllMocks();
});

describe("useOpenSimulatorTile", () => {
  it("places a cold simulator's tile synchronously, with the host's id and name", () => {
    const { result } = renderHook(() => useOpenSimulatorTile({ hostId: HOST }));
    const place = vi.fn();
    result.current.open(COLD, place);
    expect(place).toHaveBeenCalledTimes(1);
    expect(place.mock.calls[0][0]).toMatchObject({
      type: "simulator",
      hostId: HOST,
      simulatorId: "udid-cold",
      platform: "ios",
      name: "iPhone 15",
    });
    // The one-shot connect the tile's gate consumes, filed under the tile id.
    expect(
      pendingSimulatorConnectRequest(`simulator:${HOST}:udid-cold`),
    ).not.toBeNull();
    expect(result.current.supported).toBe(true);
  });

  it("refuses an unreachable host with a toast and places nothing", () => {
    fakes.reachability = "unreachable";
    const { result } = renderHook(() => useOpenSimulatorTile({ hostId: HOST }));
    const place = vi.fn();
    result.current.open(COLD, place);
    expect(place).not.toHaveBeenCalled();
    expect(pendingSimulatorConnectRequest(`simulator:${HOST}:udid-cold`)).toBe(
      null,
    );
    expect(fakes.toastError).toHaveBeenCalledWith(
      "Studio Mac is unreachable right now.",
    );
  });

  it("places nothing without a host", () => {
    const { result } = renderHook(() => useOpenSimulatorTile({ hostId: null }));
    const place = vi.fn();
    result.current.open(COLD, place);
    expect(place).not.toHaveBeenCalled();
  });
});
